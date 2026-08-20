import { describe, expect, it } from "vite-plus/test";

import { clawrouter } from "../src/providers/clawrouter.ts";
import { clinepass } from "../src/providers/clinepass.ts";
import { crof } from "../src/providers/crof.ts";
import { openrouter } from "../src/providers/openrouter.ts";
import { poe } from "../src/providers/poe.ts";
import { sub2api } from "../src/providers/sub2api.ts";
import { synthetic } from "../src/providers/synthetic.ts";
import { venice } from "../src/providers/venice.ts";
import { xai } from "../src/providers/xai.ts";
import { zai } from "../src/providers/zai.ts";

const providers = [
  clawrouter,
  clinepass,
  crof,
  openrouter,
  poe,
  sub2api,
  synthetic,
  venice,
  xai,
  zai,
] as const;

const expected = [
  ["clawrouter", "clawrouter.api"],
  ["clinepass", "clinepass.api"],
  ["crof", "crof.api"],
  ["openrouter", "openrouter.api"],
  ["poe", "poe.api"],
  ["sub2api", "sub2api.api"],
  ["synthetic", "synthetic.api"],
  ["venice", "venice.api"],
  ["xai", "xai.api"],
  ["zai", "zai.api"],
] as const;

describe("first-party providers derived from upstream plugins", () => {
  it("preserves every upstream ID and strategy ID without collisions", () => {
    expect(providers.map((provider) => [provider.descriptor.id, provider.id])).toEqual(expected);
    expect(new Set(providers.map((provider) => provider.descriptor.id))).toHaveLength(10);
  });

  it("keeps credentials and endpoints declarative at the provider boundary", () => {
    for (const provider of providers) {
      expect(provider.descriptor.status).toBe("partial");
      expect(provider.descriptor.strategy?.id).toBe(provider.id);
      expect(provider.descriptor.settings?.some((setting) => setting.type === "secure")).toBe(true);
      expect(provider.descriptor.endpoints).not.toHaveLength(0);
      expect(provider.descriptor.auth?.type).toBe("bearer");
    }
    expect(sub2api.descriptor.endpoints).toContainEqual({
      setting: "SUB2API_BASE_URL",
      policy: "https-or-loopback-http",
    });
    expect(openrouter.descriptor.endpoints).toContainEqual({
      setting: "OPENROUTER_API_URL",
      policy: "https",
    });
  });
});
