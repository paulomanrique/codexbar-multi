import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const domainRoots = [
  "packages/contracts",
  "packages/core",
  "packages/providers",
  "packages/plugin-runtime",
];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const forbiddenDomainPatterns: readonly [RegExp, string][] = [
  [/from\s+["']electron["']|import\s*\(["']electron["']\)/, "Electron import"],
  [/from\s+["']node:|import\s*\(["']node:/, "Node built-in import"],
  [/from\s+["']bun:|import\s*\(["']bun:/, "Bun built-in import"],
  [/\bprocess\.platform\b/, "process.platform branch"],
];

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return entry.name === "dist" || entry.name === "node_modules" ? [] : walk(path);
      return sourceExtensions.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
}

const failures: string[] = [];
for (const root of domainRoots) {
  for (const path of await walk(join(repositoryRoot, root))) {
    const source = await readFile(path, "utf8");
    for (const [pattern, label] of forbiddenDomainPatterns) {
      if (pattern.test(source)) failures.push(`${relative(repositoryRoot, path)}: ${label}`);
    }
  }
}

for (const path of await walk(join(repositoryRoot, "apps/desktop/src/renderer"))) {
  const source = await readFile(path, "utf8");
  if (/from\s+["']electron["']|\bipcRenderer\b|\brequire\s*\(/.test(source)) {
    failures.push(`${relative(repositoryRoot, path)}: renderer bypasses the typed preload bridge`);
  }
}

const ownerIsolationRoots = [
  "packages/contracts/src",
  "apps/desktop/src/ipc",
  "apps/desktop/src/preload",
  "apps/desktop/src/renderer",
];
const ownerIsolationPattern =
  /\b(?:claudeOAuthHistoryOwnerIdentifier|historyOwnerIdentifier|stableClaudeOAuthHistoryOwner)\b/;
for (const root of ownerIsolationRoots) {
  for (const path of await walk(join(repositoryRoot, root))) {
    if (ownerIsolationPattern.test(await readFile(path, "utf8"))) {
      failures.push(
        `${relative(repositoryRoot, path)}: credential history owner crosses host boundary`,
      );
    }
  }
}

for (const relativePath of [
  "packages/core/src/provider-fetch-pipeline.ts",
  "packages/core/src/services.ts",
]) {
  const path = join(repositoryRoot, relativePath);
  if (ownerIsolationPattern.test(await readFile(path, "utf8"))) {
    failures.push(`${relativePath}: provider outcome/service exposes credential history owner`);
  }
}

const productionCompositionRoots = [
  "apps/desktop/src/main/index.ts",
  "apps/cli/src/runner.ts",
] as const;
for (const relativePath of productionCompositionRoots) {
  const source = await readFile(join(repositoryRoot, relativePath), "utf8");
  if (!/\bmakeTokenAccountVaultConfigRepository\b/.test(source)) {
    failures.push(`${relativePath}: production config repository is not vault-wrapped`);
  }
  if (!/\bmakeNodeTokenAccountMigrationLock\b/.test(source)) {
    failures.push(`${relativePath}: production config repository has no Node migration lock`);
  }
  if (/makeNodeTokenAccountMigrationLock\s*\(\s*\{\s*configPath\b/.test(source)) {
    failures.push(`${relativePath}: migration lock is scoped to a config instead of the vault`);
  }
  if (
    /\bselectedFirstPartyAccountFromConfig\b|\bselectedClaudeHistoryBindingFromConfig\b/.test(
      source,
    )
  ) {
    failures.push(`${relativePath}: production root calls raw selected token-account resolver`);
  }
}

if (failures.length > 0) {
  console.error(
    ["Architecture boundary violations:", ...failures.map((failure) => `- ${failure}`)].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries: OK");
}
