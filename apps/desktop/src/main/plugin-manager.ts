import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  InstalledPluginDTO,
  PluginApprovalBindingDTO,
  PluginApprovalPreviewDTO,
  PluginApprovalRequestDTO,
  PluginListResultDTO,
  PluginSourceLanguage,
  PluginSecretRequestDTO,
  PluginSecretResultDTO,
  TestPluginResultDTO,
  UsageSnapshot,
} from "@codexbar/contracts";
import {
  approvalMatches,
  createApprovalBinding,
  PluginRuntimeError,
  PluginRuntimeLimits,
  PluginBrokerHost,
  PluginBrokerProtocolServer,
  makeApprovedPluginSandboxCapabilities,
  typedConfirmationOrigins,
  type LoadedPlugin,
  type PluginApprovalBinding,
  type PluginSandboxCapabilities,
  type PluginSandboxExecutionContext,
} from "@codexbar/plugin-runtime";
import { mapProviderSnapshot } from "@codexbar/providers";

export interface PluginInspector {
  readonly inspect: (
    source: string,
    options: { readonly language: PluginSourceLanguage; readonly allowsDynamicId: true },
  ) => Promise<LoadedPlugin>;
}

export interface PluginSandbox extends PluginInspector {
  readonly execute: (
    plugin: Pick<LoadedPlugin, "transpiledSource" | "manifest">,
    broker: PluginBrokerProtocolServer,
    context?: PluginSandboxExecutionContext,
    capabilities?: PluginSandboxCapabilities,
  ) => Promise<Record<string, unknown>>;
}

interface ApprovalRecord {
  readonly binding: PluginApprovalBinding;
  readonly settings: Readonly<Record<string, string>>;
}

interface ApprovalPayload {
  readonly approvals: Readonly<Record<string, ApprovalRecord>>;
}

interface DiscoveredPlugin {
  readonly fileName: string;
  readonly language: PluginSourceLanguage;
  readonly loaded: LoadedPlugin;
}

const encoder = new TextEncoder();
const pluginIdPattern = /^[a-z0-9-]{1,64}$/;
const pluginFile = /^([a-z0-9-]{1,64})\.(js|ts)$/;

function assertPluginId(pluginId: string): void {
  if (!pluginIdPattern.test(pluginId)) throw new PluginRuntimeError("load", "plugin id is invalid");
}

function languageFor(fileName: string): PluginSourceLanguage | undefined {
  const match = pluginFile.exec(fileName);
  if (match === null) return undefined;
  return match[2] === "ts" ? "typescript" : "javascript";
}

function safeMessage(cause: unknown): string {
  const source = cause instanceof Error ? cause.message : "plugin validation failed";
  return [...source]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 512);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseBinding(value: unknown): PluginApprovalBinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.instanceId !== "string" ||
    typeof item.authMode !== "string" ||
    !isStringArray(item.origins) ||
    !isStringArray(item.secretNames) ||
    !isStringArray(item.capabilities) ||
    !isStringArray(item.cookieDomains)
  ) {
    return undefined;
  }
  for (const key of ["authHeader", "authSecret", "authScheme"] as const) {
    if (item[key] !== undefined && typeof item[key] !== "string") return undefined;
  }
  return {
    instanceId: item.instanceId,
    origins: item.origins,
    authMode: item.authMode,
    ...(typeof item.authHeader === "string" ? { authHeader: item.authHeader } : {}),
    ...(typeof item.authSecret === "string" ? { authSecret: item.authSecret } : {}),
    ...(typeof item.authScheme === "string" ? { authScheme: item.authScheme } : {}),
    secretNames: item.secretNames,
    capabilities: item.capabilities,
    cookieDomains: item.cookieDomains,
  };
}

function parseApprovals(value: unknown): Record<string, ApprovalRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = (value as { approvals?: unknown }).approvals;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return {};
  const parsed: Record<string, ApprovalRecord> = {};
  for (const [id, raw] of Object.entries(source)) {
    if (!pluginFile.test(`${id}.js`) || typeof raw !== "object" || raw === null) continue;
    const record = raw as { binding?: unknown; settings?: unknown };
    const binding = parseBinding(record.binding);
    if (binding === undefined || binding.instanceId !== id) continue;
    const settings = record.settings;
    if (
      typeof settings !== "object" ||
      settings === null ||
      Array.isArray(settings) ||
      !Object.values(settings).every((item) => typeof item === "string")
    ) {
      continue;
    }
    parsed[id] = { binding, settings: settings as Record<string, string> };
  }
  return parsed;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("plugin storage is not a private directory");
  }
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes)
      throw new Error("plugin file is not a bounded regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path: string, content: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeAtomicIfAbsent(path: string, content: Uint8Array): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw cause;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function bindingDTO(binding: PluginApprovalBinding): PluginApprovalBindingDTO {
  return { ...binding };
}

