#!/usr/bin/env node
import { makeNodeCLIProviderRuntime, nodeIO, runCLI } from "./runner.ts";

const runtime = makeNodeCLIProviderRuntime();
const cancellation = new AbortController();
const abort = (): void => cancellation.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
  const result = await runCLI({
    argv: process.argv.slice(2),
    io: nodeIO,
    runtime,
    signal: cancellation.signal,
  });
  process.exitCode = result.exitCode;
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  await runtime.dispose?.();
}
