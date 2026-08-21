/**
 * Host-owned publisher for Grok CLI session tokens.
 *
 * It reads the already-bounded session scanner and writes a replaceable local
 * token ledger. Neither paths nor signal contents leave this platform module.
 */
import { Effect } from "effect";
import {
  mapGrokLocalSessionTokenActivity,
  unavailableGrokLocalSessionTokenActivity,
  type CostUsageRepositoryService,
} from "@codexbar/core";
import {
  grokLocalSessionDayKey,
  parseGrokLocalSessionSignal,
  summarizeGrokLocalSessions,
} from "@codexbar/providers";

import {
  NodeGrokLocalSessionScanCancelledError,
  scanNodeGrokLocalSessions,
  type NodeGrokLocalSessionScanOptions,
} from "./node-grok-local-session.ts";

export class NodeGrokLocalTokenScanCancelledError extends Error {
  constructor() {
    super("Grok local token refresh was cancelled");
    this.name = "AbortError";
  }
}

export interface NodeGrokLocalTokenRefreshResult {
  readonly availability: "available" | "unavailable";
  readonly coverage: "exact" | "estimated";
  readonly scannedSessions: number;
  readonly publishedDays: number;
}

export interface NodeGrokLocalTokenScanner {
  readonly refresh: (signal?: AbortSignal) => Promise<NodeGrokLocalTokenRefreshResult>;
}

export interface NodeGrokLocalTokenScannerOptions {
  readonly costs: CostUsageRepositoryService;
  /** Test-only scanner overrides; production resolves the provider-owned root. */
  readonly scan?: Omit<NodeGrokLocalSessionScanOptions, "signal" | "now">;
  /** Injectable clock makes bucket ownership and cancellation tests deterministic. */
  readonly now?: () => Date;
}

const cancelled = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true ||
  error instanceof NodeGrokLocalSessionScanCancelledError ||
  (error instanceof Error && error.name === "AbortError");

const run = <Value>(effect: Effect.Effect<Value, unknown>, signal: AbortSignal | undefined) =>
  Effect.runPromise(effect, signal === undefined ? {} : { signal });

/**
 * Refreshes local Grok token history independently from the web billing call.
 * A filesystem failure marks the existing feed unavailable, so previously
 * retained local rows cannot look current. Cancellation never writes state.
 */
export const makeNodeGrokLocalTokenScanner = (
  options: NodeGrokLocalTokenScannerOptions,
): NodeGrokLocalTokenScanner => ({
  refresh: async (signal) => {
    const now = options.now?.() ?? new Date();
    const today = grokLocalSessionDayKey(now.getTime());
    if (today === undefined) throw new Error("Grok local token clock is invalid.");
    let replacement;
    let scannedSessions = 0;
    try {
      const scanned = await scanNodeGrokLocalSessions({
        ...options.scan,
        now,
        ...(signal === undefined ? {} : { signal }),
      });
      if (signal?.aborted === true) throw new NodeGrokLocalTokenScanCancelledError();
      const summary = summarizeGrokLocalSessions(
        scanned.signals.flatMap((entry) => {
          const parsed = parseGrokLocalSessionSignal(entry.json, entry.modifiedAtMs);
          return parsed === undefined ? [] : [parsed];
        }),
        {
          includeDaily: true,
          scannedAtMs: now.getTime(),
          truncated: scanned.truncated,
        },
      );
      if (summary.today === undefined || summary.daily === undefined) {
        throw new Error("Grok local token summary is invalid.");
      }
      scannedSessions = summary.sessionCount;
      replacement = mapGrokLocalSessionTokenActivity({
        today: summary.today,
        truncated: summary.truncated ?? false,
        daily: summary.daily,
      });
    } catch (error) {
      if (cancelled(error, signal)) throw new NodeGrokLocalTokenScanCancelledError();
      replacement = unavailableGrokLocalSessionTokenActivity(today);
    }
    // Persistence is intentionally outside the scan/map recovery boundary:
    // a SQLite/worker failure must surface once, never be reclassified as an
    // unreadable profile followed by a second destructive state write.
    await run(options.costs.replaceDaily(replacement), signal);
    return {
      availability: replacement.availability,
      coverage: replacement.coverage,
      scannedSessions: replacement.availability === "available" ? scannedSessions : 0,
      publishedDays: replacement.records.length,
    };
  },
});
