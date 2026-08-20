import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";

const endpoint = "https://api.fireworks.ai";
const accountSlugPattern = /^[A-Za-z0-9._-]+$/;
const maxAccountPages = 100;

type SummaryResult = {
  readonly snapshot: Record<string, unknown>;
  readonly hasRatedCost: boolean;
};

function accountSlug(value: unknown): string | undefined {
  const account = object(value);
  if (!account) return undefined;
  for (const key of ["accountId", "id", "name"]) {
    const raw = string(account[key]);
    if (!raw) continue;
    const candidate = raw.split("/").filter(Boolean).at(-1) ?? raw;
    if (accountSlugPattern.test(candidate)) return candidate;
  }
  return undefined;
}

async function listAccountSlugs(ctx: ProviderContext, key: string): Promise<string[]> {
  const slugs = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < maxAccountPages; page += 1) {
    const url = new URL(`${endpoint}/v1/accounts`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await get(ctx, url.href, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403)
      throw ctx.fail.authenticationExpired("Fireworks rejected the API key.");
    status(ctx, "Fireworks", response);
    const root = object(json(ctx, "Fireworks accounts", response));
    if (!root) throw ctx.fail.parseFailure("Fireworks accounts response must be an object.");
    if (Array.isArray(root.accounts)) {
      for (const value of root.accounts) {
        const slug = accountSlug(value);
        if (slug) slugs.add(slug);
      }
    }
    pageToken = string(root.nextPageToken);
    if (!pageToken) return [...slugs].sort();
    if (!seenPageTokens.add(pageToken)) {
      throw ctx.fail.apiFailure("Fireworks accounts pagination repeated a page token.");
    }
  }
  throw ctx.fail.apiFailure("Fireworks accounts pagination exceeded 100 pages.");
}

function noAccounts(ctx: ProviderContext): Error {
  return ctx.fail.missingCredential(
    "No Fireworks accounts are visible to this API key. Check the key in app.fireworks.ai or run 'firectl whoami'.",
  );
}

function multipleAccounts(ctx: ProviderContext, slugs: readonly string[]): Error {
  return ctx.fail.missingCredential(
    `This Fireworks API key can access multiple accounts: ${slugs.join(", ")}. Set the account slug in Settings or FIREWORKS_ACCOUNT_SLUG.`,
  );
}

function accountNotFound(ctx: ProviderContext, slug: string): Error {
  return ctx.fail.missingCredential(
    `Fireworks account slug '${slug}' not found for this API key. Leave the slug blank to auto-discover it.`,
  );
}

async function fetchSummary(
  ctx: ProviderContext,
  key: string,
  slug: string,
): Promise<SummaryResult | undefined> {
  const end = ctx.date.now();
  const start = new Date(end.getTime() - 30 * 86400000);
  const url = `${endpoint}/v1/accounts/${slug}/billing/summary?startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}`;
  const response = await get(ctx, url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (response.status === 404) return undefined;
  if (response.status === 401 || response.status === 403)
    throw ctx.fail.authenticationExpired("Fireworks rejected the API key.");
  status(ctx, "Fireworks", response);
  const root = object(json(ctx, "Fireworks", response));
  if (!root) throw ctx.fail.parseFailure("Fireworks response must be an object.");
  const rows = Array.isArray(root.lineItems) ? root.lineItems : [];
  let currency: string | undefined;
  let total = 0;
  for (const raw of rows) {
    const row = object(raw);
    const cost = row && object(row.totalCost);
    const code = cost && string(cost.currencyCode);
    const units = cost && number(cost.units);
    const nanos = cost && number(cost.nanos);
    if (code && units !== undefined && nanos !== undefined) {
      currency ??= code;
      if (currency === code) total += units + nanos / 1e9;
    }
  }
  return {
    snapshot: currency
      ? { cost: { used: total, limit: 0, currency, period: "Last 30 days" }, identity: {} }
      : { identity: {} },
    hasRatedCost: currency !== undefined,
  };
}

const definition: ProviderDefinition = {
  id: "fireworks",
  name: "Fireworks",
  endpoints: ["https://api.fireworks.ai"],
  auth: { type: "bearer", secret: "FIREWORKS_API_KEY" },
  settings: [
    { key: "FIREWORKS_API_KEY", title: "API key", type: "secure" },
    { key: "FIREWORKS_ACCOUNT_SLUG", title: "Account slug", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key = (
      ctx.settings.getSecret("FIREWORKS_API_KEY") ||
      ctx.settings.get("FIREWORKS_API_KEY") ||
      ""
    ).trim();
    const slug = (ctx.settings.get("FIREWORKS_ACCOUNT_SLUG") || "").trim();
    if (!key) throw ctx.fail.missingCredential("Missing Fireworks API key.");
    if (slug && !accountSlugPattern.test(slug))
      throw ctx.fail.missingCredential(`Invalid Fireworks account slug '${slug}'.`);

    if (slug) {
      const configured = await fetchSummary(ctx, key, slug);
      if (configured) {
        if (!configured.hasRatedCost) {
          const slugs = await listAccountSlugs(ctx, key);
          if (!slugs.includes(slug)) throw accountNotFound(ctx, slug);
        }
        return configured.snapshot;
      }
      const slugs = await listAccountSlugs(ctx, key);
      if (slugs.length === 0) throw accountNotFound(ctx, slug);
      if (slugs.length > 1) throw multipleAccounts(ctx, slugs);
      const discovered = await fetchSummary(ctx, key, slugs[0] as string);
      if (!discovered) throw ctx.fail.apiFailure("Fireworks billing API returned HTTP 404.");
      return discovered.snapshot;
    }

    const slugs = await listAccountSlugs(ctx, key);
    if (slugs.length === 0) throw noAccounts(ctx);
    if (slugs.length > 1) throw multipleAccounts(ctx, slugs);
    const discovered = await fetchSummary(ctx, key, slugs[0] as string);
    if (!discovered) throw ctx.fail.apiFailure("Fireworks billing API returned HTTP 404.");
    return discovered.snapshot;
  },
};
const strategy: ProviderStrategy = {
  id: "fireworks.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const fireworks: FirstPartyProvider = { ...strategy, descriptor };
