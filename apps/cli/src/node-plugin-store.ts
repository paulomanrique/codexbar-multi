import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

import { Effect } from "effect";
import {
  approvalMatches,
  createApprovalBinding,
  makeApprovedPluginSandboxCapabilities,
  PluginBrokerHost,
  PluginBrokerProtocolServer,
  PluginRuntimeError,
  PluginRuntimeLimits,
  typedConfirmationOrigins,
  type LoadedPlugin,
  type PluginApprovalBinding,
  type PluginManifest,
  type PluginSandboxCapabilities,
  type PluginSandboxExecutionContext,
} from "@codexbar/plugin-runtime";
import {
  makeNodePrivateDirectoryRestriction,
  makeNodePrivateFileStore,
} from "@codexbar/platform/node";
import { mapProviderSnapshot } from "@codexbar/providers";

import type {
  CLIPluginApprovalPreview,
  CLIInstalledPlugin,
  CLIInvalidPluginFile,
  CLIPluginFetchResult,
  CLIPluginStore,
} from "./plugins.ts";
import { makeNodePluginSandbox } from "./node-plugin-sandbox.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const pluginIdPattern = /^[a-z0-9-]{1,64}$/;
const pluginFilePattern = /^([a-z0-9-]{1,64})\.(js|ts)$/;
const maximumApprovals = 64;

type PluginLanguage = "javascript" | "typescript";

interface ApprovalRecord {
  readonly binding: PluginApprovalBinding;
  readonly settings: Readonly<Record<string, string>>;
}

interface DiscoveredPlugin {
  readonly fileName: string;
  readonly language: PluginLanguage;
  readonly loaded: LoadedPlugin;
}

type PluginSandbox = {
  readonly inspect: (
    source: string,
    options: { readonly language: PluginLanguage; readonly allowsDynamicId: true },
  ) => Promise<LoadedPlugin>;
  readonly execute: (
    plugin: Pick<LoadedPlugin, "transpiledSource" | "manifest">,
    broker: PluginBrokerProtocolServer,
    context?: PluginSandboxExecutionContext,
    capabilities?: PluginSandboxCapabilities,
  ) => Promise<Record<string, unknown>>;
  readonly terminate?: () => void;
};

export interface NodeCLIPluginStoreOptions {
  /** Private, host-owned base directory. The manager creates only `plugins/` and its approval file. */
  readonly storageRoot: string;
  readonly reservedIds: ReadonlySet<string>;
  /** Keyring adapter. It is injected so CLI tests never touch real credentials. */
  readonly readSecret?: (pluginId: string, key: string) => Promise<string | undefined>;
  readonly writeSecret?: (pluginId: string, key: string, value: string) => Promise<void>;
  readonly removeSecret?: (pluginId: string, key: string) => Promise<void>;
  /** A CLI has no raw browser profile access. Supplying this is only valid for pre-exported host credentials. */
  readonly readBrowserCookie?: (pluginId: string, domain: string) => Promise<string | undefined>;
  readonly removeBrowserCookie?: (pluginId: string, domain: string) => Promise<void>;
  readonly sandbox?: PluginSandbox;
  /** Testable host boundary; production removes only the generated private source path. */
  readonly removeSource?: (path: string) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly timeZone?: () => string;
}

export interface CLIPluginLifecycleStore extends CLIPluginStore {
  readonly install: (sourcePath: string) => Promise<CLIInstalledPlugin>;
  readonly previewApproval: (
    pluginId: string,
    settings: Readonly<Record<string, string>>,
  ) => Promise<CLIPluginApprovalPreview>;
  readonly approve: (
    pluginId: string,
    settings: Readonly<Record<string, string>>,
    typedConfirmations: Readonly<Record<string, string>>,
  ) => Promise<CLIPluginApprovalPreview>;
  readonly test: (pluginId: string) => Promise<CLIPluginFetchResult>;
  readonly remove: (pluginId: string) => Promise<void>;
  readonly setSecret: (pluginId: string, key: string, value: string) => Promise<void>;
  readonly removeSecret: (pluginId: string, key: string) => Promise<void>;
}

