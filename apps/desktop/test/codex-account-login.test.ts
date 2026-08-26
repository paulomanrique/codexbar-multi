import { describe, expect, it } from "vite-plus/test";
import { DesktopCodexAccountLoginController } from "../src/main/codex-account-login.ts";

const roster = {
  provider: "codex" as const,
  accounts: [{ id: "host-id", label: "person@example.com", addedAt: 1 }],
  activeIndex: 0,
  selectionAvailable: true,
  revision: "a".repeat(64),
};

describe("desktop Codex account login controller", () => {
  it("publishes host-read auth material and returns only the metadata roster", async () => {
    const publications: unknown[] = [];
    let cleaned = false;
    const controller = new DesktopCodexAccountLoginController({
      cleanupStaleHomes: async () => {
        cleaned = true;
      },
      login: async () => ({
        credentialJson: "secret-auth-json",
        credential: { accessToken: "secret-access", accountId: "provider-account" },
        email: "person@example.com",
      }),
      publish: async (request) => {
        publications.push(request);
      },
      list: async () => roster,
      createAccountId: () => "host-id",
      now: () => 1_000,
    });

    await controller.initialize();
    const result = await controller.start();

    expect(cleaned).toBe(true);
    expect(publications).toEqual([
      {
        accountId: "host-id",
        label: "person@example.com",
        credentialJson: "secret-auth-json",
        externalIdentifier: "provider-account",
        addedAt: 1,
      },
    ]);
    expect(result).toEqual(roster);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects overlapping logins and lets cancellation abort the host process", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveLogin: (() => void) | undefined;
    const controller = new DesktopCodexAccountLoginController({
      cleanupStaleHomes: async () => undefined,
      login: (signal) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          resolveLogin = () => reject(new Error("cancelled"));
          signal.addEventListener("abort", () => resolveLogin?.(), { once: true });
        });
      },
      publish: async () => undefined,
      list: async () => roster,
      createAccountId: () => "host-id",
      now: () => 1_000,
    });

    const first = controller.start();
    await expect(controller.start()).rejects.toThrow("already running");
    controller.cancel();

    expect(observedSignal?.aborted).toBe(true);
    await expect(first).rejects.toThrow("did not complete");
  });
});
