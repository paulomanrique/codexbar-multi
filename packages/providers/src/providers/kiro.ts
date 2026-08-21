import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import {
  overageChargeLimit,
  parseKiroUsageLimits,
  type KiroUsageLimits,
} from "./kiro-usage-limits.ts";

const ansiControlSequence = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "gu");

type KiroCLIUsage = {
  readonly planName: string;
  readonly creditsUsed: number;
  readonly creditsTotal: number;
  readonly creditsPercent: number;
  readonly bonusUsed: number | undefined;
  readonly bonusTotal: number | undefined;
  readonly bonusExpiryDays: number | undefined;
  readonly overagesStatus: string | undefined;
  readonly overageCreditsUsed: number | undefined;
  readonly estimatedOverageCostUSD: number | undefined;
  readonly resetsAt: string | undefined;
};

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const creditNumber = (value: number, ctx: ProviderContext): string =>
  ctx.format.number(value, { maximumFractionDigits: 2 });

const currencyNumber = (value: number, currencyCode: string, ctx: ProviderContext): string =>
  currencyCode.toUpperCase() === "USD"
    ? ctx.format.usd(value)
    : `${currencyCode} ${creditNumber(value, ctx)}`;

const displayPlanName = (value: string): string =>
  /kiro/iu.test(value)
    ? value
        .trim()
        .replace(/\s+/gu, " ")
        .split(" ")
        .map((word) =>
          word.toLowerCase() === "kiro"
            ? "Kiro"
            : `${word[0]?.toUpperCase()}${word.slice(1).toLowerCase()}`,
        )
        .join(" ")
    : value.trim() || "Kiro";

