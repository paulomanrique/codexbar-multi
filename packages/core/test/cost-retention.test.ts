import { describe, expect, it } from "vite-plus/test";
import { assertUsageRecordRetentionRequest } from "../src/cost-retention.ts";

describe("usage record retention contract", () => {
  it("uses a non-negative safe-integer, exclusive boundary", () => {
    expect(() => assertUsageRecordRetentionRequest({ before: 0 })).not.toThrow();
    expect(() => assertUsageRecordRetentionRequest({ before: 1.5 })).toThrow(
      "before must be a non-negative safe integer",
    );
    expect(() => assertUsageRecordRetentionRequest({ before: -1 })).toThrow(
      "before must be a non-negative safe integer",
    );
    expect(() =>
      assertUsageRecordRetentionRequest({ before: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow("before must be a non-negative safe integer");
  });
});
