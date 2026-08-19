import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "ibmbob",
  name: "IBM Bob",
  endpoints: ["https://api.us-east.bob.ibm.com"],
  auth: { type: "authorization-scheme", scheme: "Apikey", secret: "BOBSHELL_API_KEY" },
  settings: [{ key: "BOBSHELL_API_KEY", title: "API key", type: "secure" }],
  fetchUsage: async (ctx) => {
    const key = ctx.settings.getSecret("BOBSHELL_API_KEY") || ctx.settings.get("BOBSHELL_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing IBM Bob API key.");
    const auth = key.split(".").length === 3 ? `Bearer ${key}` : `Apikey ${key}`;
    const headers = {
      Authorization: auth,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "CodexBar",
    };
    const profile = await get(ctx, "https://api.us-east.bob.ibm.com/admin/v1/profile", { headers });
    status(ctx, "IBM Bob", profile);
    const parsed = object(json(ctx, "IBM Bob", profile));
    if (!parsed) throw ctx.fail.parseFailure("IBM Bob response must be an object.");
    const root = parsed;
    const instances = Array.isArray(root.instances) ? root.instances : [];
    const teams: Array<Record<string, unknown>> = [];
    for (const raw of instances) {
      const instance = object(raw);
      const userID = string(instance?.user_id);
      const instanceID = string(instance?.instance_id);
      if (!instance || !userID || !instanceID) continue;
      const listed = Array.isArray(instance.teams) ? instance.teams : [];
      for (const rawTeam of listed) {
        const team = object(rawTeam);
        if (!team) continue;
        const teamID = string(team.id);
        if (!teamID) continue;
        const domain = string(instance.region_domain) || "api.us-east.bob.ibm.com";
        const host = domain.startsWith("api.") ? domain : `api.${domain}`;
        if (host !== "api.bob.ibm.com" && !host.endsWith(".bob.ibm.com"))
          throw ctx.fail.permissionDenied(
            `IBM Bob returned an untrusted regional API host: ${host}.`,
          );
        const response = await get(
          ctx,
          `https://${host}/admin/v1/teams/${encodeURIComponent(teamID)}/users/${encodeURIComponent(userID)}`,
          { headers: { ...headers, "x-instance-id": instanceID, "x-team-id": teamID } },
        );
        status(ctx, "IBM Bob", response);
        const budget = object(json(ctx, "IBM Bob", response));
        const used = Math.max(0, number(budget?.usage) ?? 0);
        const limit = number(budget?.budget_limit) ?? number(team.budget_limit);
        teams.push({
          instance: string(instance.instance_name ?? instance.name) || instanceID,
          team: string(team.name) || teamID,
          plan: string(instance.plan_name),
          used,
          limit,
          reset: date(instance.refresh_at, ctx),
        });
      }
    }
    if (!teams.length)
      throw ctx.fail.apiFailure("IBM Bob returned no subscription instances or teams.");
    const used = teams.reduce((sum, team) => sum + (team.used as number), 0);
    const limits = teams.map((team) => team.limit).every((v) => typeof v === "number")
      ? teams.reduce((sum, team) => sum + (team.limit as number), 0)
      : undefined;
    return {
      primary: {
        usedPercent: limits && limits > 0 ? (used / limits) * 100 : 0,
        windowMinutes: 43200,
        resetsAt: teams
          .map((team) => team.reset)
          .filter((v): v is string => typeof v === "string")
          .sort()[0],
        resetDescription:
          limits !== undefined ? `${used} / ${limits} Bobcoins` : `${used} Bobcoins used`,
      },
      details: [
        {
          title: "Bobcoin usage",
          rows: teams.map((team) => ({
            label: `${team.instance} · ${team.team}`,
            value:
              team.limit !== undefined
                ? `${team.used} / ${team.limit} Bobcoins`
                : `${team.used} Bobcoins used`,
            secondaryValue: team.plan,
          })),
        },
      ],
      identity: {
        organization:
          Array.from(
            new Set(
              teams.map((team) => team.plan).filter((v): v is string => typeof v === "string"),
            ),
          ).join(", ") || undefined,
        loginMethod: "API key",
      },
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
