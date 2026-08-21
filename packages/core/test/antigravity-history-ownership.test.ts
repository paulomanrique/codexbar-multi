import type { UsageSnapshot } from "@codexbar/contracts";
import { describe, expect, it } from "vite-plus/test";
import { antigravityPlanUtilizationIdentityAccountKey } from "../src/index.ts";

const snapshot = (identity: UsageSnapshot["identity"]): UsageSnapshot => ({
  details: [],
  updatedAt: "2026-08-21T12:00:00Z",
  ...(identity === undefined ? {} : { identity }),
});

describe("Antigravity plan-utilization ownership (Swift parity)", () => {
  it("prefers normalized email and keeps the provider in the hash domain", () => {
    expect(
      antigravityPlanUtilizationIdentityAccountKey(
        snapshot({
          providerId: "antigravity",
          accountEmail: " PERSON@Example.com ",
          accountOrganization: "Ignored Org",
        }),
      ),
    ).toBe("75d0b167bd6f71dd9568ea49a94f1563284f6e95c8ca2dad095fdc7ac9773cfc");
  });

  it("falls back to normalized organization", () => {
    expect(
      antigravityPlanUtilizationIdentityAccountKey(
        snapshot({ providerId: "antigravity", accountOrganization: " Team Org " }),
      ),
    ).toBe("0047654fe46965fe638f6be0895fe0ccb0fd9c192fb715679289976862775c39");
  });

  it("rejects identities owned by another provider or without an owner", () => {
    expect(
      antigravityPlanUtilizationIdentityAccountKey(
        snapshot({ providerId: "claude", accountEmail: "person@example.com" }),
      ),
    ).toBeUndefined();
    expect(
      antigravityPlanUtilizationIdentityAccountKey(snapshot({ providerId: "antigravity" })),
    ).toBeUndefined();
  });
});
