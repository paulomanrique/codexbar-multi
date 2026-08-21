import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { parseProviderMatrix, validateProviderMatrix } from "./provider-matrix.ts";

interface Baseline {
  readonly codexBar: { readonly commit: string };
}

const canonicalProviderIds = (source: string): readonly string[] => {
  const roster = source.match(/PROVIDER_IDS\s*=\s*\[([\s\S]*?)\]\s+as const/);
  if (roster === null) throw new Error("could not locate PROVIDER_IDS in contracts/provider.ts");
  const body = roster[1];
  if (body === undefined) throw new Error("PROVIDER_IDS declaration has no body");
  return [...body.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1] ?? "");
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

const expandBraceGlobs = (glob: string): readonly string[] => {
  const match = /\{([^{}]+)\}/.exec(glob);
  if (match === null) return [glob];
  const token = match[0];
  const choices = match[1]?.split(",") ?? [];
  return choices.flatMap((choice) => expandBraceGlobs(glob.replace(token, choice)));
};

const semanticPathMatchers = (
  source: string,
): ReadonlyArray<{ readonly id: string; readonly patterns: ReadonlyArray<RegExp> }> =>
  source
    .split(/\n(?=\s+- id:\s)/)
    .filter((entry) => /^\s+- id:\s/m.test(entry))
    .map((entry) => ({
      id: /^\s+- id:\s*([a-z0-9-]+)/m.exec(entry)?.[1] ?? "unknown",
      patterns: [...entry.matchAll(/^\s+- ((?:Sources|Tests|TestsLinux)\/[^\n]+)$/gm)].flatMap(
        (match) => expandBraceGlobs(match[1] ?? "").map(globRegularExpression),
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
const componentMatrix = await readFile(
  new URL("../../upstream/components.yml", import.meta.url),
  "utf8",
);
const canonical = canonicalProviderIds(
  await readFile(new URL("../../packages/contracts/src/provider.ts", import.meta.url), "utf8"),
);
const pluginResourceFiles = await readdir(
  new URL("../../Sources/CodexBarCore/Resources/Plugins/", import.meta.url),
);
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path.length > 0);
const providerSources: Record<string, string> = {};
for (const entry of parseProviderMatrix(providerMatrix)) {
  for (const path of [...entry.expectedTsPaths, ...entry.realTsPaths]) {
    providerSources[path] = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  }
}
validateProviderMatrix({
  source: providerMatrix,
  canonicalProviderIds: canonical,
  pluginResourceFiles,
  trackedFiles,
  providerSources,
});
const providerMatchers = semanticPathMatchers(providerMatrix);
const componentMatchers = semanticPathMatchers(componentMatrix);
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
        const components = componentMatchers
          .filter((component) => component.patterns.some((pattern) => pattern.test(path)))
          .map((component) => component.id);
        return { status, path, categories: classify(path), providers, components };
      });

console.log(`# CodexBar upstream semantic report\n`);
console.log(`Baseline: \`${baseline.codexBar.commit}\`  `);
console.log(`Target: \`${target}\`  `);
console.log(`Changed files: ${rows.length}\n`);
if (rows.length === 0) {
  console.log("No upstream changes detected.");
} else {
  console.log("| Status | Categories | Components | Providers | Upstream path |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const row of rows)
    console.log(
      `| ${row.status} | ${row.categories.join(", ")} | ${row.components.join(", ") || "—"} | ${row.providers.join(", ") || "—"} | \`${row.path}\` |`,
    );
}
