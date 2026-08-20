import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Region = "global" | "cn";
type Service = {
  readonly name: string;
  readonly used: number;
  readonly limit: number;
  readonly percent: number;
  readonly resetsAt?: string;
  readonly windowMinutes?: number;
  readonly label: string;
};

const region = (ctx: ProviderContext): Region =>
  ctx.settings.get("MINIMAX_API_REGION")?.trim() === "cn" ? "cn" : "global";
const host = (region: Region) => (region === "cn" ? "api.minimaxi.com" : "api.minimax.io");
const platformHost = (region: Region) =>
  region === "cn" ? "platform.minimaxi.com" : "platform.minimax.io";
const apiURL = (region: Region, path: string) => `https://${host(region)}${path}`;

const positive = (value: unknown): number => Math.max(0, number(value) ?? 0);
const timestamp = (ctx: ProviderContext, value: unknown): string | undefined => {
  const raw = number(value);
  if (raw === undefined || raw <= 0) return undefined;
  return ctx.date.unixMillis(raw > 10_000_000_000 ? raw : raw * 1_000);
};
const duration = (start: unknown, end: unknown): number | undefined => {
  const a = number(start);
  const b = number(end);
  if (a === undefined || b === undefined || b <= a) return undefined;
  const milliseconds = b > 10_000_000_000 ? b - a : (b - a) * 1_000;
  const minutes = Math.round(milliseconds / 60_000);
  return minutes > 0 && Number.isSafeInteger(minutes) ? minutes : undefined;
};

const services = (ctx: ProviderContext, root: Record<string, unknown>): readonly Service[] => {
  const rows = Array.isArray(root.model_remains) ? root.model_remains : [];
  const result: Service[] = [];
  for (const raw of rows) {
    const row = object(raw);
    if (!row) continue;
    const name = string(row.model_name) ?? "General";
    const intervalTotal = positive(row.current_interval_total_count);
    const intervalUsage = positive(row.current_interval_usage_count);
    const intervalRemaining = number(row.current_interval_remaining_percent);
    const intervalLimit = intervalTotal || (intervalRemaining === undefined ? 0 : 100);
    const intervalUsed = intervalTotal
      ? intervalUsage
      : Math.max(0, 100 - (intervalRemaining ?? 100));
    if (intervalLimit > 0 || intervalRemaining !== undefined) {
      const resetsAt = timestamp(ctx, row.end_time);
      const windowMinutes = duration(row.start_time, row.end_time);
      result.push({
        name,
        used: intervalUsed,
        limit: intervalLimit,
        percent: intervalLimit > 0 ? ctx.pct(intervalUsed, intervalLimit) : intervalUsed,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowMinutes ? { windowMinutes } : {}),
        label: `${name} · 5 hours`,
      });
    }
    const weeklyTotal = positive(row.current_weekly_total_count);
    const weeklyUsage = positive(row.current_weekly_usage_count);
    const weeklyRemaining = number(row.current_weekly_remaining_percent);
    const weeklyLimit = weeklyTotal || (weeklyRemaining === undefined ? 0 : 100);
    const weeklyUsed = weeklyTotal ? weeklyUsage : Math.max(0, 100 - (weeklyRemaining ?? 100));
    if (weeklyLimit > 0 || weeklyRemaining !== undefined) {
      const resetsAt = timestamp(ctx, row.weekly_end_time);
      const windowMinutes = duration(row.weekly_start_time, row.weekly_end_time);
      result.push({
        name,
        used: weeklyUsed,
        limit: weeklyLimit,
        percent: weeklyLimit > 0 ? ctx.pct(weeklyUsed, weeklyLimit) : weeklyUsed,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowMinutes ? { windowMinutes } : { windowMinutes: 10_080 }),
        label: `${name} · Weekly`,
      });
    }
  }
  return result;
};

