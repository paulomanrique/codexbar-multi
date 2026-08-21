import { makeNodeCLIProviderRuntime, nodeIO, runCLI } from "./runner.ts";

export const runSeaCLI = async () => {
  const runtime = makeNodeCLIProviderRuntime();
  try {
    const result = await runCLI({
      argv: process.argv.slice(2),
      io: nodeIO,
      runtime,
    });
    process.exitCode = result.exitCode;
  } finally {
    await runtime.dispose?.();
  }
};
