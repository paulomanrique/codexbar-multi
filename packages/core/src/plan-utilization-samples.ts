import type { NamedRateWindow, ProviderId, RateWindow, UsageSnapshot } from "@codexbar/contracts";
import {
  PlanUtilizationHistoryEntry,
  PlanUtilizationSeriesName,
  type PlanUtilizationSeriesHistory,
} from "./plan-utilization-history.ts";
import type { PlanUtilizationSeriesSample } from "./plan-utilization-recorder.ts";

export const PLAN_UTILIZATION_SESSION_WINDOW_MINUTES = 5 * 60;
export const PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
export const PLAN_UTILIZATION_MONTHLY_WINDOW_MINUTES = 30 * 24 * 60;

export interface SessionEquivalentWindowComponent {
  readonly window: RateWindow;
  readonly namedId?: string;
  readonly historyIdentity: string;
}

export type SessionEquivalentWindowPairResolution =
  | {
      readonly kind: "resolved";
      readonly session: RateWindow;
      readonly weekly: RateWindow;
      readonly weeklyWindowId?: string;
      readonly historyIdentity: string;
    }
  | { readonly kind: "incomplete" }
  | { readonly kind: "ambiguous" };

export interface ReconciledSessionEquivalentHistory {
  readonly historyIdentity?: string;
  readonly histories: readonly PlanUtilizationSeriesHistory[];
  readonly samples: readonly PlanUtilizationSeriesSample[];
}

/** Swift-compatible generic 5h/weekly pair resolution and stable identity. */
export function resolveGenericSessionEquivalentWindowPair(
  snapshot: UsageSnapshot,
): SessionEquivalentWindowPairResolution {
  const session = resolveSessionEquivalentWindow(snapshot, PLAN_UTILIZATION_SESSION_WINDOW_MINUTES);
  const weekly = resolveSessionEquivalentWindow(snapshot, PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES);
  if (session.kind === "ambiguous" || weekly.kind === "ambiguous") return { kind: "ambiguous" };
  if (session.kind !== "resolved" || weekly.kind !== "resolved") return { kind: "incomplete" };
  if (!hasCanonicalSessionEquivalentRelationship(session.identity, weekly.identity))
    return { kind: "ambiguous" };
  return {
    kind: "resolved",
    session: session.window,
    weekly: weekly.window,
    ...(weekly.namedId === undefined ? {} : { weeklyWindowId: weekly.namedId }),
    historyIdentity: sessionEquivalentPairIdentity(session.identity, weekly.identity),
  };
}

export function genericSessionEquivalentWindowComponents(snapshot: UsageSnapshot): {
  readonly session?: SessionEquivalentWindowComponent;
  readonly weekly?: SessionEquivalentWindowComponent;
} {
  const component = (
    resolution: SessionEquivalentWindowResolution,
  ): SessionEquivalentWindowComponent | undefined =>
    resolution.kind === "resolved"
      ? {
          window: resolution.window,
          ...(resolution.namedId === undefined ? {} : { namedId: resolution.namedId }),
          historyIdentity: resolution.identity,
        }
      : undefined;
  const session = component(
    resolveSessionEquivalentWindow(snapshot, PLAN_UTILIZATION_SESSION_WINDOW_MINUTES),
  );
  const weekly = component(
    resolveSessionEquivalentWindow(snapshot, PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES),
  );
  return {
    ...(session === undefined ? {} : { session }),
    ...(weekly === undefined ? {} : { weekly }),
  };
}

/** Parses Swift's length-prefixed UTF-8 pair identity without delimiter ambiguity. */
export function parseSessionEquivalentPairIdentity(
  identity: string,
): { readonly session: string; readonly weekly: string } | undefined {
  const bytes = new TextEncoder().encode(identity);
  let offset = 0;
  const parseComponent = (): string | undefined => {
    const lengthStart = offset;
    while (offset < bytes.length && bytes[offset]! >= 48 && bytes[offset]! <= 57) offset += 1;
    if (offset === lengthStart || offset >= bytes.length || bytes[offset] !== 35) return undefined;
    const lengthText = new TextDecoder().decode(bytes.slice(lengthStart, offset));
    const length = Number(lengthText);
    offset += 1;
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset)
      return undefined;
    const end = offset + length;
    try {
      const component = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset, end));
      offset = end;
      return component;
    } catch {
      return undefined;
    }
  };
  const session = parseComponent();
  const weekly = parseComponent();
  return session === undefined || weekly === undefined || offset !== bytes.length
    ? undefined
    : { session, weekly };
}

/**
 * Ports the generic-provider identity admission rules. A changed or ambiguous
 * pair can remove only the affected semantic lanes; unrelated series survive.
 */
