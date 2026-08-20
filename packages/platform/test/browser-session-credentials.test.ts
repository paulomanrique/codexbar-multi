import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeCredentialBrowserSessions } from "../src/node.ts";

describe("browser session credential domain isolation", () => {
  it("returns only the cookie header stored for the requested domain", async () => {
    const sessions = makeCredentialBrowserSessions({
      read: () =>
        Effect.succeed(
          JSON.stringify({
            version: 1,
            provider: "t3chat",
            accountId: "default",
            cookieHeaders: {
              "t3.chat": "root=session-root",
              "www.t3.chat": "www=session-www",
            },
          }),
        ),
      write: () => Effect.void,
      remove: () => Effect.void,
    });

    await expect(Effect.runPromise(sessions.cookieHeader("t3chat", "t3.chat"))).resolves.toBe(
      "root=session-root",
    );
    await expect(Effect.runPromise(sessions.cookieHeader("t3chat", "www.t3.chat"))).resolves.toBe(
      "www=session-www",
    );
    await expect(
      Effect.runPromise(sessions.cookieHeader("t3chat", "accounts.google.com")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
  });

  it("rejects the legacy aggregate cookie shape instead of widening its domain", async () => {
    const sessions = makeCredentialBrowserSessions({
      read: () => Effect.succeed(JSON.stringify({ cookieHeader: "session=legacy" })),
      write: () => Effect.void,
      remove: () => Effect.void,
    });
    await expect(
      Effect.runPromise(sessions.cookieHeader("t3chat", "t3.chat")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
  });
});
