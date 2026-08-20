import { makeNodeCLIProviderRuntime, nodeIO, runCLI } from "./runner.ts";

export const runSeaCLI = async () => {
  const result = await runCLI({
    argv: process.argv.slice(2),
    io: nodeIO,
    runtime: makeNodeCLIProviderRuntime(),
  });
  process.exitCode = result.exitCode;
};
