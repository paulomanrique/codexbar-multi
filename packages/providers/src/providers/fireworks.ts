import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderSnapshot,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object } from "./_http.ts";

type FireworksSettings = ProviderContext["settings"];
type JsonObject = Readonly<Record<string, unknown>>;

const endpoint = "https://api.fireworks.ai";
const accountSlugPattern = /^[A-Za-z0-9._-]+$/u;
// The API contract emits finite decimal money strings. Swift's `Double.init` also accepts
// non-finite and hexadecimal spellings, but those cannot cross the bounded UsageSnapshot DTO.
const swiftDoublePattern = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u;

export class InvalidFireworksAccountSlug extends Error {
  readonly accountSlug: string;

  constructor(accountSlug: string) {
    super(`Invalid Fireworks account slug '${accountSlug}'.`);
    this.name = "InvalidFireworksAccountSlug";
    this.accountSlug = accountSlug;
  }
}

export class InvalidFireworksSummary extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFireworksSummary";
  }
}

const cleanSetting = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  value = value.trim();
  return value === "" ? undefined : value;
};

const setting = (settings: FireworksSettings, key: string): string | undefined =>
  cleanSetting(settings.getSecret(key)) ?? cleanSetting(settings.get(key));

export const resolveFireworksAPIKey = (settings: FireworksSettings): string | undefined =>
  setting(settings, "CODEXBAR_FIREWORKS_API_KEY") ??
  setting(settings, "FIREWORKS_API_KEY") ??
  setting(settings, "FIREWORKS_KEY");

export const resolveFireworksAccountSlug = (settings: FireworksSettings): string | undefined =>
  setting(settings, "CODEXBAR_FIREWORKS_ACCOUNT_SLUG") ??
  setting(settings, "FIREWORKS_ACCOUNT_SLUG");

const isoWithoutFraction = (date: Date): string => {
  if (!Number.isFinite(date.getTime())) throw new RangeError("Fireworks request date is invalid");
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
};

/** Matches `FireworksUsageFetcher.resolveSummaryURL`, including literal ISO query values. */
export const resolveFireworksSummaryURL = (
  accountSlug: string,
  startTime?: Date,
  endTime?: Date,
): string => {
  if (accountSlug === "." || accountSlug === ".." || !accountSlugPattern.test(accountSlug)) {
    throw new InvalidFireworksAccountSlug(accountSlug);
  }
  const query = [
    ...(startTime === undefined ? [] : [`startTime=${isoWithoutFraction(startTime)}`]),
    ...(endTime === undefined ? [] : [`endTime=${isoWithoutFraction(endTime)}`]),
  ];
  return `${endpoint}/v1/accounts/${accountSlug}/billing/summary${query.length === 0 ? "" : `?${query.join("&")}`}`;
};

