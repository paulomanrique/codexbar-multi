import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderFetchClassifiedError } from "../src/errors.ts";
import { RateWindow, UsageSnapshot } from "../src/usage.ts";

describe("schema contracts", () => {
  it("accepts Swift-compatible sparse rate windows", () => {
    const window = Schema.decodeUnknownSync(RateWindow)({ usedPercent: 12.5, windowMinutes: 300 });
    expect(window.usedPercent).toBe(12.5);
    expect(window.isSyntheticPlaceholder).toBeUndefined();
  });

  it("accepts a generic snapshot without provider credentials", () => {
    const snapshot = Schema.decodeUnknownSync(UsageSnapshot)({
      primary: { usedPercent: 1 },
      details: [],
      updatedAt: "2026-08-19T00:00:00Z",
    });
    expect(snapshot.details).toEqual([]);
  });

  it("preserves classified fetch errors", () => {
    const error = Schema.decodeUnknownSync(ProviderFetchClassifiedError)({
      kind: "rate-limited",
      message: "try later",
      retryAfterSeconds: 2,
    });
    expect(error.kind).toBe("rate-limited");
  });
});
