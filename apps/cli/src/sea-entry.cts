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

const assetName = "codexbar-multi/sea/keyring.node";
const manifestName = "codexbar-multi/sea/manifest.json";

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

const extractAddon = (): string => {
  const manifest = JSON.parse(readAsset(manifestName).toString("utf8")) as {
    readonly sha256?: unknown;
  };
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw new Error("The standalone CLI keyring manifest is invalid.");
  const addon = readAsset(assetName);
  if (digest(addon) !== manifest.sha256)
    throw new Error("The standalone CLI keyring asset failed verification.");

  const directory = join(cacheRoot(), "codexbar-multi", "sea", "keyring");
  ensurePrivateDirectory(directory);
  const target = join(directory, `${manifest.sha256}.node`);
  try {
    const existing = lstatSync(target);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      digest(readFileSync(target)) !== manifest.sha256
    )
      throw new Error(`Refusing unsafe standalone CLI keyring cache entry: ${target}`);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staged = join(directory, `.${manifest.sha256}.${process.pid}.${Date.now()}.tmp`);
  let published = false;
  try {
    const descriptor = openSync(staged, "wx", 0o600);
    try {
      writeFileSync(descriptor, addon);
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
          digest(readFileSync(target)) === manifest.sha256
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

if (!isSea())
  throw new Error(
    "This CommonJS bundle is only valid inside a Node SEA executable. Use pnpm build:cli for normal development.",
  );

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = extractAddon();
void require("./sea-main.ts").runSeaCLI();
