import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "elevenlabs",
  name: "ElevenLabs",
  endpoints: ["https://api.elevenlabs.io"],
  auth: { type: "x-api-key", secret: "ELEVENLABS_API_KEY" },
  settings: [
    { key: "ELEVENLABS_API_KEY", title: "API key", type: "secure" },
    { key: "XI_API_KEY", title: "API key (legacy alias)", type: "secure" },
    { key: "ELEVENLABS_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      ctx.settings.getSecret("ELEVENLABS_API_KEY") ||
      ctx.settings.get("ELEVENLABS_API_KEY") ||
      ctx.settings.getSecret("XI_API_KEY") ||
      ctx.settings.get("XI_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing ElevenLabs API key.");
    const configured = ctx.settings.get("ELEVENLABS_API_URL");
    const root = (configured || "https://api.elevenlabs.io").replace(/\/+$/, "");
    const response = await get(
      ctx,
      `${root.endsWith("/v1") ? root : `${root}/v1`}/user/subscription`,
      { headers: { "xi-api-key": key, Accept: "application/json" } },
    );
    status(ctx, "ElevenLabs", response);
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
