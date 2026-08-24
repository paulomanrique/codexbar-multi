import type { ProviderContext } from "../types.ts";
import { get, object } from "./_http.ts";

const copilotProductID = "copilot";
const copilotPremiumRequestSKU = "copilot_premium_request";
const copilotAgentPremiumRequestSKU = "copilot_agent_premium_request";
const sparkPremiumRequestSKU = "spark_premium_request";
const copilotBudgetSelectors = new Set([
  copilotProductID,
  copilotPremiumRequestSKU,
  copilotAgentPremiumRequestSKU,
  sparkPremiumRequestSKU,
]);

const budgetPageURL = "https://github.com/settings/billing/budgets";
const maxBudgetPages = 20;

export type CopilotBudget = {
  readonly id?: string;
  readonly name?: string;
  readonly budgetType?: string;
  readonly budgetProductSkus: readonly string[];
  readonly budgetScope?: string;
  readonly budgetEntityName?: string;
  readonly budgetAmount: number;
  readonly currentAmount: number;
};

export type CopilotGitHubWebIdentity = {
  readonly id?: string;
  readonly login?: string;
};

type NamedWindow = {
  readonly id: string;
  readonly title: string;
  readonly window: {
    readonly usedPercent: number;
    readonly resetsAt?: string;
  };
};

const firstString = (
  root: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

export const parseBudgetAmount = (value: string): number | undefined => {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const rest = negative ? trimmed.slice(1) : trimmed;
  if (rest.includes("-")) return undefined;
  const unsigned = [...rest].filter((char) => /\d|\./u.test(char)).join("");
  if (!unsigned) return undefined;
  const parsed = Number(negative ? `-${unsigned}` : unsigned);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const decodeAmountValue = (value: unknown): number | undefined => {
  const root = object(value);
  if (!root) return undefined;
  for (const key of ["amount", "value", "total", "cents", "formatted"] as const) {
    const field = root[key];
    if (typeof field === "number" && Number.isFinite(field)) {
      return key === "cents" ? field / 100 : field;
    }
    if (typeof field === "string") {
      const parsed = parseBudgetAmount(field);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
};

const firstAmount = (
  root: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = parseBudgetAmount(value);
      if (parsed !== undefined) return parsed;
    }
    const nested = decodeAmountValue(value);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

const skuSelectors = (value: unknown): readonly string[] => {
  const root = object(value);
  if (!root) return [];
  return [
    "sku",
    "name",
    "display_name",
    "displayName",
    "product",
    "product_name",
    "productName",
  ].flatMap((key) => {
    const field = root[key];
    return typeof field === "string" && field !== "" ? [field] : [];
  });
};

const firstStringArray = (
  root: Record<string, unknown>,
  keys: readonly string[],
): readonly string[] => {
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value) && value.length > 0) {
      if (value.every((entry) => typeof entry === "string")) {
        return value.filter((entry) => entry !== "");
      }
      const fromObjects = value.flatMap(skuSelectors);
      if (fromObjects.length > 0) return fromObjects;
    }
    if (typeof value === "string" && value !== "") return [value];
  }
  return [];
};

const optionalString = (
  root: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => firstString(root, keys);

export const parseBudget = (value: unknown): CopilotBudget | undefined => {
  const root = object(value);
  if (!root) return undefined;
  const id = optionalString(root, ["id", "uuid", "budget_id", "budgetId"]);
  const name = optionalString(root, ["name", "display_name", "displayName", "title"]);
  const budgetType = optionalString(root, [
    "budget_type",
    "budgetType",
    "type",
    "pricing_target_type",
    "pricingTargetType",
  ]);
  const budgetScope = optionalString(root, ["budget_scope", "budgetScope", "scope"]);
  const budgetEntityName = optionalString(root, [
    "budget_entity_name",
    "budgetEntityName",
    "entity_name",
    "entityName",
    "target_name",
    "targetName",
  ]);
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(budgetType === undefined ? {} : { budgetType }),
    budgetProductSkus: firstStringArray(root, [
      "budget_product_skus",
      "budgetProductSkus",
      "budget_product_sku",
      "budgetProductSku",
      "product_skus",
      "productSkus",
      "skus",
      "sku",
      "product",
      "product_name",
      "productName",
      "pricing_target_id",
      "pricingTargetId",
    ]),
    ...(budgetScope === undefined ? {} : { budgetScope }),
    ...(budgetEntityName === undefined ? {} : { budgetEntityName }),
    budgetAmount:
      firstAmount(root, [
        "budget_amount",
        "budgetAmount",
        "target_amount",
        "targetAmount",
        "spending_limit",
        "spendingLimit",
        "limit",
        "amount",
        "max",
      ]) ?? 0,
    currentAmount:
      firstAmount(root, [
        "current_usage",
        "currentUsage",
        "current_amount",
        "currentAmount",
        "usage_amount",
        "usageAmount",
        "usage",
        "spent",
        "amount_used",
        "amountUsed",
      ]) ?? 0,
  };
};

export const parseBudgetResponse = (
  value: unknown,
): { readonly budgets: readonly CopilotBudget[]; readonly hasNextPage?: boolean } => {
  const root = object(value);
  if (!root) throw new Error("invalid-response");
  if (object(root.payload)) return parseBudgetResponse(root.payload);
  const rows = Array.isArray(root.budgets)
    ? root.budgets
    : root.budgets === undefined
      ? []
      : undefined;
  if (rows === undefined) throw new Error("invalid-response");
  const budgets = rows.flatMap((row) => {
    const budget = parseBudget(row);
    return budget ? [budget] : [];
  });
  const hasNextPage =
    typeof root.hasNextPage === "boolean"
      ? root.hasNextPage
      : typeof root.has_next_page === "boolean"
        ? root.has_next_page
        : undefined;
  return { budgets, ...(hasNextPage === undefined ? {} : { hasNextPage }) };
};

export const slug = (value: string): string => {
  let result = "";
  let lastWasDash = false;
  for (const char of value.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      result += char;
      lastWasDash = false;
    } else if (!lastWasDash) {
      result += "-";
      lastWasDash = true;
    }
  }
  return result.replace(/^-+|-+$/gu, "");
};

