import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { get, json, object } from "./_http.ts";

const clean = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value === "" ? undefined : value;
};

const requiredInt = (
  ctx: ProviderContext,
  payload: Readonly<Record<string, unknown>>,
  key: string,
): number => {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw ctx.fail.parseFailure(`ElevenLabs field ${key} must be an integer.`);
  }
  return value;
};

const optionalInt = (
  ctx: ProviderContext,
  payload: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw ctx.fail.parseFailure(`ElevenLabs field ${key} must be an integer or null.`);
  }
  return value;
};

const optionalString = (
  ctx: ProviderContext,
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw ctx.fail.parseFailure(`ElevenLabs field ${key} must be a string or null.`);
  }
  return value;
};

const validateOverage = (
  ctx: ProviderContext,
  payload: Readonly<Record<string, unknown>>,
): void => {
  const value = payload.current_overage;
  if (value === undefined || value === null) return;
  const overage = object(value);
  if (!overage) {
    throw ctx.fail.parseFailure("ElevenLabs field current_overage must be an object or null.");
  }
  optionalString(ctx, overage, "amount");
  optionalString(ctx, overage, "currency");
};

const capitalized = (value: string): string =>
  value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());

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
      { headers: { "xi-api-key": key, Accept: "application/json" }, timeoutSeconds: 15 },
    );
    if (response.status === 401 || response.status === 403) {
      throw ctx.fail.missingCredential("ElevenLabs rejected the API key.");
    }
    if (response.status !== 200) {
      throw ctx.fail.apiFailure(`ElevenLabs API returned HTTP ${response.status}.`);
    }
    const payload = object(json(ctx, "ElevenLabs", response));
    if (!payload) throw ctx.fail.parseFailure("ElevenLabs response must be an object.");
    const used = requiredInt(ctx, payload, "character_count");
    const limit = requiredInt(ctx, payload, "character_limit");
    const voiceUsed = optionalInt(ctx, payload, "voice_slots_used");
    const voiceLimit = optionalInt(ctx, payload, "voice_limit");
    const professionalVoiceUsed = optionalInt(ctx, payload, "professional_voice_slots_used");
    const professionalVoiceLimit = optionalInt(ctx, payload, "professional_voice_limit");
    const resetUnix = optionalInt(ctx, payload, "next_character_count_reset_unix");
    const tier = optionalString(ctx, payload, "tier");
    const status = optionalString(ctx, payload, "status");
    validateOverage(ctx, payload);
    const primary: Record<string, unknown> = {
      usedPercent: limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0,
      resetDescription: `${used.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} credits`,
    };
    if (resetUnix !== undefined) primary.resetsAt = ctx.date.unixSeconds(resetUnix);
    const extras: unknown[] = [];
    for (const [id, title, voiceCount, voiceCap] of [
      ["voice-slots", "Voice slots", voiceUsed, voiceLimit],
      ["professional-voices", "Professional voices", professionalVoiceUsed, professionalVoiceLimit],
    ] as const) {
      if (voiceCount !== undefined && voiceCap !== undefined && voiceCap > 0)
        extras.push({
          id,
          title,
          window: {
            usedPercent: Math.max(0, Math.min(100, (voiceCount / voiceCap) * 100)),
            resetDescription: `${voiceCount} / ${voiceCap}`,
          },
        });
    }
    const trimmedTier = tier?.trim();
    const displayTier = trimmedTier ? capitalized(trimmedTier) : undefined;
    const loginMethod = displayTier
      ? status !== undefined && status !== "" && status.toLowerCase() !== "active"
        ? `${displayTier} · ${status}`
        : displayTier
      : status;
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
