import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";

const ansiControlSequence = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const monthlyWindowMinutes = 30 * 24 * 60;
const amount = "([0-9][0-9,]*(?:\\.[0-9]+)?)";
const identityPattern = "^\\s*Signed in as\\s+([^\\s(]+)(?:\\s+\\(([^\\r\\n)]+)\\))?\\s*$";
const freePattern =
  `^\\s*Amp Free:\\s*\\$?${amount}\\s*/\\s*\\$?${amount}\\s+remaining` +
  `(?:\\s*\\(replenishes\\s*\\+\\$?${amount}\\s*/\\s*hour\\))?`;
const freePercentPattern = `^\\s*Amp Free:\\s*${amount}\\s*%\\s+remaining(?:\\s+today)?(?:\\s*(\\(resets\\s+daily\\)))?`;
const subscriptionSuffix =
  `\\s*${amount}\\s*%\\s+other\\s+usage\\s+and\\s+${amount}\\s*%\\s+orb\\s+usage\\s+remaining` +
  `\\s*-\\s*resets\\s+upon\\s+renewal\\s+in\\s+([0-9][0-9,]*)\\s+(days?|months?)` +
  `(?:\\s+-\\s+https?://\\S+)?\\s*$`;
const subscriptionPatterns = [
  `^\\s*Subscription\\s+(.+?):${subscriptionSuffix}`,
  `^\\s*Amp\\s+(.+?)\\s+Subscription:${subscriptionSuffix}`,
];
const creditsPattern = `^\\s*Individual credits:\\s*\\$?${amount}\\s+remaining`;
const workspacePattern = `^\\s*Workspace\\s+(.+?):\\s*\\$?${amount}\\s+remaining`;

type WorkspaceBalance = { readonly name: string; readonly remaining: number };
type SubscriptionUsage = {
  readonly plan: string;
  readonly otherUsedPercent: number;
  readonly orbUsedPercent: number;
  readonly resetsAt: Date;
  readonly resetDescription: string;
};
type FreeTierUsage = {
  readonly quota: number;
  readonly used: number;
  readonly hourlyReplenishment: number;
  readonly windowHours: number | undefined;
  readonly resetDescription: string | undefined;
};
type RateWindow = {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAt?: string;
  readonly resetDescription?: string;
};

const firstGroups = (text: string, pattern: string): string[] | undefined => {
  const match = new RegExp(pattern, "im").exec(text);
  if (match === null) return undefined;
  return match.slice(1).map((group) => (group ?? "").trim());
};

const allGroups = (text: string, pattern: string): string[][] =>
  [...text.matchAll(new RegExp(pattern, "gim"))].map((match) =>
    match.slice(1).map((group) => (group ?? "").trim()),
  );

const numberFrom = (text: string | undefined): number | undefined => {
  if (text === undefined || text === "") return undefined;
  const value = Number(text.replaceAll(",", ""));
  return Number.isFinite(value) ? value : undefined;
};

const nonEmpty = (text: string | undefined): string | undefined => {
  if (text === undefined || text === "") return undefined;
  return text;
};

const looksSignedOut = (text: string): boolean => {
  const lower = text.toLowerCase();
  return (
    lower.includes("sign in") ||
    lower.includes("log in") ||
    lower.includes("login") ||
    lower.includes("/login") ||
    lower.includes("ampcode.com/login")
  );
};

const addGregorianMonths = (now: Date, months: number): Date => {
  const targetMonth = now.getUTCMonth() + months;
  const targetYear = now.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
};

const subscriptionResetDate = (value: number, unit: string, now: Date): Date =>
  unit.toLowerCase().startsWith("month")
    ? addGregorianMonths(now, value)
    : new Date(now.getTime() + value * 24 * 60 * 60 * 1000);

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const windowFromHours = (hours: number | undefined): number | undefined => {
  if (hours === undefined || hours <= 0) return undefined;
  return Math.round(hours * 60);
};

