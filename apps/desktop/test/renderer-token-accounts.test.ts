import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

describe("renderer Codex token-account selection", () => {
  it("uses only the metadata roster and host-issued optimistic revision", async () => {
    const source = await readFile(new URL("../src/renderer/index.tsx", import.meta.url), "utf8");

    expect(source).toContain('selectedProviderFirstPartyId !== "codex"');
    expect(source).toContain('listTokenAccounts({ provider: "codex" })');
    expect(source).toContain("expectedRevision: previous.revision");
    expect(source).toContain("optimisticTokenAccountRoster(previous, accountId)");
    expect(source).toContain("optimisticRenameTokenAccountRoster(previous, accountId, label)");
    expect(source).toContain("optimisticRemoveTokenAccountRoster(previous, accountId)");
    expect(source).toContain(".renameTokenAccount({");
    expect(source).toContain(".removeTokenAccount({");
    expect(source).toContain("setTokenAccountRoster(undefined)");
    expect(source).toContain('localization.upstream("Label")');
    expect(source).toContain('localization.upstream("apply")');
    expect(source).toContain('localization.upstream("Remove")');
    expect(source).toContain("<TokenAccountSettings");
    expect(source).not.toContain("CODEX_ACCESS_TOKEN");
    expect(source).not.toContain("refresh_token");
    expect(source).not.toContain("ipcRenderer");
  });

  it("adds a visible keyboard focus ring to both settings selectors", async () => {
    const styles = await readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toContain("select:focus-visible");
    expect(styles).toContain("outline: 2px solid #5eead4");
  });
});