export class DesktopPluginManager {
  private readonly pluginsRoot: string;
  private readonly approvalsPath: string;
  private readonly sandbox: PluginSandbox;
  private readonly reservedIds: ReadonlySet<string>;
  private readonly readSecret: (pluginId: string, key: string) => Promise<string | undefined>;
  private readonly writeSecret: (pluginId: string, key: string, value: string) => Promise<void>;
  private readonly removeSecret: (pluginId: string, key: string) => Promise<void>;
  private readonly readCookie: (pluginId: string, domain: string) => Promise<string | undefined>;
  private readonly persistSnapshot: (pluginId: string, snapshot: UsageSnapshot) => Promise<void>;
  private readonly removeSnapshot: (pluginId: string) => Promise<void>;
  private readonly removeConfig: (pluginId: string) => Promise<void>;
  private readonly removeHistory: (pluginId: string) => Promise<void>;
  private readonly removeBrowserSessions: (
    pluginId: string,
    domains: readonly string[],
  ) => Promise<void>;
  private readonly finalizeRemove: (pluginId: string) => Promise<void>;
  private readonly cleanupCredentials: (
    pluginId: string,
    secureSettingKeys: readonly string[],
  ) => Promise<void>;
  private readonly log: (pluginId: string, message: string) => void | Promise<void>;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeZone: () => string;
  private readonly now: () => Date;
  private mutation = Promise.resolve();

  constructor(options: {
    readonly storageRoot: string;
    readonly sandbox: PluginSandbox;
    readonly reservedIds: ReadonlySet<string>;
    readonly readSecret?: (pluginId: string, key: string) => Promise<string | undefined>;
    readonly writeSecret?: (pluginId: string, key: string, value: string) => Promise<void>;
    readonly removeSecret?: (pluginId: string, key: string) => Promise<void>;
    readonly readCookie?: (pluginId: string, domain: string) => Promise<string | undefined>;
    /** Receives only a schema-validated provider snapshot. */
    readonly persistSnapshot?: (pluginId: string, snapshot: UsageSnapshot) => Promise<void>;
    /** Clears ephemeral snapshot/error state belonging exclusively to this plugin. */
    readonly removeSnapshot?: (pluginId: string) => Promise<void>;
    /** Removes this plugin's config entry using the host's atomic config writer. */
    readonly removeConfig?: (pluginId: string) => Promise<void>;
    /** Removes only this plugin's durable history rows. */
    readonly removeHistory?: (pluginId: string) => Promise<void>;
    /** Removes only browser-session credentials declared by this plugin. */
    readonly removeBrowserSessions?: (
      pluginId: string,
      domains: readonly string[],
    ) => Promise<void>;
    /** Clears the plugin's declared secure settings without requiring keyring enumeration. */
    readonly cleanupCredentials?: (
      pluginId: string,
      secureSettingKeys: readonly string[],
    ) => Promise<void>;
    /** Runs only after the source and approval have both been removed successfully. */
    readonly finalizeRemove?: (pluginId: string) => Promise<void>;
    readonly log?: (pluginId: string, message: string) => void | Promise<void>;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeZone?: () => string;
    readonly now?: () => Date;
  }) {
    this.pluginsRoot = join(options.storageRoot, "plugins");
    this.approvalsPath = join(options.storageRoot, "plugin-approvals.json");
    this.sandbox = options.sandbox;
    this.reservedIds = options.reservedIds;
    this.readSecret = options.readSecret ?? (async () => undefined);
    this.writeSecret =
      options.writeSecret ??
      (async () => {
        throw new PluginRuntimeError("secret-access", "plugin secret storage is unavailable");
      });
    this.removeSecret = options.removeSecret ?? (async () => undefined);
    this.readCookie = options.readCookie ?? (async () => undefined);
    this.persistSnapshot = options.persistSnapshot ?? (async () => undefined);
    this.removeSnapshot = options.removeSnapshot ?? (async () => undefined);
    this.removeConfig = options.removeConfig ?? (async () => undefined);
    this.removeHistory = options.removeHistory ?? (async () => undefined);
    this.removeBrowserSessions = options.removeBrowserSessions ?? (async () => undefined);
    this.cleanupCredentials =
      options.cleanupCredentials ??
      (async (pluginId, secureSettingKeys) => {
        const removals = await Promise.allSettled(
          secureSettingKeys.map((key) => this.removeSecret(pluginId, key)),
        );
        if (removals.some((result) => result.status === "rejected")) {
          throw new PluginRuntimeError("secret-access", "plugin secret cleanup failed");
        }
      });
    this.finalizeRemove = options.finalizeRemove ?? (async () => undefined);
    this.log = options.log ?? (() => undefined);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<PluginListResultDTO> {
    await ensurePrivateDirectory(this.pluginsRoot);
    const approvals = await this.loadApprovals();
    const entries = await readdir(this.pluginsRoot, { withFileTypes: true });
    const plugins: InstalledPluginDTO[] = [];
    const invalidFiles: Array<{ fileName: string; error: string }> = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const language = languageFor(entry.name);
      if (language === undefined || !entry.isFile() || entry.isSymbolicLink()) continue;
      try {
        const discovered = await this.load(entry.name, language);
        const approval = approvals[discovered.loaded.manifest.id];
        let approved = false;
        if (approval !== undefined) {
          const current = createApprovalBinding(discovered.loaded.manifest, approval.settings);
          approved = approvalMatches(current, approval.binding);
        }
        plugins.push(this.summary(discovered, approved));
      } catch (cause) {
        invalidFiles.push({ fileName: basename(entry.name), error: safeMessage(cause) });
      }
    }
    return { plugins, invalidFiles };
  }

