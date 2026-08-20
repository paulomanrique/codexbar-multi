import { describe, expect, it } from "vite-plus/test";

import { grok, parseGrokGrpcWebResponse } from "../src/providers/grok.ts";
import type { ProviderBinaryResponse, ProviderContext } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");
const error = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

const frame = (body: Uint8Array, flags = 0): Uint8Array => {
  const result = new Uint8Array(5 + body.length);
  result[0] = flags;
  new DataView(result.buffer).setUint32(1, body.length, false);
  result.set(body, 5);
  return result;
};

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining === 0 ? byte : byte | 0x80);
  } while (remaining !== 0);
  return bytes;
};

const billingPayload = (usedPercent: number, resetEpoch: number): Uint8Array => {
  const value = new Uint8Array(4);
  new DataView(value.buffer).setFloat32(0, usedPercent, true);
  return new Uint8Array([0x0d, ...value, 0x18, ...varint(resetEpoch)]);
};

const context = (postBinary?: ProviderContext["http"]["postBinary"]): ProviderContext => ({
  settings: { get: () => undefined, getSecret: () => undefined },
  http: {
    get: async () => ({ status: 200, bodyText: "{}" }),
    getJSON: async () => ({ status: 200, bodyText: "{}", json: {} }),
    postJSON: async () => ({ status: 200, bodyText: "{}", json: {} }),
    ...(postBinary === undefined ? {} : { postBinary }),
  },
  browser: { cookieHeader: async () => "sso=fixture; sso-rw=fixture" },
  env: {},
  date: {
    now: () => now,
    nowMillis: () => now.getTime(),
    iso: (value) => new Date(value).toISOString(),
    unixSeconds: (value) => new Date(value * 1_000).toISOString(),
    unixMillis: (value) => new Date(value).toISOString(),
    nextDailyReset: () => "2026-08-21T00:00:00.000Z",
  },
  format: { number: String, usd: String, monthDay: () => "Aug 20" },
  pct: (used, limit) => (used / limit) * 100,
  amountFromPercent: (usedPercent, limit) => (usedPercent / 100) * limit,
  fail: {
    authenticationExpired: error("authentication-expired"),
    missingCredential: error("missing-credential"),
    permissionDenied: error("permission-denied"),
    rateLimited: error("rate-limited"),
    providerUnavailable: error("provider-unavailable"),
    parseFailure: error("parse-failure"),
    networkFailure: error("network-failure"),
    apiFailure: error("api-failure"),
  },
});

describe("Swift-derived Grok gRPC-web billing parity", () => {
  it("keeps the upstream Grok web descriptor and parses a framed protobuf response", async () => {
    const requests: Array<{
      url: string;
      options: Parameters<NonNullable<ProviderContext["http"]["postBinary"]>>[1];
    }> = [];
    const response: ProviderBinaryResponse = {
      status: 200,
      headers: { "content-type": "application/grpc-web+proto" },
      body: frame(billingPayload(55.5, 1_800_000_002)),
    };
    const snapshot = await grok.fetchUsage(
      context(async (url, options) => {
        requests.push({ url, options });
        return response;
      }),
    );
    expect(grok.id).toBe("grok.web");
    expect(grok.descriptor.endpoints).toEqual(["https://grok.com"]);
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 55.5, resetsAt: "2027-01-15T08:00:02.000Z" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
      options: {
        body: new Uint8Array([0, 0, 0, 0, 0]),
        timeoutSeconds: 15,
        headers: {
          Cookie: "sso=fixture; sso-rw=fixture",
          Origin: "https://grok.com",
          Referer: "https://grok.com/?_s=usage",
          Accept: "*/*",
          "Content-Type": "application/grpc-web+proto",
          "x-grpc-web": "1",
          "x-user-agent": "connect-es/2.1.1",
          "User-Agent": "CodexBar",
        },
      },
    });
  });

  it("accepts an unframed protobuf response and chooses billing field one over unrelated floats", () => {
    const unrelated = new Uint8Array(4);
    new DataView(unrelated.buffer).setFloat32(0, 7, true);
    const payload = new Uint8Array([0x4d, ...unrelated, ...billingPayload(42, 1_800_000_001)]);
    expect(parseGrokGrpcWebResponse(payload, now)).toMatchObject({ usedPercent: 42 });
  });

  it("rejects malformed frames and recognizes the Swift no-usage-yet zero-percent shape", () => {
    expect(() => parseGrokGrpcWebResponse(new Uint8Array([0, 0, 0, 0]), now)).toThrow(
      "no protobuf payload",
    );
    const noUsageYet = new Uint8Array([
      0x0a,
      0x02,
      0x30,
      0x01, // nested [1, 6] usage-period marker
      0x18,
      ...varint(1_800_000_004),
    ]);
    expect(parseGrokGrpcWebResponse(frame(noUsageYet), now)).toEqual({
      usedPercent: 0,
      resetsAt: "2027-01-15T08:00:04.000Z",
    });
  });

  it("retries one transient trailer deadline and maps credential trailers without exposing tokens", async () => {
    let attempts = 0;
    const snapshot = await grok.fetchUsage(
      context(async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: 200,
            headers: {},
            body: frame(
              new TextEncoder().encode("grpc-status: 4\r\ngrpc-message: deadline%20exceeded\r\n"),
              0x80,
            ),
          };
        }
        return { status: 200, headers: {}, body: frame(billingPayload(25, 1_800_000_003)) };
      }),
    );
    expect(attempts).toBe(2);
    expect(snapshot).toMatchObject({ primary: { usedPercent: 25 } });

    await expect(
      grok.fetchUsage(
        context(async () => ({
          status: 200,
          headers: { "grpc-status": "16", "grpc-message": "token%20expired" },
          body: new Uint8Array(),
        })),
      ),
    ).rejects.toThrow("authentication-expired: Grok billing rejected the web session.");
  });

  it("keeps team-billing and HTTP status failures distinct from authentication", async () => {
    await expect(
      grok.fetchUsage(
        context(async () => ({
          status: 200,
          headers: {},
          body: frame(
            new TextEncoder().encode("grpc-status: 9\r\ngrpc-message: No%20personal%20team\r\n"),
            0x80,
          ),
        })),
      ),
    ).rejects.toThrow("provider-unavailable: Grok team usage");

    for (const [status, kind] of [
      [401, "authentication-expired"],
      [429, "rate-limited"],
      [503, "provider-unavailable"],
    ] as const) {
      await expect(
        grok.fetchUsage(context(async () => ({ status, headers: {}, body: new Uint8Array() }))),
      ).rejects.toThrow(kind);
    }
  });

  it("fails closed when the host has not composed binary gRPC-web support", async () => {
    await expect(grok.fetchUsage(context())).rejects.toThrow("provider-unavailable");
  });
});
