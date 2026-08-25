import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { get, json, object } from "./_http.ts";

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

const managementURL = (base: URL, path: string, query?: readonly [string, string]): URL => {
  const url = new URL(base);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-1) === "v1") parts.pop();
  url.pathname = `/${[...parts, ...path.split("/").filter(Boolean)].map(encodeURIComponent).join("/")}`;
  url.search = "";
  if (query) url.searchParams.set(query[0], query[1]);
  return url;
};

const iso = (value: unknown, ctx: ProviderContext, field: string): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw ctx.fail.parseFailure(`LiteLLM ${field} must be a string.`);
  }
  const text = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text) ||
    !Number.isFinite(Date.parse(text))
  )
    return undefined;
  return ctx.date.iso(text);
};

const optionalNumber = (
  ctx: ProviderContext,
  value: unknown,
  field: string,
): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw ctx.fail.parseFailure(`LiteLLM ${field} must be a number.`);
  }
  return value;
};

const optionalString = (
  ctx: ProviderContext,
  value: unknown,
  field: string,
): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw ctx.fail.parseFailure(`LiteLLM ${field} must be a string.`);
  }
  return value;
};

type ParsedTeam = {
  readonly teamID: string;
  readonly alias?: string;
  readonly spend: number;
  readonly budget?: number;
  readonly reset?: string;
};

const parseTeams = (ctx: ProviderContext, value: unknown): readonly ParsedTeam[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw ctx.fail.parseFailure("LiteLLM teams must be an array.");
  }
  return value.map((raw, index) => {
    const team = object(raw);
    if (!team) throw ctx.fail.parseFailure(`LiteLLM teams[${index}] must be an object.`);
    const teamID = optionalString(ctx, team.team_id, `teams[${index}].team_id`);
    if (teamID === undefined) {
      throw ctx.fail.parseFailure(`LiteLLM teams[${index}].team_id is required.`);
    }
    const alias = clean(optionalString(ctx, team.team_alias, `teams[${index}].team_alias`));
    const spend = optionalNumber(ctx, team.spend, `teams[${index}].spend`) ?? 0;
    const budget = optionalNumber(ctx, team.max_budget, `teams[${index}].max_budget`);
    const reset = iso(team.budget_reset_at, ctx, `teams[${index}].budget_reset_at`);
    optionalString(ctx, team.budget_duration, `teams[${index}].budget_duration`);
    return {
      teamID,
      ...(alias ? { alias } : {}),
      spend,
      ...(budget === undefined ? {} : { budget }),
      ...(reset === undefined ? {} : { reset }),
    };
  });
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
  if (response.status < 200 || response.status >= 300) {
    throw ctx.fail.apiFailure(
      `LiteLLM API returned HTTP ${response.status}: ${response.bodyText.slice(0, 500).trim()}`,
    );
  }
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
    const base = normalizeEndpoint(configured, { transport: "private-network-http" });
    if (!base)
      throw ctx.fail.apiFailure(
        "LITELLM_BASE_URL is not a valid secure or private-network endpoint.",
      );

    const keyRoot = await request(ctx, managementURL(base, "key/info"), key);
    if (!keyRoot) throw ctx.fail.parseFailure("LiteLLM /key/info response must be an object.");
    const info = object(keyRoot.info);
    if (!info) throw ctx.fail.parseFailure("LiteLLM /key/info response did not include info.");
    const userID = clean(optionalString(ctx, info.user_id, "info.user_id"));
    const teamID = clean(optionalString(ctx, info.team_id, "info.team_id"));
    const keyName = clean(optionalString(ctx, info.key_name, "info.key_name"));
    optionalNumber(ctx, info.spend, "info.spend");
    const expiresAt = iso(info.expires, ctx, "info.expires");
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
      const responseID =
        optionalString(ctx, user.user_id, "user_info.user_id") ??
        optionalString(ctx, root.user_id, "user_id");
      if (responseID && responseID !== keyInfo.userID)
        throw ctx.fail.parseFailure("LiteLLM user_id did not match /key/info.");
      const spend = optionalNumber(ctx, user.spend, "user_info.spend") ?? 0;
      const budget = optionalNumber(ctx, user.max_budget, "user_info.max_budget");
      const reset = iso(user.budget_reset_at, ctx, "user_info.budget_reset_at");
      const teams = parseTeams(ctx, root.teams);
      const team = keyInfo.teamID
        ? teams.find((item) => item.teamID === keyInfo.teamID)
        : undefined;
      const teamSpend = team?.spend ?? 0;
      const teamBudget = team?.budget;
      const teamReset = team?.reset;
      const teamAlias = team?.alias;
      const userEmail = clean(optionalString(ctx, user.user_email, "user_info.user_email"));
      const userAlias = clean(optionalString(ctx, user.user_alias, "user_info.user_alias"));
      let preferredUsername: string | undefined;
      if (user.metadata !== null && user.metadata !== undefined) {
        const metadata = object(user.metadata);
        if (!metadata) {
          throw ctx.fail.parseFailure("LiteLLM user_info.metadata must be an object.");
        }
        preferredUsername =
          typeof metadata.preferred_username === "string"
            ? clean(metadata.preferred_username)
            : undefined;
      }
      const email = userEmail ?? userAlias ?? preferredUsername;
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
    const responseID =
      clean(optionalString(ctx, team.team_id, "team_info.team_id")) ??
      clean(optionalString(ctx, root.team_id, "team_id"));
    if (responseID && responseID !== keyInfo.teamID)
      throw ctx.fail.parseFailure("LiteLLM team_id did not match /key/info.");
    const spend = optionalNumber(ctx, team.spend, "team_info.spend") ?? 0;
    const budget = optionalNumber(ctx, team.max_budget, "team_info.max_budget");
    const reset = iso(team.budget_reset_at, ctx, "team_info.budget_reset_at");
    optionalString(ctx, team.budget_duration, "team_info.budget_duration");
    const alias = clean(optionalString(ctx, team.team_alias, "team_info.team_alias"));
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
