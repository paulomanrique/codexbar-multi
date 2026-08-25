import { describe, expect, it } from "vite-plus/test";
import { normalizeEndpoint, normalizeHttpRequest } from "../src/index.ts";

describe("normalizeEndpoint", () => {
  it("normalizes a host without an explicit scheme to HTTPS", () => {
    expect(normalizeEndpoint("api.example.com/v1")?.href).toBe("https://api.example.com/v1");
    expect(normalizeEndpoint("api.example.com:8443/v1")?.href).toBe(
      "https://api.example.com:8443/v1",
    );
  });

  it("rejects credential-bearing, encoded-authority, and public HTTP endpoints", () => {
    expect(normalizeEndpoint("https://token@example.com")).toBeUndefined();
    expect(normalizeEndpoint("https://example.com%2f@evil.test")).toBeUndefined();
    expect(normalizeEndpoint("http://example.com")).toBeUndefined();
  });

  it("allows HTTP only for the explicitly selected private-network policy", () => {
    expect(
      normalizeEndpoint("http://127.0.0.1:11434", { transport: "loopback-http" })?.hostname,
    ).toBe("127.0.0.1");
    expect(
      normalizeEndpoint("http://192.168.1.10", { transport: "private-network-http" })?.hostname,
    ).toBe("192.168.1.10");
    expect(
      normalizeEndpoint("http://192.168.1.10", { transport: "loopback-http" }),
    ).toBeUndefined();
    expect(normalizeEndpoint("http://[::1]:4000", { transport: "loopback-http" })?.hostname).toBe(
      "[::1]",
    );
    expect(
      normalizeEndpoint("http://[fd12:3456::1]", { transport: "private-network-http" })?.hostname,
    ).toBe("[fd12:3456::1]");
    expect(
      normalizeEndpoint("http://[fe80::1]", { transport: "private-network-http" })?.hostname,
    ).toBe("[fe80::1]");
    expect(
      normalizeEndpoint("http://[2001:db8::1]", { transport: "private-network-http" }),
    ).toBeUndefined();
    expect(
      normalizeEndpoint("http://proxy.local.:4000", { transport: "private-network-http" })
        ?.hostname,
    ).toBe("proxy.local.");
  });

  it("applies the HTTP method and timeout policy after endpoint normalization", () => {
    const policy = { endpoint: {}, allowedMethods: new Set(["GET"]), maximumTimeoutMs: 500 };
    expect(normalizeHttpRequest({ url: "api.example.com", timeoutMs: 500 }, policy)?.url).toBe(
      "https://api.example.com/",
    );
    expect(
      normalizeHttpRequest({ url: "api.example.com", method: "POST" }, policy),
    ).toBeUndefined();
    expect(
      normalizeHttpRequest({ url: "api.example.com", timeoutMs: 501 }, policy),
    ).toBeUndefined();
  });
});
