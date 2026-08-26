import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object, string } from "./_http.ts";

const baseURL = "https://zenmux.ai/api/v1/management";
const clean = (value: string | undefined): string | undefined => {
  let result = value?.trim();
  if (!result) return undefined;
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  )
    result = result.slice(1, -1).trim();
  return result || undefined;
};
const title = (value: string): string =>
  value.toLocaleLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
const amount = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);
const date = (value: unknown, ctx: ProviderContext): string | undefined => {
  if (value !== undefined && value !== null && typeof value !== "string")
    throw ctx.fail.parseFailure("ZenMux date value must be a string.");
  const raw = string(value);
  return raw && Number.isFinite(Date.parse(raw)) ? ctx.date.iso(raw) : undefined;
};

const strictNumber = (value: unknown, ctx: ProviderContext, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw ctx.fail.parseFailure(`ZenMux ${field} must be a number.`);
  return value;
};

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

const credential = (ctx: ProviderContext): string | undefined =>
  clean(
    ctx.settings.getSecret("ZENMUX_MANAGEMENT_API_KEY") ??
      ctx.settings.get("ZENMUX_MANAGEMENT_API_KEY"),
  );

const request = async (
  ctx: ProviderContext,
  path: string,
  key: string,
): Promise<ProviderResponse> => {
  const response = await get(ctx, `${baseURL}/${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    timeoutSeconds: 15,
  });
  // A management credential must produce an explicit authentication error rather than a generic API failure.
  if (response.status === 401 || response.status === 403)
    throw ctx.fail.authenticationExpired(
      "ZenMux rejected the Management API key. Standard inference API keys are not supported.",
    );
  if (response.status < 200 || response.status >= 300)
    throw ctx.fail.apiFailure(`ZenMux Management API returned HTTP ${response.status}.`);
  return response;
};

const quota = (
  raw: unknown,
  ctx: ProviderContext,
  minutes: number,
): Record<string, unknown> | undefined => {
  const value = object(raw);
  if (!value) return undefined;
  const fraction = strictNumber(value.usage_percentage, ctx, "usage_percentage");
  const max = strictNumber(value.max_flows, ctx, "max_flows");
  const used = strictNumber(value.used_flows, ctx, "used_flows");
  strictNumber(value.remaining_flows, ctx, "remaining_flows");
  const resetsAt = date(value.resets_at, ctx);
  return {
    usedPercent: Math.max(0, Math.min(100, fraction * 100)),
    windowMinutes: minutes,
    ...(resetsAt ? { resetsAt } : {}),
    resetDescription: `${amount(used)} / ${amount(max)} flows`,
  };
};

const definition: ProviderDefinition = {
  id: "zenmux",
  name: "ZenMux",
  endpoints: ["https://zenmux.ai"],
  auth: { type: "bearer", secret: "ZENMUX_MANAGEMENT_API_KEY" },
  settings: [{ key: "ZENMUX_MANAGEMENT_API_KEY", title: "Management API key", type: "secure" }],
  fetchUsage: async (ctx) => {
    const key = credential(ctx);
    if (!key) throw ctx.fail.missingCredential("Missing ZenMux Management API key.");
    const subscriptionResponse = await request(ctx, "subscription/detail", key);
    const envelope = object(json(ctx, "ZenMux", subscriptionResponse));
    const payload = object(envelope?.data);
    const plan = object(payload?.plan);
    if (!envelope || envelope.success !== true || !payload || !plan)
      throw ctx.fail.parseFailure("ZenMux subscription response reported failure.");
    if (typeof plan.tier !== "string")
      throw ctx.fail.parseFailure("ZenMux subscription response did not include a plan tier.");
    if (typeof payload.account_status !== "string")
      throw ctx.fail.parseFailure("ZenMux subscription response did not include account_status.");
    const tier = plan.tier.trim();
    const accountStatus = payload.account_status.trim();
    const primary = quota(payload.quota_5_hour, ctx, 5 * 60);
    const secondary = quota(payload.quota_7_day, ctx, 7 * 24 * 60);
    if (!primary || !secondary)
      throw ctx.fail.parseFailure("ZenMux subscription response did not include quota windows.");

    let paygBalance: number | undefined;
    if (ctx.includeCredits === true)
      try {
        const balanceResponse = await request(ctx, "payg/balance", key);
        const balanceEnvelope = object(json(ctx, "ZenMux", balanceResponse));
        const balance = object(balanceEnvelope?.data);
        if (!balanceEnvelope || balanceEnvelope.success !== true || !balance)
          throw ctx.fail.parseFailure("ZenMux balance response reported failure.");
        if (string(balance.currency)?.toLowerCase() !== "usd")
          throw ctx.fail.parseFailure("ZenMux balance currency is not USD.");
        paygBalance = strictNumber(balance.total_credits, ctx, "total_credits");
      } catch (error) {
        // Auth failures still reveal that the management credential is wrong. Other optional
        // endpoint failures intentionally leave the subscription snapshot intact, as in Swift.
        const kind =
          typeof error === "object" && error !== null && "kind" in error
            ? (error as { readonly kind?: unknown }).kind
            : undefined;
        if (isAbortError(error)) throw error;
        if (
          kind === "authentication-expired" ||
          (error instanceof Error && error.message.startsWith("authentication-expired:"))
        )
          throw error;
      }
    const expiresAt = date(plan.expires_at, ctx);
    const healthy = accountStatus === "" || accountStatus.toLowerCase() === "healthy";
    const planLabel = tier === "" ? undefined : `${title(tier)} plan`;
    const loginMethod = healthy
      ? planLabel
      : [planLabel, title(accountStatus)].filter((value) => value !== undefined).join(" · ");
    return {
      primary,
      secondary,
      ...(paygBalance === undefined
        ? {}
        : {
            providerCost: {
              used: paygBalance,
              limit: 0,
              currency: "USD",
              period: "ZenMux PAYG balance",
            },
          }),
      ...(expiresAt ? { subscriptionExpiresAt: expiresAt } : {}),
      ...(loginMethod ? { identity: { loginMethod } } : {}),
      dataConfidence: "exact",
    };
  },
};

const strategy: ProviderStrategy = {
  id: "zenmux.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const zenmux: FirstPartyProvider = { ...strategy, descriptor };
