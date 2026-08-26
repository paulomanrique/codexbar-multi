export type MiniMaxJSON =
  | null
  | boolean
  | number
  | string
  | readonly MiniMaxJSON[]
  | { readonly [key: string]: MiniMaxJSON };

export type MiniMaxJSONRecord = { readonly [key: string]: MiniMaxJSON };

export interface MiniMaxHTMLTextFallback {
  readonly plan_name?: string;
  readonly available_prompts?: number;
  readonly window_minutes?: number;
  readonly used_percent?: number;
  readonly reset_in_seconds?: number;
  readonly resets_at_epoch_ms?: number;
}

export type MiniMaxHTMLParseResult =
  | {
      readonly source: "next-data";
      readonly payload: MiniMaxJSONRecord;
      readonly signedOut: false;
    }
  | {
      readonly source: "text";
      readonly fallback: MiniMaxHTMLTextFallback;
      readonly signedOut: false;
    };

export const maximumMiniMaxHTMLBytes = 1024 * 1024;
const maximumNextDataBytes = 256 * 1024;
const maximumJSONDepth = 48;
const maximumJSONNodes = 5000;
const textEncoder = new TextEncoder();

const byteLength = (value: string): number => textEncoder.encode(value).byteLength;

const boundedHTML = (html: string): string | undefined =>
  byteLength(html) <= maximumMiniMaxHTMLBytes ? html : undefined;

const trim = (value: string | undefined): string | undefined => {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
};

const capture = (pattern: RegExp, text: string, index = 1): string | undefined =>
  trim(pattern.exec(text)?.[index]);

const visibleText = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

export const looksMiniMaxHTMLSignedOut = (html: string): boolean => {
  const bounded = boundedHTML(html);
  if (!bounded) return false;
  const lower = visibleText(bounded).toLowerCase();
  return (
    lower.includes("sign in") ||
    lower.includes("log in") ||
    lower.includes("登录") ||
    lower.includes("登入")
  );
};

const nextDataContent = (html: string): string | undefined => {
  const bounded = boundedHTML(html);
  if (!bounded) return undefined;
  const lower = bounded.toLowerCase();
  const idIndex =
    lower.indexOf('id="__next_data__"') >= 0
      ? lower.indexOf('id="__next_data__"')
      : lower.indexOf("id='__next_data__'");
  if (idIndex < 0) return undefined;
  const openTagEnd = bounded.indexOf(">", idIndex);
  if (openTagEnd < 0) return undefined;
  const contentStart = openTagEnd + 1;
  const searchEnd = Math.min(bounded.length, contentStart + maximumNextDataBytes);
  const closeIndex = lower.indexOf("</script>", contentStart);
  if (closeIndex < 0 || closeIndex > searchEnd) return undefined;
  return trim(bounded.slice(contentStart, closeIndex));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJSONRecord = (value: MiniMaxJSON): value is MiniMaxJSONRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const camelToSnake = (key: string): string =>
  key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const normalizeJSONKeys = (value: unknown, depth = 0): MiniMaxJSON => {
  if (depth > maximumJSONDepth) return null;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, maximumJSONNodes).map((item) => normalizeJSONKeys(item, depth + 1));
  }
  if (!isRecord(value)) return null;
  const normalized: Record<string, MiniMaxJSON> = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[camelToSnake(key)] = normalizeJSONKeys(child, depth + 1);
  }
  return normalized;
};

const findCodingPlanPayload = (root: unknown): Record<string, unknown> | undefined => {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    nodes += 1;
    if (nodes > maximumJSONNodes || frame.depth > maximumJSONDepth) return undefined;
    const { value, depth } = frame;
    if (isRecord(value)) {
      if ("model_remains" in value || "modelRemains" in value) return value;
      const children = Object.values(value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ value: children[index], depth: depth + 1 });
      }
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: depth + 1 });
      }
    }
  }
  return undefined;
};

export const extractMiniMaxNextDataPayload = (html: string): MiniMaxJSONRecord | undefined => {
  const content = nextDataContent(html);
  if (!content) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const payload = findCodingPlanPayload(parsed);
  if (!payload) return undefined;
  const normalized = normalizeJSONKeys(payload);
  return isJSONRecord(normalized) ? normalized : undefined;
};

const minutesFrom = (value: number, unit: string): number => {
  const lower = unit.toLowerCase();
  if (lower.startsWith("d")) return Math.round(value * 24 * 60);
  if (lower.startsWith("h")) return Math.round(value * 60);
  return Math.round(value);
};

const secondsFrom = (value: number, unit: string): number => {
  const lower = unit.toLowerCase();
  if (lower.startsWith("d")) return Math.round(value * 24 * 60 * 60);
  if (lower.startsWith("h")) return Math.round(value * 60 * 60);
  if (lower.startsWith("m")) return Math.round(value * 60);
  return Math.round(value);
};