const languageFor = (fileName: string): PluginLanguage | undefined => {
  const match = pluginFilePattern.exec(fileName);
  if (match === null) return undefined;
  return match[2] === "ts" ? "typescript" : "javascript";
};

const safeDiagnostic = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : "plugin validation failed";
  return [...message]
    .map((value) => {
      const code = value.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : value;
    })
    .join("")
    .slice(0, 512);
};

const assertPluginId = (id: string): void => {
  if (!pluginIdPattern.test(id)) throw new PluginRuntimeError("load", "plugin id is invalid");
};

const assertApprovalSettings = (
  manifest: PluginManifest,
  settings: Readonly<Record<string, string>>,
): void => {
  const permitted = new Set(
    manifest.settings.filter((setting) => setting.type === "plain").map((setting) => setting.key),
  );
  let bytes = 0;
  for (const [key, value] of Object.entries(settings)) {
    if (!permitted.has(key) || typeof value !== "string")
      throw new PluginRuntimeError(
        "invalid-manifest",
        "plugin approval settings are not declared plain settings",
      );
    bytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
    if (bytes > 64 * 1024)
      throw new PluginRuntimeError("invalid-manifest", "plugin approval settings exceed 64 KiB");
  }
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const parseBinding = (value: unknown): PluginApprovalBinding | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.instanceId !== "string" ||
    typeof source.authMode !== "string" ||
    !isStringArray(source.origins) ||
    !isStringArray(source.secretNames) ||
    !isStringArray(source.capabilities) ||
    !isStringArray(source.cookieDomains)
  )
    return undefined;
  for (const key of ["authHeader", "authSecret", "authScheme"] as const) {
    if (source[key] !== undefined && typeof source[key] !== "string") return undefined;
  }
  return {
    instanceId: source.instanceId,
    origins: source.origins,
    authMode: source.authMode,
    ...(typeof source.authHeader === "string" ? { authHeader: source.authHeader } : {}),
    ...(typeof source.authSecret === "string" ? { authSecret: source.authSecret } : {}),
    ...(typeof source.authScheme === "string" ? { authScheme: source.authScheme } : {}),
    secretNames: source.secretNames,
    capabilities: source.capabilities,
    cookieDomains: source.cookieDomains,
  };
};

const parseApprovals = (value: unknown): Record<string, ApprovalRecord> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const approvals = (value as { approvals?: unknown }).approvals;
  if (typeof approvals !== "object" || approvals === null || Array.isArray(approvals)) return {};
  const result: Record<string, ApprovalRecord> = {};
  for (const [id, raw] of Object.entries(approvals)) {
    if (!pluginIdPattern.test(id) || typeof raw !== "object" || raw === null) continue;
    const entry = raw as { binding?: unknown; settings?: unknown };
    const binding = parseBinding(entry.binding);
    if (binding === undefined || binding.instanceId !== id) continue;
    if (
      typeof entry.settings !== "object" ||
      entry.settings === null ||
      Array.isArray(entry.settings) ||
      !Object.values(entry.settings).every((item) => typeof item === "string")
    )
      continue;
    result[id] = { binding, settings: entry.settings as Record<string, string> };
  }
  return result;
};

const readBoundedRegularFile = async (path: string, maximumBytes: number): Promise<Uint8Array> => {
  await assertNoSymlinkAncestors(path);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new PluginRuntimeError("load", "plugin file is not a bounded regular file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 0 || metadata.size > maximumBytes)
      throw new PluginRuntimeError("load", "plugin file is not a bounded regular file");
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes)
      throw new PluginRuntimeError("load", "plugin file exceeds the 1 MiB source limit");
    return bytes;
  } finally {
    await handle.close();
  }
};

