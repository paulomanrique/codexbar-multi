const { createHash } = require("node:crypto");
const {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { isAbsolute, join } = require("node:path");
const { getAsset, isSea } = require("node:sea");
const { pathToFileURL } = require("node:url");

const assetName = "codexbar-multi/sea/keyring.node";
const manifestName = "codexbar-multi/sea/manifest.json";
const pluginChildAssetName = "codexbar-multi/sea/plugin-sandbox-child.mjs";
const pluginChildEnvironmentKey = "CODEXBAR_MULTI_SEA_PLUGIN_CHILD";

const readAsset = (name: string): Buffer => {
  const asset = getAsset(name);
  if (asset === undefined) throw new Error(`The standalone CLI is missing the ${name} SEA asset.`);
  return Buffer.from(asset);
};

const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");

const cacheRoot = (): string => {
  const configured = process.env.XDG_CACHE_HOME;
  if (process.platform !== "win32" && configured !== undefined && isAbsolute(configured))
    return configured;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local !== undefined && isAbsolute(local)) return local;
    return join(homedir(), "AppData", "Local");
  }
  return join(homedir(), ".cache");
};

const ensurePrivateDirectory = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Refusing unsafe standalone CLI cache directory: ${path}`);
  if (process.platform !== "win32") {
    try {
      require("node:fs").chmodSync(path, 0o700);
    } catch {
      // A restrictive umask or filesystem can make chmod unavailable. The
      // addon is still verified before every load, so fail only when the
      // effective permissions are broader than owner-only.
      if ((lstatSync(path).mode & 0o077) !== 0)
        throw new Error(`Unable to restrict standalone CLI cache directory: ${path}`);
    }
  }
};

const syncDirectory = (directory: string) => {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const readManifest = (): { readonly sha256: string; readonly pluginChildSha256: string } => {
  const manifest = JSON.parse(readAsset(manifestName).toString("utf8")) as {
    readonly sha256?: unknown;
    readonly pluginChildSha256?: unknown;
  };
  if (
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    typeof manifest.pluginChildSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.pluginChildSha256)
  )
    throw new Error("The standalone CLI asset manifest is invalid.");
  return { sha256: manifest.sha256, pluginChildSha256: manifest.pluginChildSha256 };
};

const extractVerifiedAsset = (options: {
  readonly asset: string;
  readonly expectedDigest: string;
  readonly namespace: string;
  readonly extension: string;
  readonly description: string;
}): string => {
  const contents = readAsset(options.asset);
  if (digest(contents) !== options.expectedDigest)
    throw new Error(`The standalone CLI ${options.description} asset failed verification.`);

  const directory = join(cacheRoot(), "codexbar-multi", "sea", options.namespace);
  ensurePrivateDirectory(directory);
  const target = join(directory, `${options.expectedDigest}${options.extension}`);
  try {
    const existing = lstatSync(target);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      digest(readFileSync(target)) !== options.expectedDigest
    )
      throw new Error(
        `Refusing unsafe standalone CLI ${options.description} cache entry: ${target}`,
      );
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staged = join(directory, `.${options.expectedDigest}.${process.pid}.${Date.now()}.tmp`);
  let published = false;
  try {
    const descriptor = openSync(staged, "wx", 0o600);
    try {
      writeFileSync(descriptor, contents);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(staged, target);
      published = true;
    } catch (error) {
      try {
        const existing = lstatSync(target);
        if (
          existing.isFile() &&
          !existing.isSymbolicLink() &&
          digest(readFileSync(target)) === options.expectedDigest
        )
          return target;
      } catch {
        // Preserve the original publication failure below.
      }
      throw error;
    }
  } finally {
    if (!published) {
      try {
        rmSync(staged, { force: true });
      } catch {
        // The primary write/publication error is more useful to the caller.
      }
    }
  }
  syncDirectory(directory);
  return target;
};

const extractAddon = (): string => {
  const manifest = readManifest();
  return extractVerifiedAsset({
    asset: assetName,
    expectedDigest: manifest.sha256,
    namespace: "keyring",
    extension: ".node",
    description: "keyring",
  });
};

const extractPluginChild = (): string => {
  const manifest = readManifest();
  return extractVerifiedAsset({
    asset: pluginChildAssetName,
    expectedDigest: manifest.pluginChildSha256,
    namespace: "plugin-sandbox",
    extension: ".mjs",
    description: "plugin sandbox child",
  });
};

if (!isSea())
  throw new Error(
    "This CommonJS bundle is only valid inside a Node SEA executable. Use pnpm build:cli for normal development.",
  );

if (process.env[pluginChildEnvironmentKey] === "1") {
  delete process.env[pluginChildEnvironmentKey];
  const child = extractPluginChild();
  void import(pathToFileURL(child).href).catch(() => {
    process.exitCode = 1;
  });
} else {
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = extractAddon();
  void require("./sea-main.ts").runSeaCLI();
}