const cliUsage = (raw: string, ctx: ProviderContext): KiroCLIUsage => {
  const output = raw.replace(ansiControlSequence, "").replace(/\r/gu, "").trim();
  const credits = /\(([0-9]+(?:\.[0-9]+)?)\s+of\s+([0-9]+(?:\.[0-9]+)?)\s+covered/iu.exec(output);
  const fallbackPercent = /([0-9]+(?:\.[0-9]+)?)%\s*(?:used|usage)/iu.exec(output)?.[1];
  const blockPercent = /█+\s*([0-9]+(?:\.[0-9]+)?)%/u.exec(output)?.[1];
  const creditsUsed = number(credits?.[1]) ?? 0;
  const creditsTotal = number(credits?.[2]) ?? 50;
  const parsedPercent = number(blockPercent ?? fallbackPercent);
  if (parsedPercent === undefined && credits === null)
    throw ctx.fail.parseFailure("Could not parse Kiro CLI usage output.");
  const bonus = /Bonus credits:\s*([0-9]+(?:\.[0-9]+)?)\/([0-9]+(?:\.[0-9]+)?)/iu.exec(output);
  const plan =
    /Estimated Usage[ \t]*\|[^\n|]*\|[ \t]*([A-Z][A-Z0-9 ]+)/u.exec(output)?.[1] ??
    /\|[ \t]*(KIRO[ \t]+\w+)/u.exec(output)?.[1] ??
    /Plan:[ \t]*([^\n]+)/u.exec(output)?.[1] ??
    "Kiro";
  const resetDate = /resets on (\d{4}-\d{2}-\d{2})/iu.exec(output)?.[1];
  const reset = resetDate === undefined ? undefined : ctx.date.iso(`${resetDate}T00:00:00Z`);
  return {
    planName: displayPlanName(plan),
    creditsUsed,
    creditsTotal,
    creditsPercent:
      parsedPercent === undefined
        ? creditsTotal > 0
          ? ctx.pct(creditsUsed, creditsTotal)
          : 0
        : parsedPercent,
    bonusUsed: number(bonus?.[1]),
    bonusTotal: number(bonus?.[2]),
    bonusExpiryDays: number(/expires in (\d+) days?/iu.exec(output)?.[1]),
    overagesStatus: /Overages:\s*([^\n]+)/iu.exec(output)?.[1]?.trim(),
    overageCreditsUsed: number(/Credits used:\s*([0-9]+(?:\.[0-9]+)?)/iu.exec(output)?.[1]),
    estimatedOverageCostUSD: number(
      /Est\.\s*cost:\s*\$?([0-9]+(?:\.[0-9]+)?)\s*USD/iu.exec(output)?.[1],
    ),
    resetsAt: reset,
  };
};

const isOverageEnabled = (status: string | undefined): boolean =>
  status?.trim().toLowerCase().startsWith("enabled") === true;

const enrich = (
  cli: KiroCLIUsage,
  limits: KiroUsageLimits | undefined,
): KiroCLIUsage & { readonly limits: KiroUsageLimits | undefined } => ({
  ...cli,
  creditsUsed:
    limits !== undefined && !limits.hasUnseparatedBonus ? limits.planUsed : cli.creditsUsed,
  creditsTotal:
    limits !== undefined && !limits.hasUnseparatedBonus ? limits.planLimit : cli.creditsTotal,
  creditsPercent:
    limits !== undefined && !limits.hasUnseparatedBonus && limits.planLimit > 0
      ? (limits.planUsed / limits.planLimit) * 100
      : cli.creditsPercent,
  overagesStatus:
    limits?.overageEnabled === false
      ? "Disabled"
      : limits?.overageEnabled === true
        ? (cli.overagesStatus ?? "Enabled")
        : cli.overagesStatus,
  overageCreditsUsed: limits?.overageUsed ?? cli.overageCreditsUsed,
  estimatedOverageCostUSD:
    limits?.overageCharges ??
    (limits !== undefined && limits.currencyCode.toUpperCase() !== "USD"
      ? undefined
      : cli.estimatedOverageCostUSD),
  resetsAt: limits?.resetsAt ?? cli.resetsAt,
  limits,
});

const snapshot = (usage: ReturnType<typeof enrich>, ctx: ProviderContext) => {
  const overageEnabled =
    usage.limits?.overageEnabled !== undefined
      ? usage.limits.overageEnabled && usage.limits.overageCap !== undefined
      : isOverageEnabled(usage.overagesStatus);
  const chargeLimit = usage.limits === undefined ? undefined : overageChargeLimit(usage.limits);
  const rows = [
    { label: "Plan", value: usage.planName },
    {
      label: "Credits left",
      value: creditNumber(Math.max(0, usage.creditsTotal - usage.creditsUsed), ctx),
    },
    { label: "Credits used", value: creditNumber(usage.creditsUsed, ctx) },
    { label: "Credits total", value: creditNumber(usage.creditsTotal, ctx) },
    ...(usage.bonusUsed !== undefined && usage.bonusTotal !== undefined
      ? [
          {
            label: "Bonus credits left",
            value: creditNumber(Math.max(0, usage.bonusTotal - usage.bonusUsed), ctx),
            secondaryValue: `of ${creditNumber(usage.bonusTotal, ctx)}${usage.bonusExpiryDays === undefined ? "" : ` · expires in ${usage.bonusExpiryDays}d`}`,
          },
        ]
      : []),
    ...(usage.overagesStatus === undefined
      ? []
      : [{ label: "Overages", value: usage.overagesStatus }]),
    ...(overageEnabled && usage.overageCreditsUsed !== undefined
      ? [
          {
            label: "Overage usage",
            value: `${creditNumber(usage.overageCreditsUsed, ctx)} credits`,
            ...(usage.limits?.overageCap === undefined
              ? {}
              : { secondaryValue: `of ${creditNumber(usage.limits.overageCap, ctx)}` }),
          },
        ]
      : []),
    ...(overageEnabled &&
    usage.overageCreditsUsed !== undefined &&
    usage.limits?.overageCap !== undefined
      ? [
          {
            label: "Overage credits left",
            value: creditNumber(
              Math.max(0, usage.limits.overageCap - usage.overageCreditsUsed),
              ctx,
            ),
          },
        ]
      : []),
    ...(overageEnabled && usage.estimatedOverageCostUSD !== undefined
      ? [
          {
            label: "Overage cost",
            value: currencyNumber(
              usage.estimatedOverageCostUSD,
              usage.limits?.currencyCode ?? "USD",
              ctx,
            ),
            ...(chargeLimit === undefined
              ? {}
              : {
                  secondaryValue: `of ${currencyNumber(
                    chargeLimit,
                    usage.limits?.currencyCode ?? "USD",
                    ctx,
                  )}`,
                }),
          },
        ]
      : []),
  ];
  return {
    primary: {
      usedPercent: usage.creditsPercent,
      ...(usage.resetsAt === undefined ? {} : { resetsAt: usage.resetsAt }),
    },
    ...(usage.bonusUsed !== undefined && usage.bonusTotal !== undefined && usage.bonusTotal > 0
      ? { secondary: { usedPercent: ctx.pct(usage.bonusUsed, usage.bonusTotal) } }
      : {}),
    ...(usage.limits?.overageCap !== undefined && usage.limits.overageCap > 0
      ? {
          extraRateWindows: [
            {
              id: "kiro-overage",
              title: "Overage",
              window: {
                usedPercent: Math.min(
                  100,
                  ctx.pct(usage.limits.overageUsed, usage.limits.overageCap),
                ),
                resetsAt: usage.limits.resetsAt,
              },
            },
          ],
        }
      : {}),
    ...(usage.limits?.overageCharges !== undefined && chargeLimit !== undefined
      ? {
          providerCost: {
            used: usage.limits.overageCharges,
            limit: chargeLimit,
            currencyCode: usage.limits.currencyCode,
            period: "Overage",
            resetsAt: usage.limits.resetsAt,
          },
        }
      : {}),
    details: [{ title: "Usage", rows }],
  };
};

/** Parses the non-interactive `kiro-cli ... /usage` display produced by the Swift probe. */
export const parseKiroUsage = (raw: string, ctx: ProviderContext) => {
  return snapshot(enrich(cliUsage(raw, ctx), undefined), ctx);
};

const definition: ProviderDefinition = {
  id: "kiro",
  name: "Kiro",
  endpoints: ["https://app.kiro.dev"],
  settings: [],
  fetchUsage: async (ctx) => {
    if (ctx.local === undefined)
      throw ctx.fail.providerUnavailable("Kiro CLI support is not configured by this host.");
    const result = await ctx.local.run("kiro-cli", {
      args: ["chat", "--no-interactive", "/usage"],
      timeoutMs: 20_000,
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    if (/not\s+logged\s+in|login\s+required|kiro-cli\s+login|oauth\s+error/iu.test(output))
      throw ctx.fail.authenticationExpired(
        "Kiro CLI is not logged in. Run 'kiro-cli login' first.",
      );
    if (result.exitCode !== 0)
      throw ctx.fail.providerUnavailable(
        `Kiro CLI exited with status ${result.exitCode ?? "unknown"}.`,
      );
    const cli = cliUsage(output, ctx);
    let limits: KiroUsageLimits | undefined;
    try {
      const response = await ctx.local.fetchKiroUsageLimits?.();
      if (response !== undefined && response.status >= 200 && response.status < 300)
        limits = parseKiroUsageLimits(JSON.parse(response.bodyText) as unknown, ctx);
    } catch (error) {
      // The CLI report is the authoritative fallback. Abort/cancellation stays terminal.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof Error && /abort|cancel/iu.test(error.name)) throw error;
    }
    return snapshot(enrich(cli, limits), ctx);
  },
};
const strategy: ProviderStrategy = {
  id: "kiro.cli",
  kind: "cli",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const kiro: FirstPartyProvider = { ...strategy, descriptor };
