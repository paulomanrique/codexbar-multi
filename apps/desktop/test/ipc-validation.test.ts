import { describe, expect, it } from "vite-plus/test";

import { decodeExactDesktopRecord } from "../src/main/ipc-validation.ts";

describe("desktop exact IPC validation", () => {
  it("accepts only declared own fields before schema decoding", async () => {
    const decode = async (value: unknown) => value as { readonly accountId: string };
    await expect(
      decodeExactDesktopRecord({ accountId: "opaque" }, ["accountId"], decode),
    ).resolves.toEqual({ accountId: "opaque" });
    await expect(
      decodeExactDesktopRecord(
        { accountId: "opaque", cookieHeader: "secret" },
        ["accountId"],
        decode,
      ),
    ).rejects.toThrow("unsupported fields");
    await expect(decodeExactDesktopRecord([], ["accountId"], decode)).rejects.toThrow("object");
    await expect(decodeExactDesktopRecord(null, ["accountId"], decode)).rejects.toThrow("object");
  });
});
