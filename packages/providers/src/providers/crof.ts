import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "crof",
  name: "Crof",
  endpoints: ["https://crof.ai"],
  auth: { type: "bearer", secret: "CROF_API_KEY" },
  settings: [
    {
      key: "CROF_API_KEY",
      title: "API key",
      subtitle: "Crof API key used for the public usage endpoint.",
      type: "secure",
    },
  ],

  fetchUsage: async (ctx: ProviderContext) => {
    const response: any = await ctx.http.getJSON("https://crof.ai/usage_api/");
    if (response.status !== 200) throw new Error(`Crof API error: HTTP ${response.status}`);
    const payload: any = response.json;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Failed to parse Crof response: expected an object");
    }
    if (typeof payload.credits !== "number" || !Number.isFinite(payload.credits)) {
      throw new Error("Failed to parse Crof response: credits must be a number");
    }

    function optionalNumber(value: any, field: any) {
      if (value === null || value === undefined) return null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Failed to parse Crof response: ${field} must be a number`);
      }
      return value;
    }

    const requestsPlan: any = optionalNumber(payload.requests_plan, "requests_plan");
    const usableRequests: any = optionalNumber(payload.usable_requests, "usable_requests");
    const credits: any = Math.max(0, payload.credits);
    const creditsWindow: any = {
      usedPercent: credits > 0 ? 0 : 100,
      resetDescription: `$${(Math.floor(credits * 100) / 100).toFixed(2)}`,
    };

    if (requestsPlan === null || usableRequests === null) {
      return {
        primary: creditsWindow,
        identity: { loginMethod: "API key" },
      };
    }

    const clampedRemaining: any = Math.max(0, Math.min(requestsPlan, usableRequests));
    const remainingPercent: any =
      requestsPlan > 0
        ? Math.max(0, Math.min(100, Math.floor((clampedRemaining / requestsPlan) * 100)))
        : 0;
    const displayedRequests: any = Math.max(0, usableRequests);
    const requestText: any = Number.isInteger(displayedRequests)
      ? displayedRequests.toFixed(0)
      : displayedRequests.toFixed(2);
    return {
      primary: {
        usedPercent: 100 - remainingPercent,
        windowMinutes: 1440,
        resetsAt: ctx.date.nextDailyReset("America/Chicago", 0),
        resetDescription: `${requestText} requests left`,
      },
      secondary: creditsWindow,
      identity: { loginMethod: "API key" },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "crof.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const crof: FirstPartyProvider = { ...strategy, descriptor };
