import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "synthetic",
  name: "Synthetic",
  endpoints: ["https://api.synthetic.new"],
  auth: { type: "bearer", secret: "SYNTHETIC_API_KEY" },
  settings: [
    {
      key: "SYNTHETIC_API_KEY",
      title: "API key",
      subtitle: "Synthetic API key used for the quota endpoint.",
      type: "secure",
    },
  ],

  fetchUsage: async (ctx: ProviderContext) => {
    const response: any = await ctx.http.getJSON("https://api.synthetic.new/v2/quotas");
    if (response.status === 401 || response.status === 403) {
      throw new Error("Invalid Synthetic API credentials");
    }
    if (response.status !== 200) throw new Error(`Synthetic API error: HTTP ${response.status}`);

    const object: any = response.json;
    const root: any = Array.isArray(object) ? { quotas: object } : object;
    if (!root || typeof root !== "object") {
      throw new Error("Failed to parse Synthetic response: expected an object or array");
    }

    const labelKeys: any = ["name", "label", "type", "period", "scope", "title", "id"];
    const percentUsedKeys: any = [
      "percentUsed",
      "usedPercent",
      "usagePercent",
      "usage_percent",
      "used_percent",
      "percent_used",
      "percent",
    ];
    const percentRemainingKeys: any = [
      "percentRemaining",
      "remainingPercent",
      "remaining_percent",
      "percent_remaining",
    ];
    const limitKeys: any = [
      "limit",
      "messageLimit",
      "message_limit",
      "messages",
      "maxRequests",
      "max_requests",
      "requestLimit",
      "request_limit",
      "quota",
      "max",
      "total",
      "capacity",
      "allowance",
    ];
    const usedKeys: any = [
      "used",
      "usage",
      "usedMessages",
      "used_messages",
      "messagesUsed",
      "messages_used",
      "requests",
      "requestCount",
      "request_count",
      "consumed",
      "spent",
    ];
    const remainingKeys: any = ["remaining", "left", "available", "balance"];
    const resetKeys: any = [
      "resetAt",
      "reset_at",
      "resetsAt",
      "resets_at",
      "renewAt",
      "renew_at",
      "renewsAt",
      "renews_at",
      "nextTickAt",
      "next_tick_at",
      "nextRegenAt",
      "next_regen_at",
      "periodEnd",
      "period_end",
      "expiresAt",
      "expires_at",
      "endAt",
      "end_at",
    ];
    const planKeys: any = [
      "plan",
      "planName",
      "plan_name",
      "subscription",
      "subscriptionPlan",
      "tier",
      "package",
      "packageName",
    ];

    function stringValue(value: any) {
      if (typeof value !== "string") return null;
      const trimmed: any = value.trim();
      return trimmed.length ? trimmed : null;
    }

    function numberValue(value: any) {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "string" && value.trim().length) {
        const number: any = Number(value.trim());
        return Number.isFinite(number) ? number : null;
      }
      return null;
    }

    function firstString(payload: any, keys: any) {
      for (const key of keys) {
        const value: any = stringValue(payload[key]);
        if (value !== null) return value;
      }
      return null;
    }

    function firstNumber(payload: any, keys: any) {
      for (const key of keys) {
        const value: any = numberValue(payload[key]);
        if (value !== null) return value;
      }
      return null;
    }

    function parseDate(value: any) {
      const number: any = numberValue(value);
      if (number !== null) {
        if (number > 1000000000000) return ctx.date.unixMillis(number);
        if (number > 1000000000) return ctx.date.unixSeconds(number);
      }
      if (typeof value === "string") {
        try {
          return ctx.date.iso(value);
        } catch {
          return null;
        }
      }
      return null;
    }

    function firstDate(payload: any, keys: any) {
      for (const key of keys) {
        if (payload[key] === null || payload[key] === undefined) continue;
        const date: any = parseDate(payload[key]);
        if (date !== null) return date;
      }
      return null;
    }

    function normalizedPercent(value: any) {
      if (value === null) return null;
      return value <= 1 ? value * 100 : value;
    }

    function currencyValue(value: any) {
      if (typeof value === "string") {
        const parsed: any = Number(value.trim().replace(/\$/g, "").replace(/,/g, ""));
        return Number.isFinite(parsed) ? parsed : null;
      }
      return numberValue(value);
    }

    function firstCurrency(payload: any, keys: any) {
      for (const key of keys) {
        const value: any = currencyValue(payload[key]);
        if (value !== null) return value;
      }
      return null;
    }

    function windowMinutes(payload: any) {
      const minutes: any = firstNumber(payload, [
        "windowMinutes",
        "window_minutes",
        "periodMinutes",
        "period_minutes",
      ]);
      if (minutes !== null) return Math.round(minutes);
      const hours: any = firstNumber(payload, [
        "windowHours",
        "window_hours",
        "periodHours",
        "period_hours",
      ]);
      if (hours !== null) return Math.round(hours * 60);
      const days: any = firstNumber(payload, [
        "windowDays",
        "window_days",
        "periodDays",
        "period_days",
      ]);
      if (days !== null) return Math.round(days * 1440);
      const seconds: any = firstNumber(payload, [
        "windowSeconds",
        "window_seconds",
        "periodSeconds",
        "period_seconds",
      ]);
      if (seconds !== null) return Math.round(seconds / 60);
      const text: any = firstString(payload, [
        "window",
        "windowLabel",
        "window_label",
        "period",
        "periodLabel",
        "period_label",
      ]);
      if (text === null) return null;
      const match: any = text
        .toLowerCase()
        .replace(/\s/g, "")
        .match(/^([0-9]*\.?[0-9]+)(minutes?|mins?|m|hours?|hrs?|hr|h|days?|d)$/);
      if (!match) return null;
      const multipliers: any = {
        m: 1,
        min: 1,
        mins: 1,
        minute: 1,
        minutes: 1,
        h: 60,
        hr: 60,
        hrs: 60,
        hour: 60,
        hours: 60,
        d: 1440,
        day: 1440,
        days: 1440,
      };
      return Math.round(Number(match[1]) * multipliers[match[2]]);
    }

    function windowDescription(minutes: any) {
      if (!minutes || minutes <= 0) return null;
      if (minutes % 1440 === 0) {
        const days: any = minutes / 1440;
        return `${days} day${days === 1 ? "" : "s"} window`;
      }
      if (minutes % 60 === 0) {
        const hours: any = minutes / 60;
        return `${hours} hour${hours === 1 ? "" : "s"} window`;
      }
      return `${minutes} minute${minutes === 1 ? "" : "s"} window`;
    }

    function isQuota(payload: any) {
      return (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        [limitKeys, usedKeys, remainingKeys, percentUsedKeys, percentRemainingKeys].some(
          (keys: any) => firstNumber(payload, keys) !== null,
        )
      );
    }

    function parseQuota(payload: any) {
      let usedPercent: any = normalizedPercent(firstNumber(payload, percentUsedKeys));
      const percentRemaining: any = normalizedPercent(firstNumber(payload, percentRemainingKeys));
      if (usedPercent === null && percentRemaining !== null) usedPercent = 100 - percentRemaining;

      if (usedPercent === null) {
        let limit: any = firstNumber(payload, limitKeys);
        let used: any = firstNumber(payload, usedKeys);
        let remaining: any = firstNumber(payload, remainingKeys);
        if (limit === null && used !== null && remaining !== null) limit = used + remaining;
        if (used === null && limit !== null && remaining !== null) used = limit - remaining;
        if (remaining === null && limit !== null && used !== null)
          remaining = Math.max(0, limit - used);
        if (limit !== null && used !== null && limit > 0) {
          usedPercent = ctx.pct(used, limit);
        }
      }
      if (usedPercent === null) return null;
      usedPercent = Math.max(0, Math.min(100, usedPercent));

      const minutes: any = windowMinutes(payload);
      const resetsAt: any = firstDate(payload, resetKeys);
      const window: any = { usedPercent };
      if (minutes !== null) window.windowMinutes = minutes;
      if (resetsAt !== null) window.resetsAt = resetsAt;
      else {
        const description: any = windowDescription(minutes);
        if (description !== null) window.resetDescription = description;
      }
      const tickPercent: any = normalizedPercent(
        firstNumber(payload, [
          "tickPercent",
          "tick_percent",
          "nextTickPercent",
          "next_tick_percent",
        ]),
      );
      if (tickPercent !== null) window.nextRegenPercent = tickPercent;

      const costLimit: any = firstCurrency(payload, ["maxCredits", "max_credits"]);
      let cost: any = null;
      if (costLimit !== null) {
        const remaining: any = firstCurrency(payload, ["remainingCredits", "remaining_credits"]);
        const explicitUsed: any = firstCurrency(payload, ["usedCredits", "used_credits"]);
        const used: any =
          explicitUsed !== null
            ? explicitUsed
            : remaining !== null
              ? Math.max(0, costLimit - remaining)
              : ctx.amountFromPercent(usedPercent, costLimit);
        cost = { used, limit: costLimit, currency: "USD", period: "Weekly" };
        if (resetsAt !== null) cost.resetsAt = resetsAt;
        const regen: any = firstCurrency(payload, ["nextRegenCredits", "next_regen_credits"]);
        if (regen !== null) cost.nextRegenAmount = regen;
      }
      return { label: firstString(payload, labelKeys), window, cost };
    }

    function namedQuota(candidate: any, label: any) {
      if (!isQuota(candidate)) return null;
      return Object.assign({ label }, candidate);
    }

    function collect(candidate: any): any[] {
      if (Array.isArray(candidate)) return candidate.flatMap(collect);
      if (!candidate || typeof candidate !== "object") return [];
      if (isQuota(candidate)) return [candidate];
      return Object.keys(candidate)
        .sort()
        .flatMap((key: any) => collect(candidate[key]));
    }

    const data: any = root.data && typeof root.data === "object" ? root.data : null;
    const slots: any = [
      namedQuota(root.rollingFiveHourLimit, "Rolling five-hour limit") ||
        namedQuota(data && data.rollingFiveHourLimit, "Rolling five-hour limit"),
      namedQuota(root.weeklyTokenLimit, "Weekly token limit") ||
        namedQuota(data && data.weeklyTokenLimit, "Weekly token limit"),
      namedQuota(root.search && root.search.hourly, "Search hourly") ||
        namedQuota(data && data.search && data.search.hourly, "Search hourly"),
    ];

    let parsed;
    if (slots.some(Boolean)) {
      parsed = slots.map((value: any) => (value ? parseQuota(value) : null));
    } else {
      const candidates: any = [
        root.quotas,
        root.quota,
        root.limits,
        root.usage,
        root.entries,
        root.subscription,
        root.data,
        data && data.quotas,
        data && data.quota,
        data && data.limits,
        data && data.usage,
        data && data.entries,
        data && data.subscription,
      ];
      let values: any = [];
      for (const candidate of candidates) {
        values = collect(candidate);
        if (values.length) break;
      }
      parsed = values.map(parseQuota).filter(Boolean);
    }
    if (!parsed.some(Boolean))
      throw new Error("Failed to parse Synthetic response: Missing quota data.");

    const plan: any = firstString(root, planKeys) || (data ? firstString(data, planKeys) : null);
    const snapshot: any = {
      primary: parsed[0] ? parsed[0].window : null,
      secondary: parsed[1] ? parsed[1].window : null,
      tertiary: parsed[2] ? parsed[2].window : null,
      identity: plan ? { loginMethod: plan } : {},
    };
    const withCost: any = parsed.find((value: any) => value && value.cost);
    if (withCost) snapshot.cost = withCost.cost;
    return snapshot;
  },
};
const strategy: ProviderStrategy = {
  id: "synthetic.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const synthetic: FirstPartyProvider = { ...strategy, descriptor };
