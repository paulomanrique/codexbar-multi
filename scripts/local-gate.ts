import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url).pathname;
for (const [command, args] of [
  ["pnpm", ["fmt:check"]],
  ["pnpm", ["check"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["test"]],
] as const) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
