import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object } from "./_http.ts";

const cleanAPIKey = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value === "" ? undefined : value;
};

const optionalString = (
  ctx: ProviderContext,
  holder: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = holder[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw ctx.fail.parseFailure(`ai& logs field ${key} must be a string or null.`);
  }
  return value;
};

const optionalBoolean = (
  ctx: ProviderContext,
  holder: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined => {
  const value = holder[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw ctx.fail.parseFailure(`ai& logs field ${key} must be a boolean or null.`);
  }
  return value;
};

const encodeCursor = (value: string): string => encodeURIComponent(value).replaceAll("%3A", ":");

const logsURL = (after: string | undefined, afterID: string | undefined): string => {
  let url = "https://api.aiand.com/logs?range=30days&limit=100";
  if (after !== undefined) url += `&after=${encodeCursor(after)}`;
  if (afterID !== undefined) url += `&after_id=${encodeCursor(afterID)}`;
  return url;
};

const checkStatus = (ctx: ProviderContext, status: number): void => {
  if (status === 401) {
    throw ctx.fail.authenticationExpired(
      "ai& rejected the API key. Create a new key at console.aiand.com and update Settings.",
    );
  }
  if (status === 402) {
    throw ctx.fail.permissionDenied(
      "ai& reports the organization is out of credits. Top up at console.aiand.com.",
    );
  }
  if (status === 429) {
    throw ctx.fail.rateLimited("ai& rate limit exceeded. Usage will refresh on the next cycle.");
  }
  if (status < 200 || status >= 300) {
    throw ctx.fail.apiFailure(`ai& logs API returned HTTP ${status}.`);
  }
};

const definition: ProviderDefinition = {
  id: "aiand",
  name: "ai&",
  endpoints: ["https://api.aiand.com"],
  auth: { type: "bearer", secret: "AIAND_API_KEY" },
  settings: [{ key: "AIAND_API_KEY", title: "API key", type: "secure" }],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      cleanAPIKey(ctx.settings.getSecret("AIAND_API_KEY")) ??
      cleanAPIKey(ctx.settings.get("AIAND_API_KEY"));
    if (!key) {
      throw ctx.fail.missingCredential(
        "Missing ai& API key. Add one in Settings or set AIAND_API_KEY.",
      );
    }
    let after: string | undefined;
    let afterID: string | undefined;
    let complete = false;
    let totalScaled = 0n;
    let scale = 0;
    let currency: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await get(ctx, logsURL(after, afterID), {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      checkStatus(ctx, response.status);
      const root = object(json(ctx, "ai&", response));
      if (!root) throw ctx.fail.parseFailure("ai& logs response must be an object.");
      if (!Array.isArray(root.data)) {
        throw ctx.fail.parseFailure("ai& logs response data must be an array.");
      }
      const hasMore = optionalBoolean(ctx, root, "has_more");
      const nextAfter = optionalString(ctx, root, "next_after");
      const nextAfterID = optionalString(ctx, root, "next_after_id");
      const rows = root.data;
      for (const raw of rows) {
        const row = object(raw);
        if (!row) throw ctx.fail.parseFailure("ai& logs row must be an object.");
        const rawCost = optionalString(ctx, row, "cost");
        const rawCurrency = optionalString(ctx, row, "currency");
        const code = rawCurrency?.trim().toUpperCase();
        if (rawCost !== undefined && code && /^-?(?:\d+)(?:\.\d+)?$/u.test(rawCost)) {
          currency ??= code;
          if (currency === code) {
            const [whole, fractional = ""] = rawCost.split(".");
            const nextScale = fractional.length;
            if (nextScale > scale) {
              totalScaled *= 10n ** BigInt(nextScale - scale);
              scale = nextScale;
            }
            totalScaled += BigInt(`${whole}${fractional}`) * 10n ** BigInt(scale - nextScale);
          }
        }
      }
      if (hasMore !== true) {
        complete = true;
        break;
      }
      if (nextAfter === undefined || nextAfterID === undefined) break;
      after = nextAfter;
      afterID = nextAfterID;
    }
    return currency
      ? {
          cost: {
            used: Number(totalScaled) / 10 ** scale,
            limit: 0,
            currency,
            period: complete ? "Last 30 days" : "Last 30 days (partial)",
          },
          dataConfidence: complete ? "exact" : "estimated",
        }
      : { dataConfidence: complete ? "exact" : "estimated" };
  },
};
const strategy: ProviderStrategy = {
  id: "aiand.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const aiand: FirstPartyProvider = { ...strategy, descriptor };
