import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { date, get, json, number, object, string } from "./_http.ts";

const clean = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value === "" ? undefined : value;
};

const definition: ProviderDefinition = {
  id: "elevenlabs",
  name: "ElevenLabs",
  endpoints: ["https://api.elevenlabs.io", { setting: "ELEVENLABS_API_URL", policy: "https" }],
  settings: [
    { key: "ELEVENLABS_API_KEY", title: "API key", type: "secure" },
    { key: "XI_API_KEY", title: "API key (legacy alias)", type: "secure" },
    { key: "ELEVENLABS_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      clean(ctx.settings.getSecret("ELEVENLABS_API_KEY")) ??
      clean(ctx.settings.get("ELEVENLABS_API_KEY")) ??
      clean(ctx.settings.getSecret("XI_API_KEY")) ??
      clean(ctx.settings.get("XI_API_KEY"));
    if (!key) throw ctx.fail.missingCredential("Missing ElevenLabs API key.");
    const configured = clean(ctx.settings.get("ELEVENLABS_API_URL"));
    const endpoint = normalizeEndpoint(configured ?? "https://api.elevenlabs.io");
    if (endpoint === undefined) {
      throw ctx.fail.apiFailure(
        "ElevenLabs endpoint override ELEVENLABS_API_URL must use HTTPS or a bare host.",
      );
    }
    const root = endpoint.href.replace(/\/+$/u, "");
    const response = await get(
      ctx,
      `${root.endsWith("/v1") ? root : `${root}/v1`}/user/subscription`,
      { headers: { "xi-api-key": key, Accept: "application/json" } },
    );
    if (response.status === 401 || response.status === 403) {
      throw ctx.fail.missingCredential("ElevenLabs rejected the API key.");
    }
    if (response.status !== 200) {
      throw ctx.fail.apiFailure(`ElevenLabs API returned HTTP ${response.status}.`);
    }
    const payload = object(json(ctx, "ElevenLabs", response));
    if (!payload) throw ctx.fail.parseFailure("ElevenLabs response must be an object.");
    const used = number(payload.character_count);
    const limit = number(payload.character_limit);
    if (used === undefined || limit === undefined)
      throw ctx.fail.parseFailure("ElevenLabs character quota is invalid.");
    const primary: Record<string, unknown> = {
      usedPercent: limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0,
      resetDescription: `${used.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} credits`,
    };
    const reset = date(payload.next_character_count_reset_unix, ctx);
    if (reset) primary.resetsAt = reset;
    const extras: unknown[] = [];
    for (const [id, title, usedKey, limitKey] of [
      ["voice-slots", "Voice slots", "voice_slots_used", "voice_limit"],
      [
        "professional-voices",
        "Professional voices",
        "professional_voice_slots_used",
        "professional_voice_limit",
      ],
    ] as const) {
      const u = number(payload[usedKey]);
      const l = number(payload[limitKey]);
      if (u !== undefined && l !== undefined && l > 0)
        extras.push({
          id,
          title,
          window: {
            usedPercent: Math.max(0, Math.min(100, (u / l) * 100)),
            resetDescription: `${u} / ${l}`,
          },
        });
    }
    const tier = string(payload.tier);
    const displayTier = tier
      ? tier.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
      : string(payload.status);
    const statusValue = string(payload.status);
    const loginMethod =
      displayTier && statusValue && statusValue.toLowerCase() !== "active"
        ? `${displayTier} · ${statusValue}`
        : displayTier;
    return {
      primary,
      identity: { loginMethod },
      ...(extras.length ? { extraRateWindows: extras } : {}),
    };
  },
};
const strategy: ProviderStrategy = {
  id: "elevenlabs.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const elevenlabs: FirstPartyProvider = { ...strategy, descriptor };
