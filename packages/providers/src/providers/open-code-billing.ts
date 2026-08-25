export interface OpenCodeZenBillingInfo {
  readonly monthlyUsageUSD: number;
  readonly monthlyLimitUSD?: number;
  readonly balanceUSD?: number;
  readonly hasSubscription: boolean;
  readonly usageUpdatedAt?: string;
}

const usdScale = 100_000_000;

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === "boolean") return undefined;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const findCustomer = (value: unknown): Record<string, unknown> | undefined => {
  const record = object(value);
  if (record) {
    if (typeof record.customerID === "string" && record.customerID !== "") return record;
    for (const child of Object.values(record)) {
      const found = findCustomer(child);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findCustomer(child);
      if (found) return found;
    }
  }
  return undefined;
};

const isoDate = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
  }
  const numeric = finiteNumber(value);
  if (numeric === undefined) return undefined;
  const millis =
    numeric > 1_000_000_000_000 ? numeric : numeric > 1_000_000_000 ? numeric * 1000 : NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
};

const fromCustomer = (customer: Record<string, unknown>): OpenCodeZenBillingInfo | undefined => {
  const rawUsage = finiteNumber(customer.monthlyUsage);
  if (rawUsage === undefined) return undefined;
  const monthlyLimitUSD = finiteNumber(customer.monthlyLimit);
  const rawBalance = finiteNumber(customer.balance);
  const usageUpdatedAt = isoDate(customer.timeMonthlyUsageUpdated);
  return {
    monthlyUsageUSD: rawUsage / usdScale,
    ...(monthlyLimitUSD === undefined ? {} : { monthlyLimitUSD }),
    ...(rawBalance === undefined ? {} : { balanceUSD: rawBalance / usdScale }),
    hasSubscription: customer.subscription !== undefined && customer.subscription !== null,
    ...(usageUpdatedAt === undefined ? {} : { usageUpdatedAt }),
  };
};

const fieldPattern = (field: string, value: string): RegExp =>
  new RegExp(`(?:"${field}"|${field})\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?${value}`, "u");

const numberField = (field: string, text: string): number | undefined => {
  const capture = fieldPattern(field, "(-?[0-9]+(?:\\.[0-9]+)?)").exec(text)?.[1];
  return capture === undefined ? undefined : finiteNumber(capture);
};

const payloadDate = (field: string, text: string): string | undefined => {
  const capture = fieldPattern(field, '(?:new\\s+Date\\(\\s*)?"([^"]+)"').exec(text)?.[1];
  return isoDate(capture);
};

const parsePayload = (text: string): OpenCodeZenBillingInfo | undefined => {
  if (!fieldPattern("customerID", '"[^"]+"').test(text)) return undefined;
  const rawUsage = numberField("monthlyUsage", text);
  if (rawUsage === undefined) return undefined;
  const monthlyLimitUSD = numberField("monthlyLimit", text);
  const rawBalance = numberField("balance", text);
  const subscription = fieldPattern("subscription", "([^,}]+)").exec(text)?.[1]?.trim();
  const usageUpdatedAt = payloadDate("timeMonthlyUsageUpdated", text);
  return {
    monthlyUsageUSD: rawUsage / usdScale,
    ...(monthlyLimitUSD === undefined ? {} : { monthlyLimitUSD }),
    ...(rawBalance === undefined ? {} : { balanceUSD: rawBalance / usdScale }),
    hasSubscription: subscription !== undefined && subscription !== "null",
    ...(usageUpdatedAt === undefined ? {} : { usageUpdatedAt }),
  };
};

/** Ports OpenCodeZenBillingParser, including SolidStart payloads and the fixed-point USD scale. */
export const parseOpenCodeZenBilling = (text: string): OpenCodeZenBillingInfo | undefined => {
  try {
    const customer = findCustomer(JSON.parse(text) as unknown);
    if (customer) return fromCustomer(customer);
  } catch {
    // SolidStart server-function responses are JavaScript payloads rather than JSON.
  }
  return parsePayload(text);
};
