import { Effect } from "effect";
import type {
  DashboardAccountDTO,
  DashboardProviderDTO,
  DashboardSnapshotDTO,
  UsageSnapshot,
} from "@codexbar/contracts";
import type { NodeSqliteWorkerPersistence } from "@codexbar/platform/node";
import { PROVIDERS, type ProviderDescriptor } from "@codexbar/providers";

type Persistence = Pick<NodeSqliteWorkerPersistence, "history">;
type OverviewProvider = Pick<ProviderDescriptor, "id" | "name" | "status"> & {
  readonly enabled?: boolean;
  readonly source?: DashboardProviderDTO["source"];
};

const dashboardWindows = (snapshot: UsageSnapshot): DashboardProviderDTO["windows"] => {
  const standard = [
    ["primary", "Primary", snapshot.primary],
    ["secondary", "Secondary", snapshot.secondary],
    ["tertiary", "Tertiary", snapshot.tertiary],
  ] as const;
  return [
    ...standard.flatMap(([kind, label, window]) =>
      window === undefined
        ? []
        : [
            {
              kind,
              label,
              usedPercent: window.usedPercent,
              remainingPercent: Math.max(0, 100 - window.usedPercent),
              ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }),
            },
          ],
    ),
    ...(snapshot.extraRateWindows ?? []).map(({ id, title, window }) => ({
      kind: id,
      label: title,
      usedPercent: window.usedPercent,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }),
    })),
  ];
};

const emptySnapshot = (now: Date): UsageSnapshot => ({
  details: [],
  updatedAt: now.toISOString(),
  dataConfidence: "unknown",
});

const toDashboardProvider = (
  provider: OverviewProvider,
  snapshot: UsageSnapshot,
): DashboardProviderDTO => ({
  id: provider.id,
  name: provider.name,
  enabled: provider.enabled ?? provider.id === "codex",
  implementationStatus: provider.status,
  source: provider.source ?? "auto",
  windows: dashboardWindows(snapshot),
  ...(snapshot.identity === undefined ? {} : { identity: snapshot.identity }),
  ...(snapshot.providerCost === undefined ? {} : { cost: snapshot.providerCost }),
  updatedAt: snapshot.updatedAt,
});

/**
 * Reads the newest persisted snapshot for every provider. A provider with no
 * observed usage gets an ephemeral `unknown` view and does not pollute history.
 */
export const loadPersistedOverview = async (
  persistence: Persistence,
  now: () => Date = () => new Date(),
  providers: readonly OverviewProvider[] = PROVIDERS,
  claudeSwapAccounts: readonly DashboardAccountDTO[] | undefined = undefined,
): Promise<DashboardSnapshotDTO> => {
  const generatedAt = now();
  const providerSnapshots = await Promise.all(
    providers.map(async (provider) => {
      const latest = await Effect.runPromise(persistence.history.latest(provider.id));
      const dashboard = toDashboardProvider(
        provider,
        latest?.snapshot ?? emptySnapshot(generatedAt),
      );
      return provider.id === "claude" && claudeSwapAccounts !== undefined
        ? { ...dashboard, accounts: claudeSwapAccounts }
        : dashboard;
    }),
  );
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    staleAfterSeconds: 300,
    providers: providerSnapshots,
  };
};
