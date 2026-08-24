import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("converts Windows file URLs to drive-absolute paths on every host", () => {
  const directoryUrl = new URL("../", "file:///C:/Users/test/repo/scripts/check-architecture.ts");
  const root = fileURLToPath(directoryUrl, { windows: true });

  assert.equal(directoryUrl.pathname, "/C:/Users/test/repo/");
  assert.equal(root, "C:\\Users\\test\\repo\\");
  assert.equal(win32.join(root, "packages/core"), "C:\\Users\\test\\repo\\packages\\core");
});

test("keeps the architecture gate on canonical URL conversion", async () => {
  const source = await readFile(new URL("./check-architecture.ts", import.meta.url), "utf8");

  assert.match(source, /const repositoryRoot\s*=\s*fileURLToPath\s*\(\s*new URL\(/);
  assert.doesNotMatch(source, /const repositoryRoot\s*=.*\.pathname/);
});

test("keeps production composition roots on the token account vault wrapper", async () => {
  const source = await readFile(new URL("./check-architecture.ts", import.meta.url), "utf8");

  assert.match(source, /apps\/desktop\/src\/main\/index\.ts/);
  assert.match(source, /apps\/cli\/src\/runner\.ts/);
  assert.match(source, /makeTokenAccountVaultConfigRepository/);
  assert.match(source, /selectedFirstPartyAccountFromConfig/);
  assert.match(source, /selectedClaudeHistoryBindingFromConfig/);
});
