import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { MemoryPrivateFileStore, PrivateFileStore } from "../src/index.ts";

describe("PrivateFileStore atomic-write contract", () => {
  it("publishes a copy of the complete input rather than a mutable caller buffer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const program = Effect.gen(function* () {
      const files = yield* PrivateFileStore;
      yield* files.writeAtomic("usage.json", bytes);
      bytes[0] = 9;
      return yield* files.read("usage.json");
    }).pipe(Effect.provide(MemoryPrivateFileStore));
    await expect(Effect.runPromise(program)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
