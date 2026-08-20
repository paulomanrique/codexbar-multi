import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";

const clean = (value: string | undefined): string | undefined => {
  let result = value?.trim();
  if (!result) return undefined;
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  )
    result = result.slice(1, -1).trim();
  return result || undefined;
};

const endpoint = (raw: string): URL | undefined => {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const privateIPv4 = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host);
    const privateHost =
      privateIPv4 || host === "localhost" || host.endsWith(".local") || host === "[::1]";
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost))
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
};

const managementURL = (base: URL, path: string, query?: readonly [string, string]): URL => {
  const url = new URL(base);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "v1") parts.pop();
  url.pathname = `/${[...parts, ...path.split("/").filter(Boolean)].map(encodeURIComponent).join("/")}`;
  url.search = "";
  if (query) url.searchParams.set(query[0], query[1]);
  return url;
};

const iso = (value: unknown, ctx: ProviderContext): string | undefined => {
  const text = string(value);
  if (!text || !Number.isFinite(Date.parse(text))) return undefined;
  return ctx.date.iso(text);
};

const money = (ctx: ProviderContext, value: number): string => ctx.format.usd(value);
const budgetWindow = (
  ctx: ProviderContext,
  spend: number,
  budget: number | undefined,
  reset: string | undefined,
  description: string,
) =>
  budget !== undefined && budget > 0
    ? {
        usedPercent: ctx.pct(spend, budget),
        ...(reset ? { resetsAt: reset } : {}),
        resetDescription: description,
      }
    : undefined;

const apiKey = (ctx: ProviderContext): string | undefined =>
  clean(ctx.settings.getSecret("LITELLM_API_KEY") ?? ctx.settings.get("LITELLM_API_KEY"));

type KeyInfo = {
  readonly userID?: string;
  readonly teamID?: string;
  readonly keyName?: string;
  readonly expiresAt?: string;
};

