import { describe, expect, it } from "vite-plus/test";
import { normalizeEndpoint, normalizeHttpRequest } from "../src/index.ts";

describe("normalizeEndpoint", () => {
  it("normalizes a host without an explicit scheme to HTTPS", () => {
    expect(normalizeEndpoint("api.example.com/v1")?.href).toBe("https://api.example.com/v1");
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