export const normalizedBillingIdentifier = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const slugValue = slug(value);
  if (!slugValue) return undefined;
  const underscored = slugValue.replaceAll("-", "_");
  if (underscored === copilotProductID) return copilotProductID;
  if (underscored === "premium_request" || underscored === "premium_requests") {
    return copilotPremiumRequestSKU;
  }
  if (
    underscored === "coding_agent_premium_request" ||
    underscored === "coding_agent_premium_requests"
  ) {
    return copilotAgentPremiumRequestSKU;
  }
  if (
    underscored.includes("spark") &&
    underscored.includes("premium") &&
    underscored.includes("request")
  ) {
    return sparkPremiumRequestSKU;
  }
  if (
    (underscored.includes("cloud") || underscored.includes("coding")) &&
    underscored.includes("agent") &&
    underscored.includes("premium") &&
    underscored.includes("request")
  ) {
    return copilotAgentPremiumRequestSKU;
  }
  if (
    underscored.includes("bundled") &&
    underscored.includes("premium") &&
    underscored.includes("request")
  ) {
    return copilotPremiumRequestSKU;
  }
  if (
    underscored.includes("copilot") &&
    underscored.includes("agent") &&
    underscored.includes("premium") &&
    underscored.includes("request")
  ) {
    return copilotAgentPremiumRequestSKU;
  }
  if (
    underscored.includes("copilot") &&
    underscored.includes("premium") &&
    underscored.includes("request")
  ) {
    return copilotPremiumRequestSKU;
  }
  return underscored;
};

const selectorsFor = (budget: CopilotBudget): Set<string> => {
  const values = [
    ...budget.budgetProductSkus,
    budget.budgetType,
    budget.budgetEntityName,
    budget.name,
  ];
  return new Set(
    values.flatMap((value) => {
      const identifier = normalizedBillingIdentifier(value);
      return identifier ? [identifier] : [];
    }),
  );
};