const request = async (ctx: ProviderContext, url: URL, key: string) => {
  const response = await get(ctx, url.href, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  status(ctx, "LiteLLM", response);
  return object(json(ctx, "LiteLLM", response));
};

const definition: ProviderDefinition = {
  id: "litellm",
  name: "LiteLLM",
  endpoints: [{ setting: "LITELLM_BASE_URL", policy: "https-or-private-network-http" }],
  auth: { type: "bearer", secret: "LITELLM_API_KEY" },
  settings: [
    { key: "LITELLM_API_KEY", title: "API key", type: "secure" },
    { key: "LITELLM_BASE_URL", title: "Base URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key = apiKey(ctx);
    if (!key) throw ctx.fail.missingCredential("Missing LiteLLM API key.");
    const configured = clean(ctx.settings.get("LITELLM_BASE_URL"));
    if (!configured) throw ctx.fail.missingCredential("Missing LiteLLM base URL.");
    const base = endpoint(configured);
    if (!base)
      throw ctx.fail.apiFailure(
        "LITELLM_BASE_URL is not a valid secure or private-network endpoint.",
      );

    const keyRoot = await request(ctx, managementURL(base, "key/info"), key);
    if (!keyRoot) throw ctx.fail.parseFailure("LiteLLM /key/info response must be an object.");
    const info = object(keyRoot.info);
    if (!info) throw ctx.fail.parseFailure("LiteLLM /key/info response did not include info.");
    const userID = string(info.user_id);
    const teamID = string(info.team_id);
    const keyName = string(info.key_name);
    const expiresAt = iso(info.expires, ctx);
    const keyInfo: KeyInfo = {
      ...(userID ? { userID } : {}),
      ...(teamID ? { teamID } : {}),
      ...(keyName ? { keyName } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    if (!keyInfo.userID && !keyInfo.teamID)
      throw ctx.fail.parseFailure("LiteLLM key info did not include a user_id or team_id.");

    if (keyInfo.userID) {
      const root = await request(
        ctx,
        managementURL(base, "user/info", ["user_id", keyInfo.userID]),
        key,
      );
      const user = object(root?.user_info);
      if (!root || !user)
        throw ctx.fail.parseFailure("LiteLLM /user/info response did not include user_info.");
      const responseID = string(user.user_id) ?? string(root.user_id);
      if (responseID && responseID !== keyInfo.userID)
        throw ctx.fail.parseFailure("LiteLLM user_id did not match /key/info.");
      const spend = number(user.spend) ?? 0;
      const budget = number(user.max_budget);
      const reset = iso(user.budget_reset_at, ctx);
      const teams = Array.isArray(root.teams)
        ? root.teams.map(object).filter((team): team is Record<string, unknown> => Boolean(team))
        : [];
      const team = keyInfo.teamID
        ? teams.find((item) => string(item.team_id) === keyInfo.teamID)
        : undefined;
      const teamSpend = number(team?.spend) ?? 0;
      const teamBudget = number(team?.max_budget);
      const teamReset = iso(team?.budget_reset_at, ctx);
      const teamAlias = string(team?.team_alias);
      const email =
        string(user.user_email) ??
        string(user.user_alias) ??
        string(object(user.metadata)?.preferred_username);
      const output: Record<string, unknown> = {
        ...(budgetWindow(
          ctx,
          spend,
          budget,
          reset,
          `${money(ctx, spend)} / ${money(ctx, budget ?? 0)}`,
        )
          ? {
              primary: budgetWindow(
                ctx,
                spend,
                budget,
                reset,
                `${money(ctx, spend)} / ${money(ctx, budget ?? 0)}`,
              ),
            }
          : {}),
        ...(team &&
        budgetWindow(
          ctx,
          teamSpend,
          teamBudget,
          teamReset,
          `${teamAlias ? `Team ${teamAlias}` : "Team"}: ${money(ctx, teamSpend)} / ${money(ctx, teamBudget ?? 0)}`,
        )
          ? {
              secondary: budgetWindow(
                ctx,
                teamSpend,
                teamBudget,
                teamReset,
                `${teamAlias ? `Team ${teamAlias}` : "Team"}: ${money(ctx, teamSpend)} / ${money(ctx, teamBudget ?? 0)}`,
              ),
            }
          : {}),
        ...(spend > 0 || (budget ?? 0) > 0
          ? {
              providerCost: {
                used: spend,
                limit: Math.max(0, budget ?? 0),
                currency: "USD",
                period: budget && budget > 0 ? "Personal budget" : "Personal spend",
                ...(reset ? { resetsAt: reset } : {}),
              },
            }
          : {}),
        ...(keyInfo.expiresAt ? { subscriptionExpiresAt: keyInfo.expiresAt } : {}),
        identity: {
          ...(email ? { email } : {}),
          ...(teamAlias ? { organization: teamAlias } : {}),
          loginMethod: "api",
        },
        dataConfidence: "exact",
      };
      return output;
    }

    const root = await request(
      ctx,
      managementURL(base, "team/info", ["team_id", keyInfo.teamID!]),
      key,
    );
    const team = object(root?.team_info);
    if (!root || !team)
      throw ctx.fail.parseFailure("LiteLLM /team/info response did not include team_info.");
    const responseID = string(team.team_id) ?? string(root.team_id);
    if (responseID && responseID !== keyInfo.teamID)
      throw ctx.fail.parseFailure("LiteLLM team_id did not match /key/info.");
    const spend = number(team.spend) ?? 0;
    const budget = number(team.max_budget);
    const reset = iso(team.budget_reset_at, ctx);
    const alias = string(team.team_alias);
    return {
      ...(budgetWindow(
        ctx,
        spend,
        budget,
        reset,
        `${alias ? `Team ${alias}` : "Team"}: ${money(ctx, spend)} / ${money(ctx, budget ?? 0)}`,
      )
        ? {
            secondary: budgetWindow(
              ctx,
              spend,
              budget,
              reset,
              `${alias ? `Team ${alias}` : "Team"}: ${money(ctx, spend)} / ${money(ctx, budget ?? 0)}`,
            ),
          }
        : {}),
      ...(spend > 0 || (budget ?? 0) > 0
        ? {
            providerCost: {
              used: spend,
              limit: Math.max(0, budget ?? 0),
              currency: "USD",
              period: budget && budget > 0 ? "Team budget" : "Team spend",
              ...(reset ? { resetsAt: reset } : {}),
            },
          }
        : {}),
      ...(keyInfo.expiresAt ? { subscriptionExpiresAt: keyInfo.expiresAt } : {}),
      identity: { ...(alias ? { organization: alias } : {}), loginMethod: "api" },
      dataConfidence: "exact",
    };
  },
};

const strategy: ProviderStrategy = {
  id: "litellm.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const litellm: FirstPartyProvider = { ...strategy, descriptor };
