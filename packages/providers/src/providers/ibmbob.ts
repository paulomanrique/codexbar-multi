import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";

const trustedHost = (host: string): boolean =>
  host === "bob.ibm.com" || host.endsWith(".bob.ibm.com");
const isJWT = (token: string): boolean => {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = parts[1]?.replace(/-/g, "+").replace(/_/g, "/");
    if (!payload) return false;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = typeof atob === "function" ? atob(padded) : "";
    const value = JSON.parse(decoded) as unknown;
    return object(value) !== undefined;
  } catch {
    return false;
  }
};
const amount = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

const definition: ProviderDefinition = {
  id: "ibmbob",
  name: "IBM Bob",
  endpoints: [{ domainSuffix: "bob.ibm.com", policy: "https" }],
  auth: { type: "provider-managed", scheme: "Apikey", secret: "BOBSHELL_API_KEY" },
  settings: [{ key: "BOBSHELL_API_KEY", title: "API key", type: "secure" }],
  fetchUsage: async (ctx) => {
    const rawKey =
      ctx.settings.getSecret("BOBSHELL_API_KEY") || ctx.settings.get("BOBSHELL_API_KEY");
    const key = rawKey
      ?.trim()
      .replace(/^("([\s\S]*)"|'([\s\S]*)')$/, "$2$3")
      .trim();
    if (!key) throw ctx.fail.missingCredential("Missing IBM Bob API key.");
    const authorization = isJWT(key) ? `Bearer ${key}` : `Apikey ${key}`;
    const headers = {
      Authorization: authorization,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "CodexBar",
    };
    const profileResponse = await get(ctx, "https://api.us-east.bob.ibm.com/admin/v1/profile", {
      headers,
    });
    status(ctx, "IBM Bob", profileResponse);
    const profile = object(json(ctx, "IBM Bob", profileResponse));
    if (!profile || !Array.isArray(profile.instances))
      throw ctx.fail.parseFailure("IBM Bob profile must contain instances.");
    const teams: Array<{
      instance: string;
      team: string;
      plan?: string;
      used: number;
      limit?: number;
      reset?: string;
    }> = [];
    for (const rawInstance of profile.instances) {
      const instance = object(rawInstance);
      if (!instance) continue;
      const userID = string(instance.user_id);
      const instanceID = string(instance.instance_id);
      if (!userID || !instanceID) continue;
      const region = string(instance.region_domain);
      const host = region
        ? region.toLowerCase().startsWith("api.")
          ? region
          : `api.${region}`
        : "api.us-east.bob.ibm.com";
      try {
        const url = new URL(`https://${host}`);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          url.pathname !== "/" ||
          !url.hostname ||
          !trustedHost(url.hostname)
        )
          throw new Error("untrusted");
      } catch {
        throw ctx.fail.permissionDenied(
          `IBM Bob returned an untrusted regional API host: ${host}.`,
        );
      }
      if (!Array.isArray(instance.teams)) continue;
      for (const rawTeam of instance.teams) {
        const team = object(rawTeam);
        const teamID = string(team?.id);
        if (!team || !teamID) continue;
        const response = await get(
          ctx,
          `https://${host}/admin/v1/teams/${encodeURIComponent(teamID)}/users/${encodeURIComponent(userID)}`,
          { headers: { ...headers, "x-instance-id": instanceID, "x-team-id": teamID } },
        );
        status(ctx, "IBM Bob", response);
        const budget = object(json(ctx, "IBM Bob", response));
        const used = Math.max(0, number(budget?.usage) ?? 0);
        const rawLimit = number(budget?.budget_limit) ?? number(team.budget_limit);
        const limit = rawLimit !== undefined && rawLimit >= 0 ? rawLimit : undefined;
        const plan = string(instance.plan_name);
        const reset = date(instance.refresh_at, ctx);
        teams.push({
          instance: string(instance.instance_name ?? instance.name) || instanceID,
          team: string(team.name) || teamID,
          ...(plan ? { plan } : {}),
          used,
          ...(limit === undefined ? {} : { limit }),
          ...(reset ? { reset } : {}),
        });
      }
    }
    if (!teams.length)
      throw ctx.fail.apiFailure("IBM Bob returned no subscription instances or teams.");
    const used = teams.reduce((sum, team) => sum + team.used, 0);
    const limits = teams.every((team) => team.limit !== undefined)
      ? teams.reduce((sum, team) => sum + (team.limit || 0), 0)
      : undefined;
    const resets = teams
      .map((team) => team.reset)
      .filter((entry): entry is string => Boolean(entry))
      .sort();
    const plans = [
      ...new Set(teams.map((team) => team.plan).filter((entry): entry is string => Boolean(entry))),
    ].sort();
    return {
      primary: {
        usedPercent:
          limits !== undefined && limits > 0
            ? Math.max(0, Math.min(100, (used / limits) * 100))
            : 0,
        windowMinutes: 30 * 24 * 60,
        ...(resets[0] ? { resetsAt: resets[0] } : {}),
        resetDescription:
          limits !== undefined
            ? `${amount(used)} / ${amount(limits)} Bobcoins`
            : `${amount(used)} Bobcoins used`,
      },
      details: [
        {
          title: "Bobcoin usage",
          rows: teams.map((team) => ({
            label: team.instance === team.team ? team.team : `${team.instance} · ${team.team}`,
            value:
              team.limit !== undefined
                ? `${amount(team.used)} / ${amount(team.limit)} Bobcoins`
                : `${amount(team.used)} Bobcoins used`,
            ...(team.plan ? { secondaryValue: team.plan } : {}),
          })),
        },
      ],
      identity: {
        organization: plans.length ? plans.join(", ") : undefined,
        loginMethod: "API key",
      },
      dataConfidence: "exact",
    };
  },
};
const strategy: ProviderStrategy = {
  id: "ibmbob.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const ibmbob: FirstPartyProvider = { ...strategy, descriptor };