export function reconcileGenericSessionEquivalentHistory(input: {
  readonly previousIdentity?: string;
  readonly snapshot: UsageSnapshot;
  readonly histories: readonly PlanUtilizationSeriesHistory[];
  readonly samples: readonly PlanUtilizationSeriesSample[];
}): ReconciledSessionEquivalentHistory {
  const resolution = resolveGenericSessionEquivalentWindowPair(input.snapshot);
  const components = genericSessionEquivalentWindowComponents(input.snapshot);
  let historyIdentity = input.previousIdentity;
  let histories = [...input.histories];
  let samples = [...input.samples];

  if (resolution.kind === "resolved") {
    if (historyIdentity !== resolution.historyIdentity) {
      const previous =
        historyIdentity === undefined
          ? undefined
          : parseSessionEquivalentPairIdentity(historyIdentity);
      const current = parseSessionEquivalentPairIdentity(resolution.historyIdentity)!;
      if (previous !== undefined) {
        histories = histories.filter((history) => {
          const name = history.name.rawValue;
          return !(
            (name === "session" && previous.session !== current.session) ||
            (name === "weekly" && previous.weekly !== current.weekly)
          );
        });
      } else if (historyIdentity !== undefined) {
        histories = histories.filter((history) => !isSessionOrWeekly(history.name.rawValue));
      } else {
        histories = histories.filter((history) => history.name.rawValue !== "session");
      }
      historyIdentity = resolution.historyIdentity;
    }
  } else if (resolution.kind === "incomplete") {
    const currentWeeklyIdentity = components.weekly?.historyIdentity;
    if (historyIdentity === undefined && currentWeeklyIdentity !== undefined) {
      historyIdentity = sessionEquivalentPairIdentity("__unresolved__", currentWeeklyIdentity);
    }
    const previous =
      historyIdentity === undefined
        ? undefined
        : parseSessionEquivalentPairIdentity(historyIdentity);
    if (previous?.session === "__unresolved__" && previous.weekly === currentWeeklyIdentity) {
      samples = samples.filter((sample) => seriesName(sample) !== "session");
    } else if (historyIdentity !== undefined) {
      samples = samples.filter((sample) => !isSessionOrWeekly(seriesName(sample)));
    }
  } else {
    const currentWeeklyIdentity = components.weekly?.historyIdentity;
    if (historyIdentity === undefined && currentWeeklyIdentity !== undefined) {
      historyIdentity = sessionEquivalentPairIdentity("__unresolved__", currentWeeklyIdentity);
    }
    const previousWeeklyIdentity =
      historyIdentity === undefined
        ? undefined
        : parseSessionEquivalentPairIdentity(historyIdentity)?.weekly;
    samples = samples.filter((sample) => {
      const name = seriesName(sample);
      if (name === "session") return false;
      if (name === "weekly" && historyIdentity !== undefined)
        return (
          previousWeeklyIdentity !== undefined && previousWeeklyIdentity === currentWeeklyIdentity
        );
      return true;
    });
  }

  return {
    ...(historyIdentity === undefined ? {} : { historyIdentity }),
    histories,
    samples,
  };
}

/**
 * Projects provider payload lanes into the persisted semantic series. Account
 * ownership and generic-pair reconciliation remain separate admission gates.
 */
