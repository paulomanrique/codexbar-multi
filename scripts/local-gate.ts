import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageManager = process.env.npm_execpath;
if (packageManager === undefined || packageManager === "") {
  throw new Error("local-gate must be launched through pnpm");
}

for (const script of ["fmt:check", "check", "typecheck", "test"] as const) {
  const result = spawnSync(process.execPath, [packageManager, script], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) throw new Error(`${script} terminated by ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
