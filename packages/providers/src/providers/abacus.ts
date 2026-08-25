import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { date, json, number, object, string } from "./_http.ts";

const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;
const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";
const headers = (cookie: string) => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  Cookie: cookie,
});
const parse = (ctx: ProviderContext, response: ProviderResponse, label: string) => {
  if (response.status === 401 || response.status === 403)
    throw ctx.fail.authenticationExpired("Abacus AI session expired; please log in again.");
  if (response.status !== 200)
    throw ctx.fail.apiFailure(`Abacus ${label} returned HTTP ${response.status}.`);
  const root = object(json(ctx, "Abacus", response));
  if (!root || root.success !== true) {
    const message = string(root?.error)?.toLowerCase() ?? "unknown error";
    if (/expired|session|login|authenticat|unauthor|forbidden/iu.test(message))
      throw ctx.fail.authenticationExpired("Abacus AI session expired; please log in again.");
    throw ctx.fail.parseFailure(`Abacus ${label}: ${message}`);
  }
  const result = object(root.result);
  if (!result) throw ctx.fail.parseFailure(`Abacus ${label} result is missing.`);
  return result;
};

const definition: ProviderDefinition = {
  id: "abacus",
  name: "Abacus AI",
  endpoints: ["https://apps.abacus.ai"],
  settings: [{ key: "ABACUS_COOKIE_HEADER", title: "Cookie header", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["apps.abacus.ai"],
  fetchUsage: async (ctx: ProviderContext) => {
    const cookie =
      clean(
        ctx.settings.getSecret("ABACUS_COOKIE_HEADER") ?? ctx.settings.get("ABACUS_COOKIE_HEADER"),
      ) ?? clean(await ctx.browser.cookieHeader("apps.abacus.ai"));
    if (!cookie)
      throw ctx.fail.missingCredential("No Abacus AI session cookie found. Please log in first.");
    const computeResponse = await ctx.http.getJSON(
      "https://apps.abacus.ai/api/_getOrganizationComputePoints",
      {
        headers: headers(cookie),
      },
    );
    const compute = parse(ctx, computeResponse, "compute-points");
    const total = number(compute.totalComputePoints);
    const left = number(compute.computePointsLeft);
    if (total === undefined || left === undefined)
      throw ctx.fail.parseFailure("Abacus compute-points response is missing credit fields.");
    // Billing is optional/bounded in Swift: partial usage is still useful when it is unavailable.
    let billing: Record<string, unknown> | undefined;
    try {
      const billingResponse = await ctx.http.postJSON(
        "https://apps.abacus.ai/api/_getBillingInfo",
        {
          body: {},
          headers: headers(cookie),
          timeoutSeconds: ctx.__codexbarOptionalRequestTimeoutSeconds ?? 5,
        },
      );
      billing = parse(ctx, billingResponse, "billing-info");
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (String(error).startsWith("authentication-expired:")) throw error;
    }
    const used = total - left;
    const resetsAt = date(billing?.nextBillingDate, ctx);
    const reset = resetsAt ? new Date(resetsAt) : undefined;
    const start = reset
      ? new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, reset.getUTCDate()))
      : undefined;
    const windowMinutes =
      start && reset
        ? Math.max(1, Math.floor((reset.getTime() - start.getTime()) / 60_000))
        : 43_200;
    return {
      primary: {
        usedPercent: total > 0 ? ctx.pct(used, total) : 0,
        windowMinutes,
        ...(resetsAt ? { resetsAt } : {}),
        resetDescription: `${ctx.format.number(used, { maximumFractionDigits: used >= 1000 ? 0 : 1 })} / ${ctx.format.number(total, { maximumFractionDigits: total >= 1000 ? 0 : 1 })} credits`,
      },
      identity: string(billing?.currentTier) ? { loginMethod: string(billing?.currentTier) } : {},
    };
  },
};

const strategy: ProviderStrategy = {
  id: "abacus.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const abacus: FirstPartyProvider = { ...strategy, descriptor };
