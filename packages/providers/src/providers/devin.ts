import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, string } from "./_http.ts";

type Window = { readonly usedPercent: number; readonly resetsAt?: string };
type Dict = Record<string, unknown>;

const trim = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result || undefined;
};
const normalizedOrganization = (raw: string | undefined): string | undefined => {
  let value = trim(raw);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname === "devin.ai" || url.hostname.endsWith(".devin.ai")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && (parts[0] === "org" || parts[0] === "organizations"))
        value = `${parts[0]}/${parts[1]}`;
    }
  } catch {
    // A slug is a valid organization setting.
  }
  value = value.replace(/^\/+|\/+$/gu, "");
  if (value.startsWith("org/") || value.startsWith("organizations/")) return value;
  return value.startsWith("org-") || value.startsWith("org_")
    ? `organizations/${value}`
    : `org/${value}`;
};
const organizationID = (organization: string | undefined): string | undefined =>
  organization?.startsWith("organizations/")
    ? organization.slice("organizations/".length)
    : undefined;
const displayOrganization = (organization: string | undefined): string | undefined => {
  if (!organization) return undefined;
  const value = organization.replace(/^organizations\//u, "").replace(/^org\//u, "");
  return value || undefined;
};
const bearer = (raw: string | undefined): string | undefined => {
  let value = trim(raw);
  if (!value) return undefined;
  value = value
    .replace(/^authorization\s*:\s*/iu, "")
    .replace(/^bearer\s+/iu, "")
    .trim();
  return value || undefined;
};
const value = (source: Dict, names: readonly string[]): unknown => {
  for (const name of names) {
    if (name in source) return source[name];
  }
  return undefined;
};
const percent = (raw: unknown): number | undefined => {
  const parsed = number(raw);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.min(100, parsed <= 1 ? parsed * 100 : parsed));
};
const parseWindow = (raw: unknown, ctx: ProviderContext): Window | undefined => {
  const source = object(raw);
  if (!source)
    return percent(raw) === undefined ? undefined : { usedPercent: percent(raw) as number };
  let used = percent(
    value(source, [
      "used_percent",
      "usedPercent",
      "usage_percent",
      "usagePercent",
      "percent_used",
      "percentUsed",
      "percent",
    ]),
  );
  if (used === undefined) {
    const remaining = percent(
      value(source, [
        "remaining_percent",
        "remainingPercent",
        "percent_remaining",
        "percentRemaining",
      ]),
    );
    if (remaining !== undefined) used = 100 - remaining;
  }
  if (used === undefined) {
    const consumed = number(
      value(source, ["used", "usage", "used_count", "usedCount", "consumed"]),
    );
    const limit = number(value(source, ["limit", "quota", "total", "max", "available"]));
    if (consumed !== undefined && limit !== undefined && limit > 0) used = (consumed / limit) * 100;
  }
  if (used === undefined) {
    const remaining = number(value(source, ["remaining", "left", "available"]));
    const limit = number(value(source, ["limit", "quota", "total", "max"]));
    if (remaining !== undefined && limit !== undefined && limit > 0)
      used = ((limit - remaining) / limit) * 100;
  }
  if (used === undefined) return undefined;
  const resetsAt = date(
    value(source, ["reset_at", "resetAt", "next_reset_at", "nextResetAt", "resets_at"]),
    ctx,
  );
  return { usedPercent: Math.max(0, Math.min(100, used)), ...(resetsAt ? { resetsAt } : {}) };
};
const findWindow = (
  raw: unknown,
  ctx: ProviderContext,
  matches: (key: string) => boolean,
): Window | undefined => {
  const source = object(raw);
  if (source) {
    for (const [key, child] of Object.entries(source)) {
      if (matches(key)) {
        const found = parseWindow(child, ctx);
        if (found) return found;
      }
    }
    for (const child of Object.values(source)) {
      const found = findWindow(child, ctx, matches);
      if (found) return found;
    }
  } else if (Array.isArray(raw)) {
    for (const child of raw) {
      const found = findWindow(child, ctx, matches);
      if (found) return found;
    }
  }
  return undefined;
};
const findString = (raw: unknown, keys: readonly string[]): string | undefined => {
  const source = object(raw);
  if (source) {
    for (const key of keys) {
      const found = string(source[key]);
      if (found) return found;
    }
    for (const child of Object.values(source)) {
      const found = findString(child, keys);
      if (found) return found;
    }
  } else if (Array.isArray(raw)) {
    for (const child of raw) {
      const found = findString(child, keys);
      if (found) return found;
    }
  }
  return undefined;
};
const title = (raw: string | undefined): string | undefined =>
  raw?.replace(/[_-]+/gu, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const definition: ProviderDefinition = {
  id: "devin",
  name: "Devin",
  endpoints: ["https://app.devin.ai"],
  settings: [
    { key: "DEVIN_BEARER_TOKEN", title: "Bearer token", type: "secure" },
    { key: "DEVIN_ORGANIZATION", title: "Organization", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  // Electron's isolated provider partition is the portable source. Direct browser local-storage
  // import remains an optional platform adapter, rather than a domain-package responsibility.
  cookieDomains: ["app.devin.ai"],
  fetchUsage: async (ctx: ProviderContext) => {
    const token = bearer(
      ctx.settings.getSecret("DEVIN_BEARER_TOKEN") ??
        ctx.settings.get("DEVIN_BEARER_TOKEN") ??
        ctx.settings.getSecret("DEVIN_AUTHORIZATION") ??
        ctx.settings.get("DEVIN_AUTHORIZATION"),
    );
    if (!token)
      throw ctx.fail.missingCredential(
        "No Devin bearer token is configured. Sign in through the provider session or paste a Bearer token.",
      );
    const organization = normalizedOrganization(
      ctx.settings.get("DEVIN_ORGANIZATION") ?? ctx.settings.get("DEVIN_ORG"),
    );
    if (!organization)
      throw ctx.fail.missingCredential(
        "No Devin organization is configured. Open an app.devin.ai/org/... page or set DEVIN_ORGANIZATION.",
      );
    const internal = organizationID(organization);
    const paths = [
      ...(internal ? [`${internal}/billing/quota/usage`] : []),
      `${organization}/billing/quota/usage`,
      ...(organization.startsWith("org/") ? [`${organization.slice(4)}/billing/quota/usage`] : []),
      ...(organization.startsWith("org/") ? [] : [`org/${organization}/billing/quota/usage`]),
      ...(internal ? [`organizations/${internal}/billing/quota/usage`] : []),
    ].filter((path, index, array) => array.indexOf(path) === index);
    let lastError: Error | undefined;
    for (const path of paths) {
      const response = await get(ctx, `https://app.devin.ai/api/${path}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(internal ? { "x-cog-org-id": internal } : {}),
        },
      });
      if (response.status === 401 || response.status === 403)
        throw ctx.fail.authenticationExpired("Devin session token is invalid or expired.");
      if (response.status < 200 || response.status >= 300) {
        lastError = ctx.fail.apiFailure(`Devin API returned HTTP ${response.status}.`);
        continue;
      }
      const root = object(json(ctx, "Devin", response));
      if (!root) throw ctx.fail.parseFailure("Devin response must be an object.");
      const currentDaily = parseWindow(
        root.daily_percentage === undefined
          ? undefined
          : { used_percent: root.daily_percentage, reset_at: root.daily_reset_at },
        ctx,
      );
      const currentWeekly = parseWindow(
        root.weekly_percentage === undefined
          ? undefined
          : { used_percent: root.weekly_percentage, reset_at: root.weekly_reset_at },
        ctx,
      );
      const daily = currentDaily ?? findWindow(root, ctx, (key) => /daily/i.test(key));
      const weekly = currentWeekly ?? findWindow(root, ctx, (key) => /weekly/i.test(key));
      if (!daily && !weekly) throw ctx.fail.parseFailure("Missing Devin quota windows.");
      const overage = number(root.overage_balance ?? root.overage_balance_cents);
      const overageDollars =
        number(root.overage_balance) !== undefined
          ? number(root.overage_balance)
          : overage === undefined
            ? undefined
            : overage / 100;
      const plan = title(
        findString(root, ["plan_name", "planName", "plan", "tier", "subscription_tier"]),
      );
      return {
        ...(daily
          ? {
              primary: {
                ...daily,
                windowMinutes: 1_440,
                resetDescription: "Daily",
              },
            }
          : {}),
        ...(weekly
          ? {
              secondary: {
                ...weekly,
                windowMinutes: 10_080,
                resetDescription: "Weekly",
              },
            }
          : {}),
        ...(overageDollars !== undefined && Number.isFinite(overageDollars) && overageDollars >= 0
          ? {
              cost: {
                used: overageDollars,
                limit: 0,
                currency: "USD",
                period: "Extra usage balance",
              },
            }
          : {}),
        identity: {
          ...(displayOrganization(organization)
            ? { organization: displayOrganization(organization) }
            : {}),
          ...(plan ? { loginMethod: plan } : {}),
        },
      };
    }
    throw lastError ?? ctx.fail.apiFailure("No Devin quota endpoint succeeded.");
  },
};

const strategy: ProviderStrategy = {
  id: "devin.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const devin: FirstPartyProvider = { ...strategy, descriptor };