const isCopilotBudget = (budget: CopilotBudget, selectors: Set<string>): boolean => {
  if (budget.budgetAmount <= 0) return false;
  for (const selector of selectors) {
    if (copilotBudgetSelectors.has(selector)) return true;
  }
  return false;
};

const windowTitle = (budget: CopilotBudget, selectors: Set<string>): string => {
  const budgetType =
    selectors.size === 1 && selectors.has(copilotProductID)
      ? "Copilot"
      : selectors.has(copilotAgentPremiumRequestSKU)
        ? "Copilot Agent Premium Requests"
        : selectors.has(sparkPremiumRequestSKU)
          ? "Spark Premium Requests"
          : selectors.has(copilotPremiumRequestSKU)
            ? "All Premium Request SKUs"
            : budget.name?.trim()
              ? budget.name.trim()
              : "Copilot Premium Requests";
  return `Budget - ${budgetType}`;
};

const uniqueWindowID = (
  budget: CopilotBudget,
  selectors: Set<string>,
  usedIDs: Set<string>,
): string => {
  const source = budget.id ?? budget.budgetProductSkus.join("-");
  const slugValue = slug(source || windowTitle(budget, selectors));
  const base = slugValue ? `copilot-budget-${slugValue}` : "copilot-budget";
  let candidate = base;
  let suffix = 2;
  while (usedIDs.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIDs.add(candidate);
  return candidate;
};

export const approximateNextMonthResetDate = (ctx: ProviderContext): string | undefined => {
  const now = ctx.date.now();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Number.isFinite(next.getTime()) ? ctx.date.iso(next.toISOString()) : undefined;
};

export const extraRateWindowsFromBudgets = (
  budgets: readonly CopilotBudget[],
  ctx: ProviderContext,
): readonly NamedWindow[] => {
  const usedIDs = new Set<string>();
  const resetsAt = approximateNextMonthResetDate(ctx);
  return budgets.flatMap((budget) => {
    const selectors = selectorsFor(budget);
    if (!isCopilotBudget(budget, selectors)) return [];
    const usedPercent =
      budget.budgetAmount > 0
        ? Math.min(999, Math.max(0, (budget.currentAmount / budget.budgetAmount) * 100))
        : 0;
    return [
      {
        id: uniqueWindowID(budget, selectors, usedIDs),
        title: windowTitle(budget, selectors),
        window: {
          usedPercent,
          ...(resetsAt ? { resetsAt } : {}),
        },
      },
    ];
  });
};

export const extractFetchNonce = (html: string): string | undefined => {
  const patterns = [
    /x-fetch-nonce"\s+content="([^"]+)"/iu,
    /X-Fetch-Nonce"\s*:\s*"([^"]+)"/iu,
    /fetchNonce"\s*:\s*"([^"]+)"/iu,
    /data-fetch-nonce="([^"]+)"/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return undefined;
};

const extractMetaContent = (html: string, names: readonly string[]): string | undefined => {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  const contentByName = new Map<string, string>();
  for (const tagMatch of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = tagMatch[0] ?? "";
    const attributes = new Map<string, string>();
    for (const attribute of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(['"])(.*?)\2/giu)) {
      const key = attribute[1]?.toLowerCase();
      const value = attribute[3];
      if (key && value !== undefined) attributes.set(key, value);
    }
    const name = attributes.get("name")?.toLowerCase();
    const content = attributes.get("content")?.trim();
    if (!name || !expected.has(name) || contentByName.has(name) || !content) continue;
    contentByName.set(name, content);
  }
  for (const name of names) {
    const content = contentByName.get(name.toLowerCase());
    if (content) return content;
  }
  return undefined;
};

export const extractGitHubWebIdentity = (html: string): CopilotGitHubWebIdentity | undefined => {
  const id = extractMetaContent(html, ["octolytics-actor-id", "analytics-user-id", "user-id"]);
  const login = extractMetaContent(html, [
    "user-login",
    "octolytics-actor-login",
    "analytics-user-login",
  ]);
  if (!id && !login) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(login ? { login } : {}),
  };
};

const githubUserID = (identifier: string): string | undefined => {
  const prefix = "github:user:";
  if (!identifier.startsWith(prefix)) return undefined;
  const suffix = identifier.slice(prefix.length).trim();
  return suffix || undefined;
};

export const normalizedExpectedAccountIdentifier = (
  identifier: string | undefined,
): string | undefined => {
  const trimmed = identifier?.trim() ?? "";
  return trimmed ? trimmed.toLowerCase() : undefined;
};

export const webIdentityMatches = (
  identity: CopilotGitHubWebIdentity | undefined,
  expectedIdentifier: string | undefined,
): boolean => {
  const expected = normalizedExpectedAccountIdentifier(expectedIdentifier);
  if (!expected || !identity) return false;
  const expectedID = githubUserID(expected);
  if (expectedID !== undefined) return identity.id === expectedID;
  return identity.login?.toLowerCase() === expected;
};

const cookieHeaders = (cookieHeader: string, extra?: Readonly<Record<string, string>>) => ({
  Cookie: cookieHeader,
  "User-Agent": "CodexBar",
  ...extra,
});

const fetchBudgetPageMetadata = async (
  ctx: ProviderContext,
  cookieHeader: string,
): Promise<{ nonce?: string; identity?: CopilotGitHubWebIdentity }> => {
  const response = await get(ctx, budgetPageURL, {
    __codexbarSuppressManagedAuth: true,
    headers: cookieHeaders(cookieHeader, { Accept: "text/html,application/xhtml+xml" }),
    timeoutSeconds: 15,
  });
  if (response.status === 401 || response.status === 403) throw new Error("not-logged-in");
  if (response.status !== 200) throw new Error(`bad-status:${response.status}`);
  const nonce = extractFetchNonce(response.bodyText);
  const identity = extractGitHubWebIdentity(response.bodyText);
  return {
    ...(nonce === undefined ? {} : { nonce }),
    ...(identity === undefined ? {} : { identity }),
  };
};

const fetchBudgetPage = async (
  ctx: ProviderContext,
  cookieHeader: string,
  nonce: string | undefined,
  page: number,
) => {
  const url = new URL(budgetPageURL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", "10");
  url.searchParams.set("scope", "customer");
  const response = await get(ctx, url.href, {
    __codexbarSuppressManagedAuth: true,
    headers: cookieHeaders(cookieHeader, {
      Accept: "application/json",
      Referer: budgetPageURL,
      "X-Requested-With": "XMLHttpRequest",
      "GitHub-Verified-Fetch": "true",
      ...(nonce ? { "X-Fetch-Nonce": nonce } : {}),
    }),
    timeoutSeconds: 15,
  });
  if (response.status === 401 || response.status === 403) throw new Error("not-logged-in");
  if (response.status !== 200) throw new Error(`bad-status:${response.status}`);
  try {
    return parseBudgetResponse(JSON.parse(response.bodyText) as unknown);
  } catch {
    throw new Error("invalid-response");
  }
};

export const fetchCopilotBudgetWindows = async (
  ctx: ProviderContext,
  cookieHeader: string,
  expectedGitHubAccountIdentifier: string | undefined,
): Promise<readonly NamedWindow[]> => {
  const expected = normalizedExpectedAccountIdentifier(expectedGitHubAccountIdentifier);
  let nonce: string | undefined;
  if (expected) {
    const metadata = await fetchBudgetPageMetadata(ctx, cookieHeader);
    if (!webIdentityMatches(metadata.identity, expected)) {
      throw new Error("account-mismatch");
    }
    nonce = metadata.nonce;
  } else {
    try {
      nonce = (await fetchBudgetPageMetadata(ctx, cookieHeader)).nonce;
    } catch {
      nonce = undefined;
    }
  }

  const budgets: CopilotBudget[] = [];
  let page = 1;
  let shouldContinue = true;
  while (shouldContinue && page <= maxBudgetPages) {
    const response = await fetchBudgetPage(ctx, cookieHeader, nonce, page);
    budgets.push(...response.budgets);
    shouldContinue = response.hasNextPage === true;
    page += 1;
  }
  return extraRateWindowsFromBudgets(budgets, ctx);
};
