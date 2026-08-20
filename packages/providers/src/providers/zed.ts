import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "zed",
  name: "Zed",
  endpoints: ["https://cloud.zed.dev"],
  settings: [
    { key: "ZED_USER_ID", title: "User ID", type: "plain" },
    { key: "ZED_ACCESS_TOKEN", title: "Access token", type: "secure" },
    { key: "ZED_SERVER_URL", title: "Server URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const id = ctx.settings.get("ZED_USER_ID")?.trim();
    const token = ctx.settings.getSecret("ZED_ACCESS_TOKEN")?.trim();
    if (!id || !token)
      throw ctx.fail.missingCredential(
        "Zed credentials require the CredentialStore platform adapter.",
      );
    const base = ctx.settings.get("ZED_SERVER_URL")?.trim() || "https://cloud.zed.dev";
    let url: URL;
    try {
      url = new URL("client/users/me", `${base.replace(/\/$/, "")}/`);
      if (url.protocol !== "https:") throw new Error();
    } catch {
      throw ctx.fail.apiFailure("Zed server URL must use HTTPS.");
    }
    const response = await ctx.http.getJSON(url.href, {
      headers: { Authorization: `${id} ${token}`, Accept: "application/json" },
    });
    status(ctx, "Zed", response);
    const root = object(response.json);
    const plan = object(root?.plan);
    const usage = object(plan?.usage);
    const edits = object(usage?.edit_predictions);
    const used = number(edits?.used) ?? 0;
    const limit = number(edits?.limit);
    const period = object(plan?.subscription_period);
    const end = string(period?.ended_at);
    const planName = string(plan?.plan_v3);
    return {
      ...(limit && limit > 0
        ? {
            primary: {
              usedPercent: ctx.pct(used, limit),
              ...(end ? { resetsAt: ctx.date.iso(end) } : {}),
              resetDescription: `${ctx.format.number(used)} / ${ctx.format.number(limit)} edit predictions`,
            },
          }
        : { primary: { usedPercent: 0, resetDescription: "Unlimited edit predictions" } }),
      identity: {
        ...(string(object(root?.user)?.github_login)
          ? { accountID: string(object(root?.user)?.github_login) }
          : {}),
        ...(planName ? { loginMethod: planName.replace(/\b\w/g, (x) => x.toUpperCase()) } : {}),
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "zed.local",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const zed: FirstPartyProvider = { ...strategy, descriptor };