export function extractPlanUtilizationSeriesSamples(input: {
  readonly providerId: ProviderId;
  readonly snapshot: UsageSnapshot;
  readonly capturedAt: Date;
  readonly forSessionEquivalents?: boolean;
}): readonly PlanUtilizationSeriesSample[] {
  const samples = new Map<string, PlanUtilizationSeriesSample>();
  const append = (window: RateWindow | undefined, name: PlanUtilizationSeriesName): void => {
    if (
      window === undefined ||
      window.isSyntheticPlaceholder === true ||
      window.windowMinutes === undefined ||
      window.windowMinutes <= 0
    )
      return;
    const windowMinutes = name.canonicalWindowMinutes(window.windowMinutes);
    const resetsAt = parseDate(window.resetsAt);
    const sample: PlanUtilizationSeriesSample = {
      name,
      windowMinutes,
      entry: new PlanUtilizationHistoryEntry({
        capturedAt: input.capturedAt,
        usedPercent: clamp(window.usedPercent, 0, 100),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      }),
    };
    samples.set(seriesKey(name, windowMinutes), sample);
  };

  const appendGeneric = (): void => {
    const components = genericSessionEquivalentWindowComponents(input.snapshot);
    const pair = resolveGenericSessionEquivalentWindowPair(input.snapshot);
    if (pair.kind === "resolved") {
      append(pair.session, PlanUtilizationSeriesName.session);
      append(pair.weekly, PlanUtilizationSeriesName.weekly);
      return;
    }
    append(components.session?.window, PlanUtilizationSeriesName.session);
    append(components.weekly?.window, PlanUtilizationSeriesName.weekly);
  };

  switch (input.providerId) {
    case "codex":
      appendCodexWindow(input.snapshot.primary, "primary", append);
      appendCodexWindow(input.snapshot.secondary, "secondary", append);
      break;
    case "claude":
      append(input.snapshot.primary, PlanUtilizationSeriesName.session);
      append(input.snapshot.secondary, PlanUtilizationSeriesName.weekly);
      append(input.snapshot.tertiary, PlanUtilizationSeriesName.opus);
      break;
    case "opencodego":
      append(input.snapshot.primary, PlanUtilizationSeriesName.session);
      append(input.snapshot.secondary, PlanUtilizationSeriesName.weekly);
      append(input.snapshot.tertiary, PlanUtilizationSeriesName.monthly);
      break;
    case "mimo":
    case "stepfun":
      if (input.snapshot.primary?.windowMinutes === PLAN_UTILIZATION_MONTHLY_WINDOW_MINUTES) {
        append(input.snapshot.primary, PlanUtilizationSeriesName.monthly);
      } else {
        appendGeneric();
      }
      break;
    case "antigravity":
      if (input.forSessionEquivalents === true) {
        const pair = antigravitySessionEquivalentWindows(input.snapshot);
        append(pair?.session, PlanUtilizationSeriesName.session);
        append(pair?.weekly, PlanUtilizationSeriesName.weekly);
      } else {
        append(antigravityWeeklyWindow(input.snapshot), PlanUtilizationSeriesName.weekly);
      }
      break;
    default:
      appendGeneric();
  }

  return [...samples.values()].sort(
    (left, right) =>
      left.windowMinutes - right.windowMinutes ||
      compareUnicodeScalars(seriesName(left), seriesName(right)),
  );
}

type SessionEquivalentWindowResolution =
  | {
      readonly kind: "resolved";
      readonly window: RateWindow;
      readonly namedId?: string;
      readonly identity: string;
    }
  | { readonly kind: "incomplete" }
  | { readonly kind: "ambiguous" };

const resolveSessionEquivalentWindow = (
  snapshot: UsageSnapshot,
  windowMinutes: number,
): SessionEquivalentWindowResolution => {
  const standard = [
    snapshot.primary === undefined
      ? undefined
      : { window: snapshot.primary, identity: "standard:primary" },
    snapshot.secondary === undefined
      ? undefined
      : { window: snapshot.secondary, identity: "standard:secondary" },
    snapshot.tertiary === undefined
      ? undefined
      : { window: snapshot.tertiary, identity: "standard:tertiary" },
  ].filter(
    (candidate): candidate is { readonly window: RateWindow; readonly identity: string } =>
      candidate !== undefined && candidate.window.windowMinutes === windowMinutes,
  );
  if (standard.length === 1)
    return { kind: "resolved", window: standard[0]!.window, identity: standard[0]!.identity };
  if (standard.length > 1) return { kind: "ambiguous" };

  const named = (snapshot.extraRateWindows ?? []).filter(
    (candidate) => candidate.window.windowMinutes === windowMinutes,
  );
  if (named.length > 1) return { kind: "ambiguous" };
  const candidate = named[0];
  if (candidate === undefined || !usageKnown(candidate)) return { kind: "incomplete" };
  return {
    kind: "resolved",
    window: candidate.window,
    namedId: candidate.id,
    identity: `named:${candidate.id}`,
  };
};

const appendCodexWindow = (
  window: RateWindow | undefined,
  slot: "primary" | "secondary",
  append: (window: RateWindow | undefined, name: PlanUtilizationSeriesName) => void,
): void => {
  if (window === undefined) return;
  const name =
    window.windowMinutes === PLAN_UTILIZATION_SESSION_WINDOW_MINUTES
      ? PlanUtilizationSeriesName.session
      : window.windowMinutes === PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES
        ? PlanUtilizationSeriesName.weekly
        : window.windowMinutes === PLAN_UTILIZATION_MONTHLY_WINDOW_MINUTES
          ? PlanUtilizationSeriesName.monthly
          : slot === "primary"
            ? PlanUtilizationSeriesName.session
            : PlanUtilizationSeriesName.weekly;
  append(window, name);
};