const optionalString = (source: JsonObject, key: string, path: string): string | undefined => {
  const value = source[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw new InvalidFireworksSummary(`${path} must be a string`);
  return value;
};

const optionalDouble = (source: JsonObject, key: string, path: string): number | undefined => {
  const value = source[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidFireworksSummary(`${path} must be a finite number`);
  }
  return value;
};

const optionalInteger = (source: JsonObject, key: string, path: string): number | undefined => {
  const value = source[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new InvalidFireworksSummary(`${path} must be an integer`);
  }
  return value;
};

interface FireworksMoney {
  readonly currencyCode?: string;
  readonly nanos?: number;
  readonly units?: string;
}

interface FireworksLineItem {
  readonly totalCost?: FireworksMoney;
}

const money = (value: unknown, path: string): FireworksMoney | undefined => {
  if (value == null) return undefined;
  const source = object(value);
  if (source === undefined) throw new InvalidFireworksSummary(`${path} must be an object`);
  const currencyCode = optionalString(source, "currencyCode", `${path}.currencyCode`);
  const nanos = optionalInteger(source, "nanos", `${path}.nanos`);
  const units = optionalString(source, "units", `${path}.units`);
  return {
    ...(currencyCode === undefined ? {} : { currencyCode }),
    ...(nanos === undefined ? {} : { nanos }),
    ...(units === undefined ? {} : { units }),
  };
};

const lineItem = (value: unknown, path: string): FireworksLineItem => {
  const source = object(value);
  if (source === undefined) throw new InvalidFireworksSummary(`${path} must be an object`);
  optionalString(source, "category", `${path}.category`);
  optionalString(source, "groupingKey", `${path}.groupingKey`);
  optionalString(source, "groupingValue", `${path}.groupingValue`);
  optionalDouble(source, "quantity", `${path}.quantity`);
  optionalString(source, "series", `${path}.series`);
  const totalCost = money(source.totalCost, `${path}.totalCost`);
  money(source.unitAmount, `${path}.unitAmount`);
  return totalCost === undefined ? {} : { totalCost };
};

const optionalLineItems = (
  source: JsonObject,
  key: string,
  path: string,
): readonly FireworksLineItem[] => {
  const value = source[key];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InvalidFireworksSummary(`${path} must be an array`);
  return value.map((entry, index) => lineItem(entry, `${path}[${index}]`));
};

/** Strict known-field validation plus the upstream first-currency summation rule. */
export const parseFireworksSummary = (value: unknown): ProviderSnapshot => {
  const root = object(value);
  if (root === undefined) throw new InvalidFireworksSummary("Fireworks response must be an object");
  const lineItems = optionalLineItems(root, "lineItems", "lineItems");
  const usageBuckets = root.usageBuckets;
  if (usageBuckets != null) {
    if (!Array.isArray(usageBuckets)) {
      throw new InvalidFireworksSummary("usageBuckets must be an array");
    }
    for (const [index, entry] of usageBuckets.entries()) {
      const bucket = object(entry);
      const path = `usageBuckets[${index}]`;
      if (bucket === undefined) throw new InvalidFireworksSummary(`${path} must be an object`);
      optionalString(bucket, "bucketStartTime", `${path}.bucketStartTime`);
      optionalLineItems(bucket, "lineItems", `${path}.lineItems`);
    }
  }

  let currency: string | undefined;
  let total = 0;
  for (const item of lineItems) {
    const cost = item.totalCost;
    const code = cost?.currencyCode?.trim();
    const unitsText = cost?.units;
    const nanos = cost?.nanos;
    if (
      code === undefined ||
      code === "" ||
      unitsText === undefined ||
      !swiftDoublePattern.test(unitsText) ||
      nanos === undefined
    ) {
      continue;
    }
    const units = Number(unitsText);
    if (!Number.isFinite(units)) continue;
    currency ??= code;
    if (currency === code) total += units + nanos / 1_000_000_000;
  }

  return currency === undefined
    ? { emptySnapshot: true }
    : { cost: { used: total, limit: 0, currency, period: "Last 30 days" } };
};

const definition: ProviderDefinition = {
  id: "fireworks",
  name: "Fireworks",
  allowEmptySnapshot: true,
  endpoints: [endpoint],
  auth: { type: "provider-managed", secret: "FIREWORKS_API_KEY" },
  settings: [
    { key: "CODEXBAR_FIREWORKS_API_KEY", title: "Configured API key", type: "secure" },
    { key: "FIREWORKS_API_KEY", title: "API key", type: "secure" },
    { key: "FIREWORKS_KEY", title: "Legacy API key", type: "secure" },
    {
      key: "CODEXBAR_FIREWORKS_ACCOUNT_SLUG",
      title: "Configured account slug",
      type: "plain",
    },
    { key: "FIREWORKS_ACCOUNT_SLUG", title: "Account slug", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key = resolveFireworksAPIKey(ctx.settings);
    if (key === undefined) {
      throw ctx.fail.missingCredential(
        "Missing Fireworks API key. Add one in Settings or set FIREWORKS_API_KEY.",
      );
    }
    const slug = resolveFireworksAccountSlug(ctx.settings);
    if (slug === undefined) {
      throw ctx.fail.missingCredential(
        "Missing Fireworks account slug. Set FIREWORKS_ACCOUNT_SLUG or the slug field in Settings.",
      );
    }
    if (slug === "." || slug === ".." || !accountSlugPattern.test(slug)) {
      // The shared failure taxonomy has no separate invalid-config lane. Keep this local,
      // actionable condition in the credential/config lane; it must never look like an API fault.
      throw ctx.fail.missingCredential(
        `Invalid Fireworks account slug '${slug}'. Please double-check the account slug in Settings.`,
      );
    }

    const end = ctx.date.now();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const response = await get(ctx, resolveFireworksSummaryURL(slug, start, end), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      timeoutSeconds: 15,
    });
    if (response.status === 401 || response.status === 403) {
      throw ctx.fail.authenticationExpired(
        "Fireworks rejected the API key. Create a new key at app.fireworks.ai and update Settings.",
      );
    }
    if (response.status === 429) {
      throw ctx.fail.rateLimited(
        "Fireworks rate limit exceeded. Usage will refresh on the next cycle.",
      );
    }
    if (response.status !== 200) {
      throw ctx.fail.apiFailure(`Fireworks billing API returned HTTP ${response.status}.`);
    }
    try {
      return parseFireworksSummary(json(ctx, "Fireworks", response));
    } catch (error) {
      if (error instanceof InvalidFireworksSummary) {
        throw ctx.fail.parseFailure(`Could not parse Fireworks usage: ${error.message}`);
      }
      throw error;
    }
  },
};

const strategy: ProviderStrategy = {
  id: "fireworks.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};

export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const fireworks: FirstPartyProvider = { ...strategy, descriptor };
