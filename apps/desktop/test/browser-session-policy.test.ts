import { describe, expect, it } from "vite-plus/test";

import {
  browserLoginDescriptor,
  exportableCookieHeader,
  isAllowedBrowserLoginNavigation,
} from "../src/main/browser-session-policy.ts";

describe("isolated browser session policy", () => {
  const descriptor = browserLoginDescriptor("t3chat");

  it("declares only explicit provider login surfaces", () => {
    expect(descriptor).toBeDefined();
    expect(browserLoginDescriptor("openai")).toBeUndefined();
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
});
