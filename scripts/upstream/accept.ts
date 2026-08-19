import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";

interface Baseline {
  codexBar: { commit: string; version: string; repository: string };
  [key: string]: unknown;
}

const root = new URL("../../", import.meta.url).pathname;
const requested = process.argv[2];
if (requested === undefined) {
  console.error("Usage: pnpm upstream:accept <upstream-commit>");
  process.exit(2);
}

const commit = execFileSync("git", ["rev-parse", "--verify", `${requested}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
// The semantic provider matrix is validated by the report command. Run it
// before changing the reviewed commit so malformed or incomplete metadata can
// never be accepted accidentally.
execFileSync("pnpm", ["upstream:report", commit], { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["local-gate"], { cwd: root, stdio: "inherit" });

const baselineUrl = new URL("../../upstream/baseline.json", import.meta.url);
const baseline = JSON.parse(await readFile(baselineUrl, "utf8")) as Baseline;
const previousCommit = baseline.codexBar.commit;
baseline.codexBar.commit = commit;
const providersUrl = new URL("../../upstream/providers.yml", import.meta.url);
const componentsUrl = new URL("../../upstream/components.yml", import.meta.url);
const updateReviewedCommit = async (url: URL, stagedName: string): Promise<void> => {
  const source = await readFile(url, "utf8");
  if (!source.includes(previousCommit)) {
    throw new Error(`${url.pathname} does not reference the previous reviewed commit`);
  }
  const staged = new URL(`../../upstream/${stagedName}`, import.meta.url);
  await writeFile(staged, source.replaceAll(previousCommit, commit), { mode: 0o600 });
  await rename(staged, url);
};

const stagedBaseline = new URL("../../upstream/.baseline.json.staged", import.meta.url);
await writeFile(stagedBaseline, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
await updateReviewedCommit(providersUrl, ".providers.yml.staged");
await updateReviewedCommit(componentsUrl, ".components.yml.staged");
await rename(stagedBaseline, baselineUrl);
console.log(`Accepted upstream CodexBar baseline ${commit}`);