/**
 * `O_NOFOLLOW` is unavailable on some Windows Node builds. Reject every
 * existing component before opening a private file, not only the final name.
 * The private DACL boundary then makes a post-check swap unavailable to other
 * local accounts; a caller-controlled symlink chain is never accepted.
 */
const assertNoSymlinkAncestors = async (path: string): Promise<void> => {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]/u).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink())
        throw new PluginRuntimeError("load", "plugin storage may not contain symbolic links");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        if (cause instanceof PluginRuntimeError) throw cause;
        throw new PluginRuntimeError("load", "plugin storage path could not be inspected safely");
      }
    }
  }
};

const summary = (discovered: DiscoveredPlugin, approved: boolean): CLIInstalledPlugin => ({
  id: discovered.loaded.manifest.id,
  name: discovered.loaded.manifest.name,
  language: discovered.language,
  capabilities: discovered.loaded.manifest.capabilities,
  cookieDomains: discovered.loaded.manifest.cookieDomains,
  approvalStatus: approved ? "approved" : "needs-approval",
});

const preview = (
  manifest: PluginManifest,
  binding: PluginApprovalBinding,
): CLIPluginApprovalPreview => ({
  pluginId: manifest.id,
  origins: binding.origins,
  authMode: binding.authMode,
  secretNames: binding.secretNames,
  capabilities: binding.capabilities,
  cookieDomains: binding.cookieDomains,
  typedConfirmationOrigins: typedConfirmationOrigins(binding),
});

/**
 * Host-owned CLI plugin lifecycle. All untrusted code runs in a disposable
 * QuickJS child; this class owns source, approval and keyring boundaries.
 */
export class NodeCLIPluginStore implements CLIPluginLifecycleStore {
  readonly supportsExportedBrowserCookies = true;
  private readonly pluginsRoot: string;
  private readonly approvalsPath: string;
  private readonly sandbox: PluginSandbox;
  private readonly files = makeNodePrivateFileStore();
  private readonly restrictDirectory = makeNodePrivateDirectoryRestriction();
  private readonly reservedIds: ReadonlySet<string>;
  private readonly readSecretValue: (pluginId: string, key: string) => Promise<string | undefined>;
  private readonly writeSecretValue: (
    pluginId: string,
    key: string,
    value: string,
  ) => Promise<void>;
  private readonly removeSecretValue: (pluginId: string, key: string) => Promise<void>;
  private readonly readBrowserCookie: (
    pluginId: string,
    domain: string,
  ) => Promise<string | undefined>;
  private readonly removeSource: (path: string) => Promise<void>;
  private readonly removeBrowserCookie: (pluginId: string, domain: string) => Promise<void>;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly timeZone: () => string;
  private mutation = Promise.resolve();

