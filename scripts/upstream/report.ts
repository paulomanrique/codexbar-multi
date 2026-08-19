import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

interface Baseline {
  readonly codexBar: { readonly commit: string };
}

const matrixProviderIds = (source: string): readonly string[] =>
  [...source.matchAll(/^\s+- id:\s*([a-z0-9-]+)\s*$/gm)].map((match) => match[1] ?? "");

const canonicalProviderIds = (source: string): readonly string[] => {
  const roster = source.match(/PROVIDER_IDS\s*=\s*\[([\s\S]*?)\]\s+as const/);
  if (roster === null) throw new Error("could not locate PROVIDER_IDS in contracts/provider.ts");
  const body = roster[1];
  if (body === undefined) throw new Error("PROVIDER_IDS declaration has no body");
  return [...body.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1] ?? "");
};

const validateProviderMatrix = (source: string, canonical: readonly string[]): void => {
  const ids = matrixProviderIds(source);
  if (ids.length !== 69) {
    throw new Error(`upstream/providers.yml must contain exactly 69 entries (found ${ids.length})`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("upstream/providers.yml contains duplicate provider IDs");
  }
  if (ids.join("\n") !== canonical.join("\n")) {
    throw new Error("upstream/providers.yml provider order does not match contracts/provider.ts");
  }

  const entries = source.split(/\n(?=\s+- id:\s)/).filter((entry) => /^\s+- id:\s/m.test(entry));
  for (const entry of entries) {
    const id = /^\s+- id:\s*([a-z0-9-]+)/m.exec(entry)?.[1] ?? "unknown";
    const status = /^\s+status:\s*(\w+)/m.exec(entry)?.[1];
    const oracleStatus = /^\s+oracleStatus:\s*(\w+)/m.exec(entry)?.[1];
    if (status !== "unported" && status !== "partial" && status !== "parity") {
      throw new Error(`provider ${id} has invalid migration status '${status ?? "missing"}'`);
    }
    if (oracleStatus !== "pending" && oracleStatus !== "accepted") {
      throw new Error(`provider ${id} must declare oracleStatus pending|accepted`);
    }
    if (status === "parity" && oracleStatus !== "accepted") {
      throw new Error(
        `provider ${id} cannot be parity without an accepted Swift oracle comparison`,
      );
    }
    if (status === "partial") {
      const realPaths = entry.match(/^\s+- packages\/providers\/src\/providers\/[^\n]+$/gm) ?? [];
      const tsTests = entry.match(/^\s+- packages\/providers\/test\/[^\n]+$/gm) ?? [];
      if (realPaths.length === 0 || tsTests.length === 0) {
        throw new Error(`provider ${id} is partial without both a real TS path and TS tests`);
      }
    }
  }
};

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const globRegularExpression = (glob: string): RegExp => {
  const escaped = escapeRegularExpression(glob)
    .replaceAll("**/*", "__GLOBSTAR_SLASH__")
    .replaceAll("**", "__GLOBSTAR__")
    .replaceAll("*", "[^/]*")
    .replaceAll("__GLOBSTAR_SLASH__", ".*")
    .replaceAll("__GLOBSTAR__", ".*");
  return new RegExp(`^${escaped}$`, "i");
};

const providerPathMatchers = (
  source: string,
): ReadonlyArray<{ readonly id: string; readonly patterns: ReadonlyArray<RegExp> }> =>
  source
    .split(/\n(?=\s+- id:\s)/)
    .filter((entry) => /^\s+- id:\s/m.test(entry))
    .map((entry) => ({
      id: /^\s+- id:\s*([a-z0-9-]+)/m.exec(entry)?.[1] ?? "unknown",
      patterns: [...entry.matchAll(/^\s+- ((?:Sources|Tests|TestsLinux)\/[^\n]+)$/gm)].map(
        (match) => globRegularExpression(match[1] ?? ""),
      ),
    }));

const root = new URL("../../", import.meta.url).pathname;
const baseline = JSON.parse(
  await readFile(new URL("../../upstream/baseline.json", import.meta.url), "utf8"),
) as Baseline;
const providerMatrix = await readFile(
  new URL("../../upstream/providers.yml", import.meta.url),
  "utf8",
);
const canonical = canonicalProviderIds(
  await readFile(new URL("../../packages/contracts/src/provider.ts", import.meta.url), "utf8"),
);
validateProviderMatrix(providerMatrix, canonical);
const providerMatchers = providerPathMatchers(providerMatrix);
const target = process.argv[2] ?? "upstream/main";
const diff = execFileSync(
  "git",
  ["diff", "--name-status", `${baseline.codexBar.commit}..${target}`],
  {
    cwd: root,
    encoding: "utf8",
  },
).trim();

const classify = (path: string): readonly string[] => {
  const categories = new Set<string>();
  if (/Provider|Providers|UsageFetcher/.test(path)) categories.add("provider");
  if (/Auth|OAuth|Credential|Cookie|Keychain/i.test(path)) categories.add("auth");
  if (/Parser|Decoder|Snapshot|JSON/i.test(path)) categories.add("parser");
  if (/Cost|Pricing|History/i.test(path)) categories.add("cost-history");
  if (/Config|Settings|Defaults/i.test(path)) categories.add("config");
  if (/Fixture|Resources\/.*\.(json|html|txt)$/i.test(path)) categories.add("fixture");
  if (/Test/i.test(path)) categories.add("test");
  if (/Plugin|QuickJS/i.test(path)) categories.add("plugin-runtime");
  if (categories.size === 0) categories.add("unclassified");
  return [...categories];
};

const rows =
  diff === ""
    ? []
    : diff.split("\n").map((line) => {
        const [status = "?", ...pathParts] = line.split("\t");
        const path = pathParts.at(-1) ?? "";
        const providers = providerMatchers
          .filter((provider) => provider.patterns.some((pattern) => pattern.test(path)))
          .map((provider) => provider.id);
        return { status, path, categories: classify(path), providers };
      });

console.log(`# CodexBar upstream semantic report\n`);
console.log(`Baseline: \`${baseline.codexBar.commit}\`  `);
console.log(`Target: \`${target}\`  `);
console.log(`Changed files: ${rows.length}\n`);
if (rows.length === 0) {
  console.log("No upstream changes detected.");
} else {
  console.log("| Status | Categories | Providers | Upstream path |");
  console.log("| --- | --- | --- | --- |");
  for (const row of rows)
    console.log(
      `| ${row.status} | ${row.categories.join(", ")} | ${row.providers.join(", ") || "—"} | \`${row.path}\` |`,
    );
}