const parseAvailableUsage = (
  text: string,
): Pick<MiniMaxHTMLTextFallback, "available_prompts" | "window_minutes"> => {
  const match =
    /available\s+usage[:\s]*([0-9][0-9,]*)\s*prompts?\s*\/\s*([0-9]+(?:\.[0-9]+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|d)/iu.exec(
      text,
    );
  const rawPrompts = match?.[1];
  const rawDuration = match?.[2];
  const rawUnit = match?.[3];
  if (!rawPrompts || !rawDuration || !rawUnit) return {};
  const prompts = Number.parseInt(rawPrompts.replace(/,/gu, ""), 10);
  const duration = Number.parseFloat(rawDuration);
  const windowMinutes = minutesFrom(duration, rawUnit);
  if (!Number.isSafeInteger(prompts) || prompts <= 0 || windowMinutes <= 0) return {};
  return { available_prompts: prompts, window_minutes: windowMinutes };
};

const parseUsedPercent = (text: string): number | undefined => {
  const raw =
    capture(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*used/iu, text) ??
    capture(/used\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*%/iu, text);
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return value >= 0 && value <= 100 ? value : undefined;
};

const parseTimeZoneOffsetMinutes = (hint: string | undefined): number | undefined => {
  const cleaned = hint?.trim();
  if (!cleaned) return undefined;
  if (/^UTC$/iu.test(cleaned) || /^GMT$/iu.test(cleaned)) return 0;
  const match = /^(?:UTC|GMT)\s*([+-])\s*([0-9]{1,2})(?::?([0-9]{2}))?$/iu.exec(cleaned);
  const sign = match?.[1];
  const rawHours = match?.[2];
  const rawMinutes = match?.[3];
  if (!sign || !rawHours) return undefined;
  const hours = Number.parseInt(rawHours, 10);
  const minutes = rawMinutes ? Number.parseInt(rawMinutes, 10) : 0;
  if (hours > 14 || minutes > 59) return undefined;
  return (sign === "-" ? -1 : 1) * (hours * 60 + minutes);
};

const parseResetsAtEpoch = (text: string, nowMs: number): number | undefined => {
  const match = /resets?\s+at\s+([0-9]{1,2}):([0-9]{2})(?:\s*\(([^)]+)\))?/iu.exec(text);
  const rawHours = match?.[1];
  const rawMinutes = match?.[2];
  if (!rawHours || !rawMinutes) return undefined;
  const hours = Number.parseInt(rawHours, 10);
  const minutes = Number.parseInt(rawMinutes, 10);
  if (hours > 23 || minutes > 59) return undefined;
  const offsetMinutes = parseTimeZoneOffsetMinutes(match?.[3]) ?? 0;
  const nowInZone = new Date(nowMs + offsetMinutes * 60_000);
  let candidate =
    Date.UTC(
      nowInZone.getUTCFullYear(),
      nowInZone.getUTCMonth(),
      nowInZone.getUTCDate(),
      hours,
      minutes,
    ) -
    offsetMinutes * 60_000;
  if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
  return candidate;
};

const parseResets = (
  text: string,
  nowMs: number | undefined,
): Pick<MiniMaxHTMLTextFallback, "reset_in_seconds" | "resets_at_epoch_ms"> => {
  const inMatch =
    /resets?\s+in\s+([0-9]+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/iu.exec(
      text,
    );
  const rawValue = inMatch?.[1];
  const rawUnit = inMatch?.[2];
  if (rawValue && rawUnit) {
    const resetInSeconds = secondsFrom(Number.parseFloat(rawValue), rawUnit);
    return {
      reset_in_seconds: resetInSeconds,
      ...(nowMs !== undefined ? { resets_at_epoch_ms: nowMs + resetInSeconds * 1000 } : {}),
    };
  }
  if (nowMs === undefined) return {};
  const resetsAt = parseResetsAtEpoch(text, nowMs);
  return resetsAt === undefined ? {} : { resets_at_epoch_ms: resetsAt };
};

const cleanPlanName = (value: string): string | undefined => {
  const cleaned = value
    .replace(/\\u0026/gu, "&")
    .replace(/\\"/gu, '"')
    .replace(/\s+available\s+usage.*$/iu, "")
    .replace(/^coding\s+plan\s*/iu, "")
    .trim();
  return cleaned ? cleaned : undefined;
};

const parsePlanName = (html: string, text: string): string | undefined => {
  const raw =
    capture(/"planName"\s*:\s*"([^"]+)"/iu, html) ??
    capture(/"plan"\s*:\s*"([^"]+)"/iu, html) ??
    capture(/"packageName"\s*:\s*"([^"]+)"/iu, html) ??
    capture(/coding\s*plan\s*([A-Za-z0-9][A-Za-z0-9\s._-]{0,64})/iu, text);
  return raw ? cleanPlanName(raw) : undefined;
};

export const parseMiniMaxHTMLTextFallback = (
  html: string,
  options: { readonly now?: Date | number } = {},
): MiniMaxHTMLTextFallback | undefined => {
  const bounded = boundedHTML(html);
  if (!bounded) return undefined;
  const text = visibleText(bounded);
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : undefined;
  const planName = parsePlanName(bounded, text);
  const usedPercent = parseUsedPercent(text);
  const fallback: MiniMaxHTMLTextFallback = {
    ...(planName ? { plan_name: planName } : {}),
    ...parseAvailableUsage(text),
    ...(usedPercent !== undefined ? { used_percent: usedPercent } : {}),
    ...parseResets(text, nowMs),
  };
  return Object.keys(fallback).length > 0 ? fallback : undefined;
};

export const parseMiniMaxHTML = (
  html: string,
  options: { readonly now?: Date | number } = {},
): MiniMaxHTMLParseResult | undefined => {
  if (looksMiniMaxHTMLSignedOut(html)) return undefined;
  const payload = extractMiniMaxNextDataPayload(html);
  if (payload) return { source: "next-data", payload, signedOut: false };
  const fallback = parseMiniMaxHTMLTextFallback(html, options);
  return fallback ? { source: "text", fallback, signedOut: false } : undefined;
};