const antigravityWeeklyWindow = (snapshot: UsageSnapshot): RateWindow | undefined => {
  const named = (snapshot.extraRateWindows ?? [])
    .filter(
      (candidate) =>
        usageKnown(candidate) &&
        candidate.id.startsWith("antigravity-quota-summary-") &&
        candidate.window.windowMinutes === PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES,
    )
    .map((candidate) => candidate.window);
  const namedMaximum = maximumUsedWindow(named);
  if (namedMaximum !== undefined) return namedMaximum;
  const legacy = [snapshot.primary, snapshot.secondary, snapshot.tertiary]
    .filter((window): window is RateWindow => window !== undefined)
    .filter((window) => window.windowMinutes === PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES)
    .concat(
      (snapshot.extraRateWindows ?? [])
        .filter(
          (candidate) =>
            usageKnown(candidate) &&
            candidate.window.windowMinutes === PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES,
        )
        .map((candidate) => candidate.window),
    );
  return maximumUsedWindow(legacy);
};

const antigravitySessionEquivalentWindows = (
  snapshot: UsageSnapshot,
): { readonly session: RateWindow; readonly weekly: RateWindow } | undefined => {
  const named = (snapshot.extraRateWindows ?? []).filter(
    (candidate) => usageKnown(candidate) && candidate.id.startsWith("antigravity-quota-summary-"),
  );
  const gemini = named.filter((candidate) => antigravityQuotaFamilyKey(candidate.id) === "gemini");
  const sessions = gemini.filter(
    (candidate) => candidate.window.windowMinutes === PLAN_UTILIZATION_SESSION_WINDOW_MINUTES,
  );
  const weeklies = gemini.filter(
    (candidate) => candidate.window.windowMinutes === PLAN_UTILIZATION_WEEKLY_WINDOW_MINUTES,
  );
  if (sessions.length !== 1 || weeklies.length !== 1) return undefined;
  return { session: sessions[0]!.window, weekly: weeklies[0]!.window };
};

const hasCanonicalSessionEquivalentRelationship = (
  sessionIdentity: string,
  weeklyIdentity: string,
): boolean => {
  if (sessionIdentity.startsWith("standard:") && weeklyIdentity.startsWith("standard:"))
    return true;
  if (!sessionIdentity.startsWith("named:") || !weeklyIdentity.startsWith("named:")) return false;
  const sessionFamily = sessionEquivalentFamily(sessionIdentity.slice("named:".length), [
    "-session",
    "_session",
    " session",
    "-5h",
    "_5h",
    " 5h",
  ]);
  const weeklyFamily = sessionEquivalentFamily(weeklyIdentity.slice("named:".length), [
    "-weekly",
    "_weekly",
    " weekly",
  ]);
  return sessionFamily !== undefined && sessionFamily === weeklyFamily;
};

const sessionEquivalentFamily = (id: string, suffixes: readonly string[]): string | undefined => {
  const normalized = id.toLowerCase();
  const suffix = suffixes.find((candidate) => normalized.endsWith(candidate));
  if (suffix === undefined) return undefined;
  const family = normalized.slice(0, -suffix.length);
  return family.length === 0 ? undefined : family;
};

const sessionEquivalentPairIdentity = (session: string, weekly: string): string =>
  `${new TextEncoder().encode(session).byteLength}#${session}${new TextEncoder().encode(weekly).byteLength}#${weekly}`;

const antigravityQuotaFamilyKey = (id: string): string => {
  let key = id.slice("antigravity-quota-summary-".length).toLowerCase();
  const suffixes = [
    "-5h limit",
    "_5h_limit",
    "-weekly",
    "_weekly",
    " weekly",
    "-session",
    "_session",
    " session",
    "-5h",
    "_5h",
    " 5h",
  ];
  const suffix = suffixes.find((candidate) => key.endsWith(candidate));
  if (suffix !== undefined) key = key.slice(0, -suffix.length);
  else if (["weekly", "session", "5h"].includes(key)) key = "";
  return key;
};

const usageKnown = (window: NamedRateWindow): boolean => window.usageKnown !== false;

const maximumUsedWindow = (windows: readonly RateWindow[]): RateWindow | undefined =>
  windows.reduce<RateWindow | undefined>(
    (maximum, window) =>
      maximum === undefined || window.usedPercent > maximum.usedPercent ? window : maximum,
    undefined,
  );

const parseDate = (value: string | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : undefined;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

const seriesName = (sample: PlanUtilizationSeriesSample): string =>
  sample.name instanceof PlanUtilizationSeriesName ? sample.name.rawValue : sample.name;

const seriesKey = (name: PlanUtilizationSeriesName, windowMinutes: number): string =>
  JSON.stringify([name.rawValue, windowMinutes]);

const isSessionOrWeekly = (name: string): boolean => name === "session" || name === "weekly";

const compareUnicodeScalars = (left: string, right: string): number => {
  const leftScalars = Array.from(left, (scalar) => scalar.codePointAt(0)!);
  const rightScalars = Array.from(right, (scalar) => scalar.codePointAt(0)!);
  const count = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < count; index += 1) {
    const difference = leftScalars[index]! - rightScalars[index]!;
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
};