const freeWindow = (usage: FreeTierUsage, ctx: ProviderContext, now: Date): RateWindow => {
  const quota = Math.max(0, usage.quota);
  const used = Math.max(0, usage.used);
  const percent = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const windowMinutes = windowFromHours(usage.windowHours);
  const resetsAt =
    usage.resetDescription === "resets daily"
      ? ctx.date.nextDailyReset("America/New_York", 20)
      : quota > 0 && usage.hourlyReplenishment > 0
        ? new Date(
            now.getTime() + Math.max(0, used / usage.hourlyReplenishment) * 3600 * 1000,
          ).toISOString()
        : undefined;
  return {
    usedPercent: percent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(usage.resetDescription === undefined ? {} : { resetDescription: usage.resetDescription }),
  };
};

const parseFreeUsage = (text: string): FreeTierUsage | undefined => {
  const free = firstGroups(text, freePattern);
  const remaining = numberFrom(free?.[0]);
  const quota = numberFrom(free?.[1]);
  if (remaining === undefined || quota === undefined) return undefined;
  const hourlyReplenishment = numberFrom(free?.[2]) ?? 0;
  return {
    quota,
    used: Math.max(0, quota - remaining),
    hourlyReplenishment,
    windowHours:
      hourlyReplenishment > 0 ? Math.max(1, Math.round(quota / hourlyReplenishment)) : undefined,
    resetDescription: undefined,
  };
};

const parseFreePercentUsage = (text: string): FreeTierUsage | undefined => {
  const free = firstGroups(text, freePercentPattern);
  const remaining = numberFrom(free?.[0]);
  if (remaining === undefined) return undefined;
  const clampedRemaining = clampPercent(remaining);
  return {
    quota: 100,
    used: 100 - clampedRemaining,
    hourlyReplenishment: 0,
    windowHours: 24,
    resetDescription: nonEmpty(free?.[1]) === undefined ? undefined : "resets daily",
  };
};

const parseSubscription = (text: string, now: Date): SubscriptionUsage | undefined => {
  const subscription = subscriptionPatterns
    .map((pattern) => firstGroups(text, pattern))
    .find((match) => match !== undefined && match.length === 5);
  if (subscription === undefined) return undefined;
  const plan = nonEmpty(subscription[0]);
  const otherRemaining = numberFrom(subscription[1]);
  const orbRemaining = numberFrom(subscription[2]);
  const renewalValue = Number.parseInt((subscription[3] ?? "").replaceAll(",", ""), 10);
  const unit = subscription[4];
  if (
    plan === undefined ||
    otherRemaining === undefined ||
    orbRemaining === undefined ||
    !Number.isInteger(renewalValue) ||
    unit === undefined
  ) {
    return undefined;
  }
  const singularUnit = unit.toLowerCase().startsWith("month") ? "month" : "day";
  return {
    plan,
    otherUsedPercent: 100 - clampPercent(otherRemaining),
    orbUsedPercent: 100 - clampPercent(orbRemaining),
    resetsAt: subscriptionResetDate(renewalValue, unit, now),
    resetDescription: `renews in ${renewalValue} ${singularUnit}${renewalValue === 1 ? "" : "s"}`,
  };
};

