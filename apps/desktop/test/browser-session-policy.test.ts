import { describe, expect, it } from "vite-plus/test";

import {
  browserLoginDescriptor,
  browserLoginProviders,
  exportableCookieHeader,
  isAllowedBrowserLoginNavigation,
} from "../src/main/browser-session-policy.ts";

describe("isolated browser session policy", () => {
  const descriptor = browserLoginDescriptor("t3chat");

  it("declares explicit login surfaces for portable cookie-based providers only", () => {
    expect(descriptor).toBeDefined();
    expect(browserLoginDescriptor("openai")).toBeUndefined();
    expect(browserLoginProviders()).toEqual([
      "alibaba",
      "alibabatokenplan",
      "claude",
      "commandcode",
      "cursor",
      "kimi",
      "longcat",
      "mimo",
      "mistral",
      "notion",
      "ollama",
      "opencode",
      "opencodego",
      "qwencloud",
      "t3chat",
    ]);
    // These providers need an approved bearer, cURL capture, or browser
    // storage capability; they must fail closed until that capability exists.
    expect(browserLoginDescriptor("devin")).toBeUndefined();
    expect(browserLoginDescriptor("windsurf")).toBeUndefined();
    expect(browserLoginDescriptor("zoommate")).toBeUndefined();
    expect(browserLoginDescriptor("abacus")).toBeUndefined();
    expect(browserLoginDescriptor("factory")).toBeUndefined();
    expect(browserLoginDescriptor("sakana")).toBeUndefined();
    expect(browserLoginDescriptor("stepfun")).toBeUndefined();
  });

  it("accepts exact HTTPS login origins and rejects lookalikes or active schemes", () => {
    if (descriptor === undefined) throw new Error("missing fixture descriptor");
    expect(
      isAllowedBrowserLoginNavigation(descriptor, "https://accounts.google.com/o/oauth2/v2/auth"),
    ).toBe(true);
    expect(isAllowedBrowserLoginNavigation(descriptor, "https://t3.chat/settings")).toBe(true);
    expect(isAllowedBrowserLoginNavigation(descriptor, "https://t3.chat.evil.test/settings")).toBe(
      false,
    );
    expect(isAllowedBrowserLoginNavigation(descriptor, "http://t3.chat/settings")).toBe(false);
    expect(isAllowedBrowserLoginNavigation(descriptor, "javascript:alert(1)")).toBe(false);
    expect(isAllowedBrowserLoginNavigation(descriptor, "not a url")).toBe(false);
  });

  it("keeps every declared entrypoint and navigation origin HTTPS", () => {
    for (const provider of browserLoginProviders()) {
      const policy = browserLoginDescriptor(provider);
      if (policy === undefined) throw new Error(`missing ${provider} policy`);
      expect(isAllowedBrowserLoginNavigation(policy, policy.startUrl)).toBe(true);
      for (const origin of policy.allowedOrigins) {
        expect(new URL(origin).protocol).toBe("https:");
      }
    }
  });

  it("exports only allowlisted cookies with deterministic last-value wins semantics", () => {
    if (descriptor === undefined) throw new Error("missing fixture descriptor");
    expect(
      exportableCookieHeader(descriptor, [
        { name: "tracking", value: "must-not-leave-partition" },
        { name: "__session", value: "old" },
        { name: "__client_uat", value: "123" },
        { name: "__session", value: "current" },
      ]),
    ).toBe("__client_uat=123; __session=current");
    expect(exportableCookieHeader(descriptor, [{ name: "tracking", value: "private" }])).toBe(
      undefined,
    );
    expect(exportableCookieHeader(descriptor, [{ name: "__client_uat", value: "123" }])).toBe(
      undefined,
    );
  });

  it("supports only explicit rotated cookie families", () => {
    const mistral = browserLoginDescriptor("mistral");
    if (mistral === undefined) throw new Error("missing Mistral descriptor");
    expect(
      exportableCookieHeader(mistral, [
        { name: "ory_session_abcdef", value: "session" },
        { name: "csrftoken", value: "csrf" },
        { name: "ory_session_attacker", value: "bad" },
        { name: "analytics", value: "never" },
      ]),
    ).toBe("csrftoken=csrf; ory_session_abcdef=session; ory_session_attacker=bad");
    expect(exportableCookieHeader(mistral, [{ name: "csrftoken", value: "csrf" }])).toBe(undefined);
  });

  it("rejects header delimiters, control characters, and oversized cookie values", () => {
    if (descriptor === undefined) throw new Error("missing fixture descriptor");
    expect(
      exportableCookieHeader(descriptor, [{ name: "__session", value: "safe\r\ninjected" }]),
    ).toBeUndefined();
    expect(
      exportableCookieHeader(descriptor, [{ name: "__session", value: "safe;injected" }]),
    ).toBeUndefined();
    expect(
      exportableCookieHeader(descriptor, [{ name: "__session", value: "x".repeat(4_097) }]),
    ).toBeUndefined();
  });

  it("keeps the upstream OpenCode auth-only cookie boundary", () => {
    const opencode = browserLoginDescriptor("opencode");
    if (opencode === undefined) throw new Error("missing OpenCode descriptor");
    expect(
      exportableCookieHeader(opencode, [
        { name: "provider", value: "google" },
        { name: "auth", value: "session" },
        { name: "theme", value: "dark" },
        { name: "__Host-auth", value: "host-session" },
      ]),
    ).toBe("__Host-auth=host-session; auth=session");
  });
});