const snapshot = (ctx: ProviderContext, root: Record<string, unknown>) => {
  const lanes = services(ctx, root);
  if (lanes.length === 0) throw ctx.fail.parseFailure("MiniMax response has no model remains.");
  const primaryIndex = lanes.findIndex((lane) => lane.name.trim().toLowerCase() === "general");
  const ordered =
    primaryIndex > 0
      ? [lanes[primaryIndex] as Service, ...lanes.filter((_, index) => index !== primaryIndex)]
      : lanes;
  const windows = ordered.slice(0, 3).map((lane) => ({
    usedPercent: lane.percent,
    ...(lane.windowMinutes ? { windowMinutes: lane.windowMinutes } : {}),
    ...(lane.resetsAt ? { resetsAt: lane.resetsAt } : {}),
    resetDescription: `${ctx.format.number(lane.used)} / ${ctx.format.number(lane.limit)} ${lane.label}`,
  }));
  const plan = string(root.current_subscribe_title) ?? string(root.subscribe_title);
  return {
    ...(windows[0] ? { primary: windows[0] } : {}),
    ...(windows[1] ? { secondary: windows[1] } : {}),
    ...(windows[2] ? { tertiary: windows[2] } : {}),
    details: [
      {
        title: "Quota services",
        rows: ordered.slice(0, 16).map((lane) => ({
          label: lane.label,
          value: `${ctx.format.number(lane.used)} / ${ctx.format.number(lane.limit)}`,
          secondaryValue: `${Math.round(lane.percent)}% used`,
        })),
      },
    ],
    identity: plan ? { loginMethod: plan } : {},
  };
};

const tryAPI = async (ctx: ProviderContext, token: string, requestedRegion: Region) => {
  const regions: readonly Region[] = requestedRegion === "global" ? ["global", "cn"] : ["cn"];
  let globalCredentialFailure = false;
  for (const currentRegion of regions) {
    for (const path of ["/v1/token_plan/remains", "/v1/api/openplatform/coding_plan/remains"]) {
      const response = await ctx.http.getJSON(apiURL(currentRegion, path), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "MM-API-Source": "CodexBar",
        },
      });
      const body = object(response.json);
      const code = number(object(body?.base_resp)?.status_code);
      const credentialFailure = response.status === 401 || response.status === 403 || code === 1004;
      if (credentialFailure) {
        globalCredentialFailure ||= currentRegion === "global";
        continue;
      }
      status(ctx, "MiniMax", response);
      if (!body) throw ctx.fail.parseFailure("MiniMax response must be an object.");
      return snapshot(ctx, body);
    }
  }
  if (globalCredentialFailure)
    throw ctx.fail.authenticationExpired("MiniMax rejected the API token.");
  throw ctx.fail.authenticationExpired("MiniMax rejected the API token.");
};

const definition: ProviderDefinition = {
  id: "minimax",
  name: "MiniMax",
  endpoints: [
    "https://api.minimax.io",
    "https://api.minimaxi.com",
    "https://platform.minimax.io",
    "https://platform.minimaxi.com",
  ],
  auth: { type: "bearer", secret: "MINIMAX_API_TOKEN" },
  settings: [
    { key: "MINIMAX_API_TOKEN", title: "API token", type: "secure" },
    { key: "MINIMAX_API_REGION", title: "API region", type: "plain" },
    { key: "MINIMAX_COOKIE_HEADER", title: "Cookie header", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["platform.minimax.io", "platform.minimaxi.com"],
  fetchUsage: async (ctx: ProviderContext) => {
    const token = ctx.settings.getSecret("MINIMAX_API_TOKEN")?.trim();
    if (token) return tryAPI(ctx, token, region(ctx));
    const selected = region(ctx);
    const cookie =
      ctx.settings.getSecret("MINIMAX_COOKIE_HEADER")?.trim() ||
      (await ctx.browser.cookieHeader(platformHost(selected))).trim();
    if (!cookie)
      throw ctx.fail.missingCredential(
        "MiniMax API token or coding-plan cookie is not configured.",
      );
    const response = await ctx.http.getJSON(
      `https://${platformHost(selected)}/v1/api/openplatform/coding_plan/remains`,
      {
        headers: {
          Cookie: cookie,
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
    );
    status(ctx, "MiniMax", response);
    const root = object(response.json);
    if (number(object(root?.base_resp)?.status_code) === 1004) {
      throw ctx.fail.authenticationExpired("MiniMax coding-plan session expired.");
    }
    if (!root) throw ctx.fail.parseFailure("MiniMax response must be an object.");
    return snapshot(ctx, root);
  },
};

const strategy: ProviderStrategy = {
  id: "minimax.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const minimax: FirstPartyProvider = { ...strategy, descriptor };
