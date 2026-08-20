import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";

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
  value.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
const amount = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);
const date = (value: unknown, ctx: ProviderContext): string | undefined => {
  const raw = string(value);
  return raw && Number.isFinite(Date.parse(raw)) ? ctx.date.iso(raw) : undefined;
};

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
  status(ctx, "ZenMux", response);
  return response;
};

const quota = (
  raw: unknown,
  ctx: ProviderContext,
  minutes: number,
): Record<string, unknown> | undefined => {
  const value = object(raw);
  if (!value) return undefined;
  const fraction = number(value.usage_percentage);
  const max = number(value.max_flows);
  const used = number(value.used_flows);
  if (fraction === undefined || max === undefined || used === undefined)
    throw ctx.fail.parseFailure("ZenMux quota window is missing numeric flow values.");
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
    const tier = string(plan.tier);
    const accountStatus = string(payload.account_status) ?? "";
    if (!tier)
      throw ctx.fail.parseFailure("ZenMux subscription response did not include a plan tier.");
    const primary = quota(payload.quota_5_hour, ctx, 5 * 60);
    const secondary = quota(payload.quota_7_day, ctx, 7 * 24 * 60);
    if (!primary || !secondary)
      throw ctx.fail.parseFailure("ZenMux subscription response did not include quota windows.");

    // The generic TypeScript provider contract does not yet carry Swift's includeOptionalUsage
    // flag. Fetch the balance as a bounded best-effort enrichment so the portable snapshot does
    // not silently lose the upstream cost field; a future contract extension can make it opt-in.
    let paygBalance: number | undefined;
    try {
      const balanceResponse = await request(ctx, "payg/balance", key);
      const balanceEnvelope = object(json(ctx, "ZenMux", balanceResponse));
      const balance = object(balanceEnvelope?.data);
      if (!balanceEnvelope || balanceEnvelope.success !== true || !balance)
        throw ctx.fail.parseFailure("ZenMux balance response reported failure.");
      if (string(balance.currency)?.toLowerCase() !== "usd")
        throw ctx.fail.parseFailure("ZenMux balance currency is not USD.");
      const total = number(balance.total_credits);
      if (total === undefined)
        throw ctx.fail.parseFailure("ZenMux balance did not include total_credits.");
      paygBalance = total;
    } catch (error) {
      // Auth failures still reveal that the management credential is wrong. Other optional
      // endpoint failures intentionally leave the subscription snapshot intact, as in Swift.
      const kind =
        typeof error === "object" && error !== null && "kind" in error
          ? (error as { readonly kind?: unknown }).kind
          : undefined;
      if (
        kind === "authentication-expired" ||
        (error instanceof Error && error.message.startsWith("authentication-expired:"))
      )
        throw error;
    }
    const expiresAt = date(plan.expires_at, ctx);
    const healthy = accountStatus === "" || accountStatus.toLowerCase() === "healthy";
    const planLabel = `${title(tier)} plan`;
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
      identity: { loginMethod: healthy ? planLabel : `${planLabel} · ${title(accountStatus)}` },
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