  constructor(options: NodeCLIPluginStoreOptions) {
    this.pluginsRoot = join(options.storageRoot, "plugins");
    this.approvalsPath = join(options.storageRoot, "plugin-approvals.json");
    this.sandbox = options.sandbox ?? makeNodePluginSandbox();
    this.reservedIds = options.reservedIds;
    this.readSecretValue = options.readSecret ?? (async () => undefined);
    this.writeSecretValue =
      options.writeSecret ??
      (async () => {
        throw new PluginRuntimeError("secret-access", "native credential storage is unavailable");
      });
    this.removeSecretValue = options.removeSecret ?? (async () => undefined);
    // Browser profile extraction never happens in the CLI. The default is a
    // hard failure even when a plugin declares a cookie domain.
    this.readBrowserCookie =
      options.readBrowserCookie ??
      (async () => {
        throw new PluginRuntimeError(
          "secret-access",
          "browser session credentials have not been exported by the desktop host",
        );
      });
    this.removeSource =
      options.removeSource ?? ((path) => Effect.runPromise(this.files.remove(path)));
    this.removeBrowserCookie = options.removeBrowserCookie ?? (async () => undefined);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  async list(): Promise<{
    readonly plugins: readonly CLIInstalledPlugin[];
    readonly invalidFiles: readonly CLIInvalidPluginFile[];
  }> {
    await this.ensurePluginsRoot();
    const approvals = await this.loadApprovals();
    const entries = await readdir(this.pluginsRoot, { withFileTypes: true });
    const plugins: CLIInstalledPlugin[] = [];
    const invalidFiles: CLIInvalidPluginFile[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const language = languageFor(entry.name);
      if (language === undefined || !entry.isFile() || entry.isSymbolicLink()) continue;
      try {
        const discovered = await this.load(entry.name, language);
        const approval = approvals[discovered.loaded.manifest.id];
        const approved =
          approval !== undefined &&
          approvalMatches(
            createApprovalBinding(discovered.loaded.manifest, approval.settings),
            approval.binding,
          );
        plugins.push(summary(discovered, approved));
      } catch (cause) {
        invalidFiles.push({ fileName: basename(entry.name), error: safeDiagnostic(cause) });
      }
    }
    return { plugins, invalidFiles };
  }

  async install(sourcePath: string): Promise<CLIInstalledPlugin> {
    return this.mutate(async () => {
      const sourceName = basename(sourcePath);
      const language = languageFor(sourceName);
      if (language === undefined)
        throw new PluginRuntimeError("load", "plugin source must have a .js or .ts extension");
      const source = decoder.decode(
        await readBoundedRegularFile(sourcePath, PluginRuntimeLimits.maximumSourceBytes),
      );
      const loaded = await this.sandbox.inspect(source, { language, allowsDynamicId: true });
      if (this.reservedIds.has(loaded.manifest.id))
        throw new PluginRuntimeError(
          "invalid-manifest",
          "plugin id collides with a first-party provider",
        );
      await this.ensurePluginsRoot();
      for (const extension of ["js", "ts"] as const) {
        try {
          await lstat(join(this.pluginsRoot, `${loaded.manifest.id}.${extension}`));
          throw new PluginRuntimeError("load", "plugin is already installed");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      const destination = join(
        this.pluginsRoot,
        `${loaded.manifest.id}.${language === "typescript" ? "ts" : "js"}`,
      );
      const created = await Effect.runPromise(
        this.files.writeAtomicIfAbsent(destination, encoder.encode(source)),
      );
      if (!created) throw new PluginRuntimeError("load", "plugin is already installed");
      return summary({ fileName: basename(destination), language, loaded }, false);
    });
  }

  async previewApproval(
    pluginId: string,
    settings: Readonly<Record<string, string>>,
  ): Promise<CLIPluginApprovalPreview> {
    const discovered = await this.find(pluginId);
    assertApprovalSettings(discovered.loaded.manifest, settings);
    return preview(
      discovered.loaded.manifest,
      createApprovalBinding(discovered.loaded.manifest, settings),
    );
  }

  async approve(
    pluginId: string,
    settings: Readonly<Record<string, string>>,
    typedConfirmations: Readonly<Record<string, string>>,
  ): Promise<CLIPluginApprovalPreview> {
    return this.mutate(async () => {
      const result = await this.previewApproval(pluginId, settings);
      for (const origin of result.typedConfirmationOrigins) {
        if (typedConfirmations[origin] !== origin)
          throw new PluginRuntimeError(
            "network-policy",
            "local or private origins require exact typed confirmation",
          );
      }
      const discovered = await this.find(pluginId);
      assertApprovalSettings(discovered.loaded.manifest, settings);
      const binding = createApprovalBinding(discovered.loaded.manifest, settings);
      const approvals = await this.loadApprovals();
      approvals[pluginId] = { binding, settings };
      await this.saveApprovals(approvals);
      return result;
    });
  }

  async test(pluginId: string): Promise<CLIPluginFetchResult> {
    const discovered = await this.find(pluginId);
    const approvals = await this.loadApprovals();
    const approval = approvals[pluginId];
    if (approval === undefined)
      throw new PluginRuntimeError("approval-required", "plugin requires approval before testing");
    const current = createApprovalBinding(discovered.loaded.manifest, approval.settings);
    if (!approvalMatches(current, approval.binding))
      throw new PluginRuntimeError(
        "approval-drift",
        "plugin approval no longer matches its declared security surface",
      );
    const host = new PluginBrokerHost({
      manifest: discovered.loaded.manifest,
      endpointSettings: approval.settings,
      approvedBinding: approval.binding,
      resolveSecret: (key) => this.readSecretValue(pluginId, key),
      readBrowserCookies: async (domains) => {
        const values = await Promise.all(
          domains.map((domain) => this.readBrowserCookie(pluginId, domain)),
        );
        const present = values.filter(
          (value): value is string => value !== undefined && value !== "",
        );
        return present.length === 0 ? undefined : present.join("; ");
      },
      fetch: this.fetchImplementation,
    });
    const capabilities: PluginSandboxCapabilities = makeApprovedPluginSandboxCapabilities(
      discovered.loaded.manifest,
      {
        endpointSettings: approval.settings,
        approvedBinding: approval.binding,
        readSetting: (key, secure) =>
          secure ? this.readSecretValue(pluginId, key) : approval.settings[key],
        readCookie: (domain) => this.readBrowserCookie(pluginId, domain),
        log: () => undefined,
      },
    );
    try {
      const raw = await this.sandbox.execute(
        discovered.loaded,
        new PluginBrokerProtocolServer(host),
        { timeZone: this.timeZone() },
        capabilities,
      );
      const snapshot = mapProviderSnapshot(raw, pluginId, this.now());
      return { plugin: summary(discovered, true), snapshot };
    } finally {
      host.terminate();
    }
  }

  fetch(pluginId: string): Promise<CLIPluginFetchResult> {
    return this.test(pluginId);
  }

  /** CLI composition calls this after its single command, killing the guest. */
  dispose(): void {
    this.sandbox.terminate?.();
  }

  async remove(pluginId: string): Promise<void> {
    await this.mutate(async () => {
      const discovered = await this.find(pluginId);
      const path = join(this.pluginsRoot, discovered.fileName);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new PluginRuntimeError("load", "installed plugin is not a regular file");
      const approvals = await this.loadApprovals();
      const previous = approvals[pluginId];
      const secretNames = [
        ...new Set([
          ...discovered.loaded.manifest.settings
            .filter((setting) => setting.type === "secure")
            .map((setting) => setting.key),
          ...(previous?.binding.secretNames ?? []),
        ]),
      ];
      const cookieDomains = [
        ...new Set([
          ...discovered.loaded.manifest.cookieDomains,
          ...(previous?.binding.cookieDomains ?? []),
        ]),
      ];
      delete approvals[pluginId];
      // Withdraw the approval before deleting source. If a filesystem failure
      // leaves the source in place, it is inert: it cannot retain its former
      // credential or origin grant.
      await this.saveApprovals(approvals);
      await this.removeSource(path);
      const cleanup = await Promise.allSettled([
        ...secretNames.map((key) => this.removeSecretValue(pluginId, key)),
        ...cookieDomains.map((domain) => this.removeBrowserCookie(pluginId, domain)),
      ]);
      if (cleanup.some((result) => result.status === "rejected"))
        throw new PluginRuntimeError("secret-access", "plugin secret cleanup failed");
    });
  }

  async setSecret(pluginId: string, key: string, value: string): Promise<void> {
    await this.mutate(async () => {
      const discovered = await this.find(pluginId);
      const setting = discovered.loaded.manifest.settings.find(
        (candidate) => candidate.key === key,
      );
      if (setting?.type !== "secure")
        throw new PluginRuntimeError("secret-access", "plugin secure setting is not declared");
      await this.writeSecretValue(pluginId, key, value);
    });
  }

  async removeSecret(pluginId: string, key: string): Promise<void> {
    await this.mutate(async () => {
      const discovered = await this.find(pluginId);
      const setting = discovered.loaded.manifest.settings.find(
        (candidate) => candidate.key === key,
      );
      if (setting?.type !== "secure")
        throw new PluginRuntimeError("secret-access", "plugin secure setting is not declared");
      await this.removeSecretValue(pluginId, key);
    });
  }

  private async ensurePluginsRoot(): Promise<void> {
    await assertNoSymlinkAncestors(this.pluginsRoot);
    await mkdir(this.pluginsRoot, { recursive: true, mode: 0o700 });
    await assertNoSymlinkAncestors(this.pluginsRoot);
    const metadata = await lstat(this.pluginsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new PluginRuntimeError("load", "plugin storage is not a private directory");
    await this.restrictDirectory(this.pluginsRoot);
  }

  private async find(pluginId: string): Promise<DiscoveredPlugin> {
    assertPluginId(pluginId);
    await this.ensurePluginsRoot();
    for (const extension of ["js", "ts"] as const) {
      const fileName = `${pluginId}.${extension}`;
      try {
        return await this.load(fileName, extension === "ts" ? "typescript" : "javascript");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    throw new PluginRuntimeError("load", "plugin is not installed");
  }

  private async load(fileName: string, language: PluginLanguage): Promise<DiscoveredPlugin> {
    const source = decoder.decode(
      await readBoundedRegularFile(
        join(this.pluginsRoot, fileName),
        PluginRuntimeLimits.maximumSourceBytes,
      ),
    );
    const loaded = await this.sandbox.inspect(source, { language, allowsDynamicId: true });
    if (loaded.manifest.id !== pluginFilePattern.exec(fileName)?.[1])
      throw new PluginRuntimeError(
        "invalid-manifest",
        "plugin id must match its installed file name",
      );
    if (this.reservedIds.has(loaded.manifest.id))
      throw new PluginRuntimeError(
        "invalid-manifest",
        "plugin id collides with a first-party provider",
      );
    return { fileName, language, loaded };
  }

  private async loadApprovals(): Promise<Record<string, ApprovalRecord>> {
    try {
      const bytes = await readBoundedRegularFile(
        this.approvalsPath,
        PluginRuntimeLimits.maximumSourceBytes,
      );
      const parsed = parseApprovals(JSON.parse(decoder.decode(bytes)));
      if (Object.keys(parsed).length > maximumApprovals)
        throw new PluginRuntimeError("load", "plugin approval count exceeds 64 entries");
      return parsed;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (cause instanceof PluginRuntimeError) throw cause;
      throw new PluginRuntimeError("load", "plugin approvals could not be read safely");
    }
  }

  private async saveApprovals(approvals: Readonly<Record<string, ApprovalRecord>>): Promise<void> {
    if (Object.keys(approvals).length > maximumApprovals)
      throw new PluginRuntimeError("load", "plugin approval count exceeds 64 entries");
    await assertNoSymlinkAncestors(dirname(this.approvalsPath));
    await mkdir(dirname(this.approvalsPath), { recursive: true, mode: 0o700 });
    await assertNoSymlinkAncestors(dirname(this.approvalsPath));
    await this.restrictDirectory(dirname(this.approvalsPath));
    const payload = encoder.encode(`${JSON.stringify({ approvals })}\n`);
    if (payload.byteLength > PluginRuntimeLimits.maximumSourceBytes)
      throw new PluginRuntimeError("load", "plugin approvals exceed the 1 MiB limit");
    await Effect.runPromise(this.files.writeAtomic(this.approvalsPath, payload));
  }

  private async mutate<Value>(operation: () => Promise<Value>): Promise<Value> {
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

export const pluginSecretKey = (pluginId: string, key: string): string =>
  `plugin/${pluginId}/setting/${key}`;
