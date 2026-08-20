import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  makeNativeCredentialStore,
  makeNodePrivateDirectoryRestriction,
  makeNodePrivateFileRestriction,
  makeNodePrivateFileStore,
} from "../src/node.ts";

const expectOwnerOnlyFileMode = async (path: string): Promise<void> => {
  // NTFS permissions are represented by DACLs; Node reports a synthetic 0666
  // mode even when the Windows ACL has been locked to the current SID.
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
};

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
      await expectOwnerOnlyFileMode(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates at most one file under concurrent no-clobber claims", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-private-store-create-"));
    const path = join(directory, "imported-config.json");
    try {
      const store = makeNodePrivateFileStore();
      const candidates = Array.from({ length: 32 }, (_, index) =>
        new TextEncoder().encode(`candidate-${index}\n`),
      );
      const claims = await Promise.all(
        candidates.map((content) => Effect.runPromise(store.writeAtomicIfAbsent(path, content))),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      const winner = claims.findIndex(Boolean);
      expect(winner).toBeGreaterThanOrEqual(0);
      await expect(readFile(path)).resolves.toEqual(Buffer.from(candidates[winner]!));
      await expectOwnerOnlyFileMode(path);

      await expect(
        Effect.runPromise(store.writeAtomicIfAbsent(path, new TextEncoder().encode("overwrite\n"))),
      ).resolves.toBe(false);
      await expect(readFile(path, "utf8")).resolves.toBe(`candidate-${winner}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies an injected native ACL policy before publishing the staged inode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-private-store-acl-"));
    const path = join(directory, "credentials.json");
    const restricted: string[] = [];
    try {
      const store = makeNodePrivateFileStore({
        restrictFile: async (candidate) => {
          restricted.push(candidate);
        },
      });
      await Effect.runPromise(store.writeAtomic(path, new TextEncoder().encode("secret\n")));
      expect(restricted).toHaveLength(2);
      expect(restricted[0]).toContain(directory);
      expect(restricted[0]).not.toBe(path);
      expect(restricted[1]).toBe(path);
      await expect(readFile(path, "utf8")).resolves.toBe("secret\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not publish a file when native ACL restriction fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-private-store-acl-failure-"));
    const path = join(directory, "credentials.json");
    try {
      const store = makeNodePrivateFileStore({
        restrictFile: async () => {
          throw new Error("ACL unavailable");
        },
      });
      await expect(
        Effect.runPromise(store.writeAtomic(path, new TextEncoder().encode("secret\n"))),
      ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "write private file" });
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes newly published content when its final ACL cannot be restricted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-private-store-final-acl-failure-"));
    const path = join(directory, "credentials.json");
    let calls = 0;
    try {
      const store = makeNodePrivateFileStore({
        restrictFile: async () => {
          calls += 1;
          if (calls === 2) throw new Error("final ACL unavailable");
        },
      });
      await expect(
        Effect.runPromise(store.writeAtomic(path, new TextEncoder().encode("secret\n"))),
      ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "write private file" });
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores an existing private file when final ACL restriction fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-private-store-final-acl-rollback-"));
    const path = join(directory, "settings.json");
    let pathRestrictions = 0;
    try {
      await Effect.runPromise(
        makeNodePrivateFileStore().writeAtomic(path, new TextEncoder().encode("previous\n")),
      );
      const store = makeNodePrivateFileStore({
        restrictFile: async (candidate) => {
          if (candidate !== path) return;
          pathRestrictions += 1;
          // Existing target, published replacement, restored target.
          if (pathRestrictions === 2) throw new Error("final ACL unavailable");
        },
      });
      await expect(
        Effect.runPromise(store.writeAtomic(path, new TextEncoder().encode("replacement\n"))),
      ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "write private file" });
      await expect(readFile(path, "utf8")).resolves.toBe("previous\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a current-user Windows SID DACL for files and directories without a shell", async () => {
    const grants: Array<{ path: string; sid: string }> = [];
    let sidReads = 0;
    const windowsAcl = {
      currentUserSid: async () => {
        sidReads += 1;
        return "S-1-5-21-101-202-303-1001";
      },
      grantCurrentUserFullControl: async (path: string, sid: string) => {
        grants.push({ path, sid });
      },
    };
    const options = { platform: "win32" as const, windowsAcl };
    const restrictFile = makeNodePrivateFileRestriction(options);
    const restrictDirectory = makeNodePrivateDirectoryRestriction(options);

    await restrictFile("C:\\data\\credentials.json");
    await restrictFile("C:\\data\\settings.json");
    await restrictDirectory("C:\\data");

    expect(sidReads).toBe(2);
    expect(grants).toEqual([
      { path: "C:\\data\\credentials.json", sid: "S-1-5-21-101-202-303-1001" },
      { path: "C:\\data\\settings.json", sid: "S-1-5-21-101-202-303-1001" },
      { path: "C:\\data", sid: "S-1-5-21-101-202-303-1001" },
    ]);
  });

  it("fails closed when the Windows SID adapter returns invalid data", async () => {
    const grantCurrentUserFullControl = async (): Promise<void> => {
      throw new Error("must not grant an invalid SID");
    };
    const restrict = makeNodePrivateFileRestriction({
      platform: "win32",
      windowsAcl: { currentUserSid: async () => "not-a-sid", grantCurrentUserFullControl },
    });
    await expect(restrict("C:\\data\\credentials.json")).rejects.toThrow("SID is invalid");
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
