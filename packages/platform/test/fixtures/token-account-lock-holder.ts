import { Effect } from "effect";
import { makeNodeTokenAccountMigrationLock } from "../../src/node-token-account-migration-lock.ts";

const lockPath = process.argv[2];
const holdMs = Number.parseInt(process.argv[3] ?? "5000", 10);

if (lockPath === undefined) {
  throw new Error("lock path argument is required");
}

const lock = makeNodeTokenAccountMigrationLock({
  lockPath,
  acquireTimeoutMs: 2_000,
  retryDelayMs: 10,
});

await Effect.runPromise(
  lock.runExclusive(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.stdout.write("locked\n");
          setTimeout(resolve, holdMs);
        }),
    ),
  ),
);