  async install(source: string, language: PluginSourceLanguage): Promise<InstalledPluginDTO> {
    return this.mutate(async () => {
      if (encoder.encode(source).byteLength > PluginRuntimeLimits.maximumSourceBytes)
        throw new PluginRuntimeError("load", "plugin exceeds the 1 MiB source limit");
      const loaded = await this.sandbox.inspect(source, { language, allowsDynamicId: true });
      if (this.reservedIds.has(loaded.manifest.id))
        throw new PluginRuntimeError(
          "invalid-manifest",
          "plugin id collides with a first-party provider",
        );
      await ensurePrivateDirectory(this.pluginsRoot);
      for (const existingExtension of ["js", "ts"] as const) {
        try {
          await lstat(join(this.pluginsRoot, `${loaded.manifest.id}.${existingExtension}`));
          throw new PluginRuntimeError("load", "plugin is already installed");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      const extension = language === "typescript" ? "ts" : "js";
      const installed = await writeAtomicIfAbsent(
        join(this.pluginsRoot, `${loaded.manifest.id}.${extension}`),
        encoder.encode(source),
      );
      if (!installed) throw new PluginRuntimeError("load", "plugin is already installed");
      return this.summary(
        { fileName: `${loaded.manifest.id}.${extension}`, language, loaded },
        false,
      );
    });
  }

  async previewApproval(
    pluginId: string,
    settings: Readonly<Record<string, string>>,
  ): Promise<PluginApprovalPreviewDTO> {
    const discovered = await this.find(pluginId);
    const binding = createApprovalBinding(discovered.loaded.manifest, settings);
    return {
      binding: bindingDTO(binding),
      typedConfirmationOrigins: typedConfirmationOrigins(binding),
    };
  }

  async approve(request: PluginApprovalRequestDTO): Promise<PluginApprovalPreviewDTO> {
    return this.mutate(async () => {
      const preview = await this.previewApproval(request.pluginId, request.settings);
      for (const origin of preview.typedConfirmationOrigins) {
        if (request.typedConfirmations[origin] !== origin)
          throw new PluginRuntimeError(
            "network-policy",
            "local or private origins require exact typed confirmation",
          );
      }
      const binding = parseBinding(preview.binding);
      if (binding === undefined)
        throw new PluginRuntimeError("invalid-manifest", "plugin approval binding is invalid");
      const approvals = await this.loadApprovals();
      approvals[request.pluginId] = { binding, settings: request.settings };
      await this.saveApprovals(approvals);
      return preview;
    });
  }

  async remove(pluginId: string): Promise<void> {
    await this.mutate(async () => {
      const discovered = await this.find(pluginId);
      const path = join(this.pluginsRoot, discovered.fileName);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new Error("installed plugin is not a regular file");
      // Retain the approved surface too: a manually replaced source can no
      // longer declare an old secure setting or cookie domain, but removal
      // must still clear credentials that the earlier approved source owned.
      const approvals = await this.loadApprovals();
      const previous = approvals[pluginId];
      const secureSettingKeys = [
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
      const removals = await Promise.allSettled([
        this.cleanupCredentials(pluginId, secureSettingKeys),
        this.removeBrowserSessions(pluginId, cookieDomains),
        this.removeSnapshot(pluginId),
        this.removeHistory(pluginId),
        this.removeConfig(pluginId),
      ]);
      if (removals.some((result) => result.status === "rejected"))
        throw new PluginRuntimeError("secret-access", "plugin cleanup failed");
      await unlink(path);
      delete approvals[pluginId];
      await this.saveApprovals(approvals);
      await this.finalizeRemove(pluginId);
    });
  }

  async configureSecret(request: PluginSecretRequestDTO): Promise<PluginSecretResultDTO> {
    return this.mutate(async () => {
      const discovered = await this.find(request.pluginId);
      const setting = discovered.loaded.manifest.settings.find(
        (candidate) => candidate.key === request.key,
      );
      if (setting?.type !== "secure")
        throw new PluginRuntimeError("secret-access", "plugin secure setting is not declared");
      if (request.operation === "set") {
        await this.writeSecret(request.pluginId, request.key, request.value);
        return { pluginId: request.pluginId, key: request.key, configured: true };
      }
      await this.removeSecret(request.pluginId, request.key);
      return { pluginId: request.pluginId, key: request.key, configured: false };
    });
  }

  async test(pluginId: string): Promise<TestPluginResultDTO> {
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
      resolveSecret: (key) => this.readSecret(pluginId, key),
      readBrowserCookies: async (domains) => {
        const values = await Promise.all(
          domains.map((domain) => this.readCookie(pluginId, domain)),
        );
        const present = values.filter(
          (value): value is string => value !== undefined && value !== "",
        );
        return present.length === 0 ? undefined : present.join("; ");
      },
      fetch: this.fetchImplementation,
    });
    const capabilities = makeApprovedPluginSandboxCapabilities(discovered.loaded.manifest, {
      endpointSettings: approval.settings,
      approvedBinding: approval.binding,
      readSetting: (key, secure) =>
        secure ? this.readSecret(pluginId, key) : approval.settings[key],
      readCookie: (domain) => this.readCookie(pluginId, domain),
      log: (message) => this.log(pluginId, message),
    });
    try {
      const raw = await this.sandbox.execute(
        discovered.loaded,
        new PluginBrokerProtocolServer(host),
        { timeZone: this.timeZone() },
        capabilities,
      );
      const snapshot = mapProviderSnapshot(raw, pluginId, this.now());
      await this.persistSnapshot(pluginId, snapshot);
      return { pluginId, snapshot };
    } finally {
      host.terminate();
    }
  }

  private async find(pluginId: string): Promise<DiscoveredPlugin> {
    assertPluginId(pluginId);
    await ensurePrivateDirectory(this.pluginsRoot);
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

  private async load(fileName: string, language: PluginSourceLanguage): Promise<DiscoveredPlugin> {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      await readRegularFile(
        join(this.pluginsRoot, fileName),
        PluginRuntimeLimits.maximumSourceBytes,
      ),
    );
    const loaded = await this.sandbox.inspect(source, { language, allowsDynamicId: true });
    if (loaded.manifest.id !== pluginFile.exec(fileName)?.[1])
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

  private summary(discovered: DiscoveredPlugin, approved: boolean): InstalledPluginDTO {
    const manifest = discovered.loaded.manifest;
    return {
      id: manifest.id,
      name: manifest.name,
      language: discovered.language,
      icon: manifest.icon,
      settings: manifest.settings,
      capabilities: manifest.capabilities,
      cookieDomains: manifest.cookieDomains,
      approvalStatus: approved ? "approved" : "needs-approval",
    };
  }

  private async loadApprovals(): Promise<Record<string, ApprovalRecord>> {
    try {
      const bytes = await readRegularFile(
        this.approvalsPath,
        PluginRuntimeLimits.maximumSourceBytes,
      );
      return parseApprovals(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      return {};
    }
  }

  private async saveApprovals(approvals: Readonly<Record<string, ApprovalRecord>>): Promise<void> {
    await ensurePrivateDirectory(dirname(this.approvalsPath));
    const payload: ApprovalPayload = { approvals };
    await writeAtomic(this.approvalsPath, encoder.encode(`${JSON.stringify(payload, null, 2)}\n`));
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
