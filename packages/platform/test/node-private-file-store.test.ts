import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeNativeCredentialStore, makeNodePrivateFileStore } from "../src/node.ts";

describe("Node private file store", () => {
  it("replaces a target atomically and leaves no partial caller buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-private-store-"));
    const path = join(directory, "credentials.json");
    try {
      const store = makeNodePrivateFileStore();
      const input = new Uint8Array([1, 2, 3]);
      await Effect.runPromise(store.writeAtomic(path, input));
      input[0] = 9;
      await expect(readFile(path)).resolves.toEqual(Buffer.from([1, 2, 3]));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("native credential store adapter", () => {
  it("keeps credential values behind the keyring contract", async () => {
    const secrets = new Map<string, string>();
    const store = makeNativeCredentialStore("test-service", (_service, key) => ({
      getPassword: () => secrets.get(key) ?? null,
      setPassword: (value) => {
        secrets.set(key, value);
      },
      deletePassword: () => secrets.delete(key),
    }));
    await Effect.runPromise(store.write("provider/account", "secret"));
    await expect(Effect.runPromise(store.read("provider/account"))).resolves.toBe("secret");
    await Effect.runPromise(store.remove("provider/account"));
    await expect(Effect.runPromise(store.read("provider/account"))).resolves.toBeUndefined();
  });
});