/** Pure port of Amp CLI display parsing. Process discovery/execution is injected by Platform.ProcessRunner. */
export const parseAmpUsage = (displayText: string, ctx: ProviderContext) => {
  const text = displayText.replace(ansiControlSequence, "");
  const identity = firstGroups(text, identityPattern);
  if (identity === undefined && looksSignedOut(text)) {
    throw ctx.fail.authenticationExpired("Not logged in to Amp. Please log in via ampcode.com.");
  }
  const individualCredits = numberFrom(firstGroups(text, creditsPattern)?.[0]);
  const workspaceBalances: WorkspaceBalance[] = allGroups(text, workspacePattern).flatMap(
    (captures) => {
      if (captures.length !== 2) return [];
      const name = nonEmpty(captures[0]);
      const remaining = numberFrom(captures[1]);
      if (name === undefined || remaining === undefined) return [];
      return [{ name, remaining }];
    },
  );
  const resolvedFreeUsage = parseFreeUsage(text) ?? parseFreePercentUsage(text);
  const now = ctx.date.now();
  const subscription = parseSubscription(text, now);
  if (
    resolvedFreeUsage === undefined &&
    subscription === undefined &&
    individualCredits === undefined &&
    workspaceBalances.length === 0
  ) {
    throw ctx.fail.parseFailure("Missing Amp usage data.");
  }

  const resolvedFreeWindow =
    resolvedFreeUsage === undefined ? undefined : freeWindow(resolvedFreeUsage, ctx, now);
  const subscriptionPrimary =
    subscription === undefined
      ? undefined
      : {
          usedPercent: subscription.otherUsedPercent,
          windowMinutes: monthlyWindowMinutes,
          resetsAt: subscription.resetsAt.toISOString(),
          resetDescription: subscription.resetDescription,
        };
  const subscriptionSecondary =
    subscription === undefined
      ? undefined
      : {
          usedPercent: subscription.orbUsedPercent,
          windowMinutes: monthlyWindowMinutes,
          resetsAt: subscription.resetsAt.toISOString(),
          resetDescription: subscription.resetDescription,
        };
  const primary = subscriptionPrimary ?? resolvedFreeWindow;
  const extraRateWindows =
    subscription !== undefined && resolvedFreeWindow !== undefined
      ? [{ id: "amp-free", title: "Amp Free", window: resolvedFreeWindow }]
      : undefined;
  const detailRows = [
    ...(individualCredits === undefined
      ? []
      : [{ label: "Individual credits", value: ctx.format.usd(individualCredits) }]),
    ...workspaceBalances.map((balance) => ({
      label: `Workspace ${balance.name}`,
      value: ctx.format.usd(balance.remaining),
    })),
  ];
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(subscriptionSecondary === undefined ? {} : { secondary: subscriptionSecondary }),
    ...(extraRateWindows === undefined ? {} : { extraRateWindows }),
    details: detailRows.length === 0 ? [] : [{ title: "Credits", rows: detailRows }],
    identity: {
      ...(nonEmpty(identity?.[0]) === undefined ? {} : { accountEmail: nonEmpty(identity?.[0]) }),
      ...(nonEmpty(identity?.[1]) === undefined
        ? {}
        : { accountOrganization: nonEmpty(identity?.[1]) }),
      loginMethod: subscription?.plan ?? (primary === undefined ? "Amp" : "Amp Free"),
    },
  };
};

const definition: ProviderDefinition = {
  id: "amp",
  name: "Amp",
  endpoints: ["https://ampcode.com"],
  settings: [],
  fetchUsage: async (ctx) => {
    if (ctx.local === undefined)
      throw ctx.fail.providerUnavailable("Amp CLI support is not configured by this host.");
    const result = await ctx.local.run("amp", { args: ["usage"], timeoutMs: 15_000 });
    const output = result.stdout.trim() === "" ? result.stderr : result.stdout;
    if (result.exitCode !== 0 || result.signal !== undefined) {
      if (firstGroups(output, identityPattern) === undefined && looksSignedOut(output))
        throw ctx.fail.authenticationExpired(
          "Not logged in to Amp. Please log in via ampcode.com.",
        );
      throw ctx.fail.providerUnavailable(
        result.signal === undefined
          ? `Amp CLI exited with status ${result.exitCode}.`
          : `Amp CLI exited after signal ${result.signal}.`,
      );
    }
    if (output.trim() === "") throw ctx.fail.parseFailure("The Amp CLI returned no usage data.");
    return parseAmpUsage(output, ctx);
  },
};
const strategy: ProviderStrategy = {
  id: "amp.cli",
  kind: "cli",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const amp: FirstPartyProvider = { ...strategy, descriptor };
