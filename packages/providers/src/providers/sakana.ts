import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";

const clean = (raw: string | undefined): string | undefined =>
  raw
    ?.trim()
    .replace(/^['"]|['"]$/gu, "")
    .trim() || undefined;
const capture = (pattern: RegExp, html: string): string | undefined =>
  pattern.exec(html)?.[1]?.trim();
const resetAt = (ctx: ProviderContext, value: string | undefined): string | undefined => {
  if (!value) return undefined;
  // The server-rendered console value is UTC (the Swift parser deliberately avoids local TZ).
  const normalized = value.replace(/\s+at\s+/iu, " ") + " UTC";
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? ctx.date.unixMillis(milliseconds) : undefined;
};
const window = (ctx: ProviderContext, label: "5-hour" | "Weekly", html: string) => {
  const anchor = new RegExp(
    `<p[^>]*>\\s*${label.replace("-", "-")}\\s*</p>([\\s\\S]*?)(?=<p[^>]*>\\s*(?:5-hour|Weekly)\\s*</p>|$)`,
    "i",
  );
  const body = capture(anchor, html);
  if (!body) return undefined;
  const raw = capture(/<p[^>]*>\s*([0-9]+(?:\.[0-9]+)?)% used\s*<\/p>/iu, body);
  const usedPercent = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
    throw ctx.fail.parseFailure(`Invalid Sakana ${label} usage percentage.`);
  const reset = resetAt(ctx, capture(/<p[^>]*>\s*Resets on\s+([^<]+?)\s*<\/p>/iu, body));
  return {
    usedPercent,
    windowMinutes: label === "5-hour" ? 300 : 10_080,
    ...(reset ? { resetsAt: reset } : {}),
  };
};
const plan = (html: string): string | undefined =>
  capture(/data-slot="card-title"[^>]*>[\s\S]*?<span>\s*([^<]+?)\s*<\/span>/iu, html);
const price = (html: string): string | undefined =>
  capture(
    /data-slot="card-title"[^>]*>[\s\S]*?<span>[^<]+<\/span>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/iu,
    html,
  );
const payg = (ctx: ProviderContext, html: string) => {
  const balance = capture(
    /<h2[^>]*>\s*Credit balance\s*<\/h2>[\s\S]{0,900}?<p[^>]*tabular-nums[^>]*>\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)<\/p>/iu,
    html,
  );
  if (!balance) return undefined;
  const credit = Number(balance.replace(/,/gu, ""));
  if (!Number.isFinite(credit)) return undefined;
  const usedText = capture(
    /<h2[^>]*>\s*Usage\s*<\/h2>[\s\S]{0,500}?Total[^$]*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/iu,
    html,
  );
  const range = capture(/aria-label="Usage date range"[^>]*>([\s\S]*?)<\/button>/iu, html)
    ?.replace(/<!--.*?-->/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    title: "Extra usage",
    rows: [
      { label: "Balance", value: ctx.format.usd(credit) },
      ...(usedText && Number.isFinite(Number(usedText.replace(/,/gu, "")))
        ? [
            {
              label: "Usage",
              value: ctx.format.usd(Number(usedText.replace(/,/gu, ""))),
              ...(range ? { secondaryValue: range } : {}),
            },
          ]
        : []),
    ],
  };
};

const definition: ProviderDefinition = {
  id: "sakana",
  name: "Sakana AI",
  endpoints: ["https://console.sakana.ai"],
  settings: [{ key: "SAKANA_COOKIE", title: "Cookie header", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["console.sakana.ai"],
  fetchUsage: async (ctx: ProviderContext) => {
    const cookie = clean(
      ctx.settings.getSecret("SAKANA_COOKIE") ?? ctx.settings.get("SAKANA_COOKIE"),
    );
    if (!cookie) throw ctx.fail.missingCredential("Missing Sakana cookie header (SAKANA_COOKIE).");
    const response = await ctx.http.get("https://console.sakana.ai/billing", {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
      },
    });
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    )
      throw ctx.fail.authenticationExpired("Sakana login is required.");
    if (response.status !== 200)
      throw ctx.fail.apiFailure(`Sakana billing fetch failed (HTTP ${response.status}).`);
    if (!response.bodyText.trim())
      throw ctx.fail.parseFailure("Sakana billing page response was empty.");
    const primary = window(ctx, "5-hour", response.bodyText);
    const secondary = window(ctx, "Weekly", response.bodyText);
    if (!primary && !secondary)
      throw ctx.fail.parseFailure("Sakana usage limit windows were not found.");
    // Preserve best-effort PAYG semantics: a changed/failed tab never invalidates core quota.
    let details: ReturnType<typeof payg>[] = [];
    try {
      const optional = await ctx.http.get("https://console.sakana.ai/billing?tab=payAsYouGo", {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: cookie,
        },
        timeoutSeconds: ctx.__codexbarOptionalRequestTimeoutSeconds ?? 5,
      });
      const section = optional.status === 200 ? payg(ctx, optional.bodyText) : undefined;
      if (section) details = [section];
    } catch {
      // Optional enrichment is intentionally ignored.
    }
    const loginMethod = [plan(response.bodyText), price(response.bodyText)]
      .filter(Boolean)
      .join(" ");
    return {
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(details.length ? { details } : {}),
      identity: loginMethod ? { loginMethod } : {},
    };
  },
};

const strategy: ProviderStrategy = {
  id: "sakana.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const sakana: FirstPartyProvider = { ...strategy, descriptor };
