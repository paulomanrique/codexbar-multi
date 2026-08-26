import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  CostUsageQueryResultDTO,
  DashboardProviderDTO,
  DashboardSnapshotDTO,
  HistoryQueryResultDTO,
  ProviderId,
  ProviderSettingsDTO,
  ProviderSettingsListDTO,
  SessionQuotaNotificationSettingsDTO,
  UpdateSessionQuotaNotificationSettingsRequestDTO,
  SpendDashboardDTO,
  SpendOverviewDTO,
  TokenAccountRosterDTO,
  UpdateProviderSettingsRequestDTO,
  LegacyImportExecutionResultDTO,
  LegacyImportInspectionResultDTO,
  LegacyImportRollbackResultDTO,
  LoginRequestDTO,
  HostFailureStageDTO,
  HostStatusDTO,
} from "@codexbar/contracts";

import { createLocalization } from "./localization.ts";
import {
  type BrowserLoginPresentationStatus,
  browserLoginActionState,
  codexAccountLoginSuccessDisposition,
  makeBrowserLoginMutationGate,
  makeDefaultBrowserSessionStatusLoader,
  makeOverviewLoader,
  costTotals,
  claudeSwapActivationRequest,
  displayPercent,
  firstPartyProviderId,
  historySince,
  implementationPresentation,
  safeDateFromTimestamp,
  shouldAutoCancelCodexAccountLogin,
  shouldPublishCodexAccountLoginFailure,
} from "./view-model.ts";
import {
  isAvailableProviderSource,
  optimisticRenameTokenAccountRoster,
  optimisticRemoveTokenAccountRoster,
  optimisticTokenAccountRoster,
  sessionQuotaNotificationSettingsViewState,
} from "./settings-view-model.ts";
import { SpendDashboard } from "./spend-dashboard.tsx";
import { TokenAccountSettings } from "./token-account-settings.tsx";
import "./styles.css";

type DashboardTab = "usage" | "history" | "costs" | "spend" | "settings";
type BrowserLoginProvider = "claude" | "t3chat" | "grok";

const HISTORY_DAYS = 30;
const HISTORY_LIMIT = 100;
const DASHBOARD_TABS = ["usage", "history", "costs", "spend", "settings"] as const;
const DEFAULT_BROWSER_LOGIN_REQUESTS = {
  claude: { provider: "claude", accountId: "default" },
  t3chat: { provider: "t3chat", accountId: "default" },
  grok: { provider: "grok", accountId: "default" },
} as const satisfies Record<BrowserLoginProvider, LoginRequestDTO>;

const formatDate = (locale: string, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const date = safeDateFromTimestamp(Date.parse(value));
  return date === undefined
    ? undefined
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const formatTimestamp = (
  locale: string,
  value: number,
  unavailable: string,
): { readonly label: string; readonly dateTime?: string } => {
  const date = safeDateFromTimestamp(value);
  return date === undefined
    ? { label: unavailable }
    : {
        label: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          date,
        ),
        dateTime: date.toISOString(),
      };
};
const formatNumber = (locale: string, value: number): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
const formatUsd = (locale: string, value: number): string =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);

function ProviderCard({
  provider,
  selected,
  refreshing,
  activatingAccountId,
  locale,
  onSelect,
  onRefresh,
  onActivateClaudeSwap,
  copy,
}: {
  readonly provider: DashboardProviderDTO;
  readonly selected: boolean;
  readonly refreshing: boolean;
  readonly activatingAccountId: string | undefined;
  readonly locale: string;
  readonly onSelect: () => void;
  readonly onRefresh: () => void;
  readonly onActivateClaudeSwap: (accountId: string) => void;
  readonly copy: {
    readonly unavailable: string;
    readonly parityPending: string;
    readonly refresh: string;
    readonly refreshing: string;
    readonly disabled: string;
    readonly usageUsed: string;
    readonly usageRemaining: string;
    readonly activate: string;
    readonly activating: string;
    readonly active: string;
  };
}) {
  const refreshable = provider.enabled && firstPartyProviderId(provider.id) !== undefined;
  const updated = formatDate(locale, provider.updatedAt);
  const parityPending = implementationPresentation(provider) === "parity-pending";
  const status = parityPending ? copy.parityPending : copy.unavailable;
  return (
    <article className={selected ? "provider-card selected" : "provider-card"}>
      <button
        className="provider-select"
        aria-pressed={selected}
        aria-label={`${provider.name}: ${status}`}
        onClick={onSelect}
      >
        <span className="monogram" aria-hidden="true">
          {provider.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="provider-heading">
          <strong>{provider.name}</strong>
          <small>{provider.enabled ? provider.source : copy.disabled}</small>
        </span>
        <span className={parityPending ? "parity-pending" : "unported"}>{status}</span>
      </button>
      <div className="provider-windows" aria-label={`${provider.name} usage windows`}>
        {provider.windows.length === 0 ? <small>{copy.unavailable}</small> : null}
        {provider.windows.map((window) => {
          const used = displayPercent(window.usedPercent);
          const remaining = displayPercent(window.remainingPercent);
          const resetAt = formatDate(locale, window.resetAt);
          return (
            <div className="usage-window" key={window.kind}>
              <div className="usage-window-label">
                <span>{window.label}</span>
                <span>{`${formatNumber(locale, used)}% ${copy.usageUsed}`}</span>
              </div>
              <progress
                aria-label={`${window.label}: ${formatNumber(locale, used)}% ${copy.usageUsed}, ${formatNumber(locale, remaining)}% ${copy.usageRemaining}`}
                max={100}
                value={used}
              />
              {resetAt === undefined ? null : <small>{resetAt}</small>}
            </div>
          );
        })}
      </div>
      <div className="provider-actions">
        {updated === undefined ? null : <small>{updated}</small>}
        <button
          className="secondary compact"
          disabled={!refreshable || refreshing}
          title={refreshable ? undefined : copy.unavailable}
          onClick={onRefresh}
        >
          {refreshing ? copy.refreshing : copy.refresh}
        </button>
      </div>
      {provider.accounts === undefined || provider.accounts.length === 0 ? null : (
        <div className="provider-accounts" aria-label={`${provider.name} accounts`}>
          {provider.accounts.map((account) => {
            const request = claudeSwapActivationRequest(provider, account);
            const activating = activatingAccountId === account.id;
            return (
              <div className="provider-account" key={account.id}>
                <span>{account.label}</span>
                {account.active ? <small>{copy.active}</small> : null}
                {request === undefined ? null : (
                  <button
                    className="secondary compact"
                    disabled={activatingAccountId !== undefined}
                    onClick={() => onActivateClaudeSwap(request.accountId)}
                  >
                    {activating ? copy.activating : copy.activate}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function UsagePanel({
  provider,
  locale,
  copy,
}: {
  readonly provider: DashboardProviderDTO;
  readonly locale: string;
  readonly copy: {
    readonly unavailable: string;
    readonly usageUsed: string;
    readonly usageRemaining: string;
  };
}) {
  return (
    <>
      <h2>{provider.name}</h2>
      {provider.windows.length === 0 ? <p className="muted">{copy.unavailable}</p> : null}
      <div className="usage-detail-grid">
        {provider.windows.map((window) => {
          const used = displayPercent(window.usedPercent);
          const remaining = displayPercent(window.remainingPercent);
          return (
            <div className="usage-detail" key={window.kind}>
              <strong>{window.label}</strong>
              <span>{`${formatNumber(locale, used)}% ${copy.usageUsed}`}</span>
              <progress max={100} value={used} />
              <small>{`${formatNumber(locale, remaining)}% ${copy.usageRemaining}`}</small>
            </div>
          );
        })}
      </div>
      {provider.cost === undefined ? null : (
        <p className="provider-cost">
          {`${formatNumber(locale, provider.cost.used)} / ${formatNumber(locale, provider.cost.limit)} ${provider.cost.currencyCode}`}
        </p>
      )}
    </>
  );
}

function HistoryPanel({
  history,
  loading,
  error,
  locale,
  copy,
}: {
  readonly history: HistoryQueryResultDTO | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly locale: string;
  readonly copy: {
    readonly unavailable: string;
    readonly refreshing: string;
    readonly noUsageYet: string;
    readonly history: string;
    readonly usageUsed: string;
  };
}) {
  if (loading) return <p className="muted">{copy.refreshing}</p>;
  if (error !== undefined)
    return (
      <p className="error" role="alert">
        {copy.unavailable}
      </p>
    );
  if (history === undefined || history.records.length === 0) {
    return <p className="muted">{copy.noUsageYet}</p>;
  }
  return (
    <>
      <h2>{copy.history}</h2>
      <ol className="activity-list">
        {history.records.map((record, index) => {
          const timestamp = formatTimestamp(locale, record.recordedAt, copy.unavailable);
          return (
            <li key={`${record.providerId}:${record.recordedAt}:${index}`}>
              {timestamp.dateTime === undefined ? (
                <span>{timestamp.label}</span>
              ) : (
                <time dateTime={timestamp.dateTime}>{timestamp.label}</time>
              )}
              <span>
                {record.snapshot.primary === undefined
                  ? copy.unavailable
                  : `${formatNumber(locale, displayPercent(record.snapshot.primary.usedPercent))}% ${copy.usageUsed}`}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function CostsPanel({
  costs,
  loading,
  error,
  locale,
  copy,
}: {
  readonly costs: CostUsageQueryResultDTO | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly locale: string;
  readonly copy: {
    readonly unavailable: string;
    readonly refreshing: string;
    readonly emptyCosts: string;
    readonly costs: string;
    readonly tokens: string;
  };
}) {
  if (loading) return <p className="muted">{copy.refreshing}</p>;
  if (error !== undefined)
    return (
      <p className="error" role="alert">
        {copy.unavailable}
      </p>
    );
  if (costs === undefined || costs.records.length === 0) {
    return <p className="muted">{copy.emptyCosts}</p>;
  }
  const totals = costTotals(costs.records);
  return (
    <>
      <h2>{copy.costs}</h2>
      <p className="cost-total">{formatUsd(locale, totals.costUsd)}</p>
      <p className="muted">{`${formatNumber(locale, totals.inputTokens + totals.outputTokens)} ${copy.tokens}`}</p>
      <ol className="activity-list">
        {costs.records.map((record, index) => {
          const timestamp = formatTimestamp(locale, record.recordedAt, copy.unavailable);
          return (
            <li key={`${record.providerId}:${record.recordedAt}:${index}`}>
              {timestamp.dateTime === undefined ? (
                <span>{timestamp.label}</span>
              ) : (
                <time dateTime={timestamp.dateTime}>{timestamp.label}</time>
              )}
              <span>{formatUsd(locale, record.costUsd)}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function SettingsPanel({
  provider,
  settings,
  copy,
  pending,
  error,
  onUpdate,
  children,
}: {
  readonly provider: DashboardProviderDTO;
  readonly settings: ProviderSettingsDTO | undefined;
  readonly copy: {
    readonly enabled: string;
    readonly disabled: string;
    readonly settings: string;
    readonly provider: string;
    readonly source: string;
    readonly unavailable: string;
    readonly parityPending: string;
    readonly refreshing: string;
  };
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onUpdate: (request: UpdateProviderSettingsRequestDTO) => void;
  readonly children?: ReactNode;
}) {
  const providerId = settings?.provider ?? firstPartyProviderId(provider.id);
  const disabled = providerId === undefined || settings === undefined || pending;
  return (
    <>
      <h2>{copy.settings}</h2>
      <label className="settings-toggle">
        <input
          checked={settings?.enabled ?? provider.enabled}
          disabled={disabled}
          type="checkbox"
          onChange={(event) => {
            if (providerId === undefined || settings === undefined) return;
            onUpdate({
              provider: providerId,
              enabled: event.target.checked,
              source: settings.source,
            });
          }}
        />
        <span>{(settings?.enabled ?? provider.enabled) ? copy.enabled : copy.disabled}</span>
      </label>
      <label className="settings-source">
        <span>{copy.source}</span>
        <select
          aria-label={copy.source}
          disabled={disabled}
          value={settings?.source ?? provider.source}
          onChange={(event) => {
            if (providerId === undefined || settings === undefined) return;
            const source = event.target.value;
            if (!isAvailableProviderSource(source, settings.availableSources)) return;
            onUpdate({
              provider: providerId,
              enabled: settings.enabled,
              source,
            });
          }}
        >
          {(settings?.availableSources ?? []).map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </label>
      {children}
      {pending ? <p className="muted">{copy.refreshing}</p> : null}
      {error === undefined ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <dl className="settings-summary">
        <div>
          <dt>{copy.provider}</dt>
          <dd>{provider.name}</dd>
        </div>
        <div>
          <dt>{copy.source}</dt>
          <dd>{settings?.source ?? provider.source}</dd>
        </div>
        <div>
          <dt>TypeScript</dt>
          <dd>
            {implementationPresentation(provider) === "parity-pending"
              ? copy.parityPending
              : copy.unavailable}
          </dd>
        </div>
      </dl>
    </>
  );
}

function SessionQuotaNotificationSettings({
  settings,
  pending,
  error,
  onUpdate,
  copy,
}: {
  readonly settings: SessionQuotaNotificationSettingsDTO | undefined;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onUpdate: (request: UpdateSessionQuotaNotificationSettingsRequestDTO) => void;
  readonly copy: {
    readonly title: string;
    readonly subtitle: string;
    readonly enabled: string;
    readonly disabled: string;
    readonly refreshing: string;
  };
}) {
  const state = sessionQuotaNotificationSettingsViewState(settings, pending, error);
  return (
    <section className="global-settings" aria-labelledby="session-quota-notifications-title">
      <div>
        <h3 id="session-quota-notifications-title">{copy.title}</h3>
        <p className="muted">{copy.subtitle}</p>
      </div>
      <label className="settings-toggle">
        <input
          checked={state.enabled}
          disabled={state.disabled}
          type="checkbox"
          onChange={(event) => onUpdate({ enabled: event.target.checked })}
        />
        <span>{state.enabled ? copy.enabled : copy.disabled}</span>
      </label>
      {state.status === "loading" || state.status === "pending" ? (
        <p className="muted">{copy.refreshing}</p>
      ) : null}
      {state.status === "error" ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function LegacyImportSettings({
  inspection,
  execution,
  rollback,
  busy,
  error,
  onInspect,
  onExecute,
  onRollback,
  copy,
}: {
  readonly inspection: LegacyImportInspectionResultDTO | undefined;
  readonly execution: LegacyImportExecutionResultDTO | undefined;
  readonly rollback: LegacyImportRollbackResultDTO | undefined;
  readonly busy: "inspect" | "execute" | "rollback" | undefined;
  readonly error: string | undefined;
  readonly onInspect: () => void;
  readonly onExecute: (ticket: string) => void;
  readonly onRollback: (importId: string) => void;
  readonly copy: {
    readonly title: string;
    readonly description: string;
    readonly inspect: string;
    readonly execute: string;
    readonly rollback: string;
    readonly cancelled: string;
    readonly ready: string;
    readonly completed: string;
    readonly unavailable: string;
  };
}) {
  const ready = inspection?.status === "ready" ? inspection : undefined;
  const completed =
    execution?.status === "completed" || execution?.status === "already-completed"
      ? execution
      : undefined;
  return (
    <section
      className="global-settings legacy-import-settings"
      aria-labelledby="legacy-import-title"
    >
      <div>
        <h3 id="legacy-import-title">{copy.title}</h3>
        <p className="muted">{copy.description}</p>
      </div>
      <div className="provider-actions">
        <button className="secondary" disabled={busy !== undefined} onClick={onInspect}>
          {copy.inspect}
        </button>
        {ready === undefined ||
        !ready.candidates.some((candidate) => candidate.state === "ready") ? null : (
          <button disabled={busy !== undefined} onClick={() => onExecute(ready.ticket)}>
            {copy.execute}
          </button>
        )}
      </div>
      {inspection?.status === "cancelled" ? <p className="muted">{copy.cancelled}</p> : null}
      {ready === undefined ? null : (
        <ul className="legacy-import-candidates">
          {ready.candidates.map((candidate) => (
            <li key={candidate.kind}>
              <span>{candidate.kind}</span>
              <span>{`${candidate.state} · ${candidate.itemCount}`}</span>
            </li>
          ))}
        </ul>
      )}
      {completed === undefined ? null : (
        <div className="legacy-import-result">
          <p role="status">{`${copy.completed}: ${Object.values(completed.imported).reduce((sum, count) => sum + count, 0)}`}</p>
          <button
            className="secondary"
            disabled={busy !== undefined}
            onClick={() => onRollback(completed.importId)}
          >
            {copy.rollback}
          </button>
        </div>
      )}
      {rollback?.status === "completed" ? (
        <p role="status">{`${copy.rollback}: ${Object.values(rollback.removed).reduce((sum, count) => sum + count, 0)}`}</p>
      ) : null}
      {busy === undefined ? null : <p className="muted">{copy.ready}</p>}
      {error === undefined ? null : (
        <p className="error" role="alert">
          {copy.unavailable}
        </p>
      )}
    </section>
  );
}

function App() {
  const localization = useMemo(() => createLocalization("system", navigator.languages), []);
  const [snapshot, setSnapshot] = useState<DashboardSnapshotDTO>();
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsListDTO>();
  const [sessionQuotaNotificationSettings, setSessionQuotaNotificationSettings] =
    useState<SessionQuotaNotificationSettingsDTO>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<DashboardTab>("usage");
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [providerSearch, setProviderSearch] = useState("");
  const [refreshingProviderId, setRefreshingProviderId] = useState<string>();
  const [activatingClaudeSwapAccountId, setActivatingClaudeSwapAccountId] = useState<string>();
  const [savingProviderId, setSavingProviderId] = useState<string>();
  const [settingsError, setSettingsError] = useState<{
    readonly provider: string;
    readonly message: string;
  }>();
  const [tokenAccountRoster, setTokenAccountRoster] = useState<TokenAccountRosterDTO>();
  const [tokenAccountLoading, setTokenAccountLoading] = useState(false);
  const [tokenAccountPending, setTokenAccountPending] = useState(false);
  const [codexAccountLoginPending, setCodexAccountLoginPending] = useState(false);
  const [tokenAccountError, setTokenAccountError] = useState<string>();
  const codexAccountLoginCancelled = useRef(false);
  const codexAccountLoginAutoCancelRequested = useRef(false);
  const selectedProviderFirstPartyIdRef = useRef<ProviderId | undefined>(undefined);
  const tokenAccountScope = useRef(0);
  const [savingSessionQuotaNotificationSettings, setSavingSessionQuotaNotificationSettings] =
    useState(false);
  const [sessionQuotaNotificationSettingsError, setSessionQuotaNotificationSettingsError] =
    useState<string>();
  const [legacyImportInspection, setLegacyImportInspection] =
    useState<LegacyImportInspectionResultDTO>();
  const [legacyImportExecution, setLegacyImportExecution] =
    useState<LegacyImportExecutionResultDTO>();
  const [legacyImportRollback, setLegacyImportRollback] = useState<LegacyImportRollbackResultDTO>();
  const [legacyImportBusy, setLegacyImportBusy] = useState<"inspect" | "execute" | "rollback">();
  const [legacyImportError, setLegacyImportError] = useState<string>();
  const [history, setHistory] = useState<HistoryQueryResultDTO>();
  const [costs, setCosts] = useState<CostUsageQueryResultDTO>();
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string>();
  const [activityVersion, setActivityVersion] = useState(0);
  const [spendOverview, setSpendOverview] = useState<SpendOverviewDTO>();
  const [spendDashboard, setSpendDashboard] = useState<SpendDashboardDTO>();
  const [spendLoading, setSpendLoading] = useState(true);
  const [spendError, setSpendError] = useState(false);
  const [claudeStatus, setClaudeStatus] = useState<BrowserLoginPresentationStatus>("idle");
  const [t3Status, setT3Status] = useState<BrowserLoginPresentationStatus>("idle");
  const [grokStatus, setGrokStatus] = useState<BrowserLoginPresentationStatus>("idle");
  const [browserLoginMutationPending, setBrowserLoginMutationPending] = useState(false);
  const browserLoginMutationGate = useMemo(() => makeBrowserLoginMutationGate(), []);
  const browserSessionStatusLoader = useMemo(
    () =>
      makeDefaultBrowserSessionStatusLoader({
        read: () => window.codexbar.getDefaultBrowserSessionStatuses(),
        publish: (statuses) => {
          setClaudeStatus(statuses.claude);
          setT3Status(statuses.t3chat);
          setGrokStatus(statuses.grok);
        },
      }),
    [],
  );
  const overviewLoader = useMemo(
    () =>
      makeOverviewLoader({
        readOverview: () => window.codexbar.getOverview(),
        readProviderSettings: () => window.codexbar.getProviderSettings(),
        publish: ({ overview, providerSettings: nextProviderSettings }) => {
          setSnapshot(overview);
          setProviderSettings(nextProviderSettings);
          setSelectedProviderId((current) => current ?? overview.providers[0]?.id);
          setError(undefined);
        },
        publishError: () => setError(localization.upstream("Unavailable")),
      }),
    [localization],
  );
  const selectedProvider = snapshot?.providers.find(
    (provider) => provider.id === selectedProviderId,
  );
  const selectedProviderFirstPartyId =
    selectedProvider === undefined ? undefined : firstPartyProviderId(selectedProvider.id);
  selectedProviderFirstPartyIdRef.current = selectedProviderFirstPartyId;
  const selectedProviderSettings = providerSettings?.providers.find(
    (settings) => settings.provider === selectedProviderFirstPartyId,
  );
  const selectedTokenAccountProvider =
    selectedProviderSettings?.tokenAccounts === undefined
      ? undefined
      : selectedProviderFirstPartyId;
  const filteredProviders =
    snapshot?.providers.filter((provider) => {
      const query = providerSearch.trim().toLocaleLowerCase(localization.locale);
      return (
        query.length === 0 ||
        provider.name.toLocaleLowerCase(localization.locale).includes(query) ||
        provider.id.toLocaleLowerCase(localization.locale).includes(query)
      );
    }) ?? [];
  const loadOverview = (): Promise<void> => overviewLoader.load();
  const loadSessionQuotaNotificationSettings = async (): Promise<void> => {
    try {
      const settings = await window.codexbar.getSessionQuotaNotificationSettings();
      setSessionQuotaNotificationSettings(settings);
      setSessionQuotaNotificationSettingsError(undefined);
    } catch {
      // This auxiliary control must never make overview/provider IPC look
      // unavailable. Its error remains immediately beside the toggle.
      setSessionQuotaNotificationSettingsError(localization.upstream("Unavailable"));
    }
  };
  const loadDefaultBrowserSessionStatuses = (): Promise<void> => browserSessionStatusLoader.load();
  const loadSpend = async (): Promise<void> => {
    setSpendLoading(true);
    setSpendError(false);
    setSpendDashboard(undefined);
    try {
      // Overview refreshes the safe publication; dashboard then reads that
      // same projection without asking the renderer for provider internals.
      const nextOverview = await window.codexbar.getSpendOverview();
      setSpendOverview(nextOverview);
      const nextDashboard = await window.codexbar.getSpendDashboard();
      setSpendDashboard(nextDashboard);
    } catch {
      setSpendError(true);
    } finally {
      setSpendLoading(false);
    }
  };

  useEffect(() => {
    document.documentElement.lang = localization.locale;
    document.documentElement.dir = localization.direction;
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [localization]);
  useEffect(() => {
    overviewLoader.activate();
    void overviewLoader.load();
    const unsubscribe = window.codexbar.onOverviewUpdated(() => {
      void overviewLoader.load();
    });
    return () => {
      unsubscribe();
      overviewLoader.dispose();
    };
  }, [overviewLoader]);
  useEffect(() => {
    void loadSessionQuotaNotificationSettings();
  }, []);
  useEffect(() => {
    void loadDefaultBrowserSessionStatuses();
  }, []);
  useEffect(() => {
    void loadSpend();
  }, []);
  useEffect(() => {
    const scope = ++tokenAccountScope.current;
    setTokenAccountRoster(undefined);
    setTokenAccountError(undefined);
    setTokenAccountPending(false);
    if (selectedTokenAccountProvider === undefined) {
      setTokenAccountLoading(false);
      return;
    }
    setTokenAccountLoading(true);
    void window.codexbar.listTokenAccounts({ provider: selectedTokenAccountProvider }).then(
      (roster) => {
        if (tokenAccountScope.current !== scope) return;
        setTokenAccountRoster(roster);
        setTokenAccountLoading(false);
      },
      () => {
        if (tokenAccountScope.current !== scope) return;
        setTokenAccountError(localization.upstream("Unavailable"));
        setTokenAccountLoading(false);
      },
    );
  }, [activityVersion, localization, selectedTokenAccountProvider]);
  useEffect(() => {
    if (
      !shouldAutoCancelCodexAccountLogin(
        codexAccountLoginPending,
        selectedProviderFirstPartyId,
        codexAccountLoginAutoCancelRequested.current,
      )
    ) {
      return;
    }
    codexAccountLoginCancelled.current = true;
    codexAccountLoginAutoCancelRequested.current = true;
    void window.codexbar.cancelCodexAccountLogin({ provider: "codex" }).catch(() => undefined);
  }, [codexAccountLoginPending, selectedProviderFirstPartyId]);
  useEffect(() => {
    if (selectedProviderFirstPartyId === undefined) {
      setHistory(undefined);
      setCosts(undefined);
      return;
    }
    let active = true;
    setActivityLoading(true);
    setActivityError(undefined);
    const query = {
      provider: selectedProviderFirstPartyId,
      since: historySince(HISTORY_DAYS),
      limit: HISTORY_LIMIT,
    } as const;
    void Promise.all([window.codexbar.getHistory(query), window.codexbar.getCosts(query)]).then(
      ([nextHistory, nextCosts]) => {
        if (!active) return;
        setHistory(nextHistory);
        setCosts(nextCosts);
        setActivityLoading(false);
      },
      () => {
        if (!active) return;
        setActivityError(localization.upstream("Unavailable"));
        setActivityLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [activityVersion, selectedProviderFirstPartyId]);
  const refreshProvider = (provider: DashboardProviderDTO): void => {
    const providerId = firstPartyProviderId(provider.id);
    if (providerId === undefined || !provider.enabled) return;
    setRefreshingProviderId(provider.id);
    setError(undefined);
    void window.codexbar
      .refreshProvider({ provider: providerId, source: provider.source })
      .then(loadOverview)
      .then(() => setActivityVersion((version) => version + 1))
      .catch(() => setError(localization.upstream("Unavailable")))
      .finally(() => setRefreshingProviderId(undefined));
  };
  const activateClaudeSwap = (accountId: string): void => {
    setActivatingClaudeSwapAccountId(accountId);
    setError(undefined);
    void window.codexbar
      .activateClaudeSwapAccount({ provider: "claude", accountId })
      .then(loadOverview)
      .then(() => setActivityVersion((version) => version + 1))
      .catch(() => setError(localization.upstream("Unavailable")))
      .finally(() => setActivatingClaudeSwapAccountId(undefined));
  };
  const updateProviderSettings = (request: UpdateProviderSettingsRequestDTO): void => {
    setSavingProviderId(request.provider);
    setSettingsError(undefined);
    void window.codexbar
      .updateProviderSettings(request)
      .then(loadOverview)
      .catch(() =>
        setSettingsError({
          provider: request.provider,
          message: localization.upstream("Unavailable"),
        }),
      )
      .finally(() => setSavingProviderId(undefined));
  };
  const selectTokenAccount = (accountId: string): void => {
    const previous = tokenAccountRoster;
    const provider = selectedTokenAccountProvider;
    if (provider === undefined || previous?.provider !== provider) return;
    const optimistic = optimisticTokenAccountRoster(previous, accountId);
    if (optimistic === undefined || optimistic.activeIndex === previous.activeIndex) return;
    const scope = tokenAccountScope.current;
    setTokenAccountRoster(optimistic);
    setTokenAccountPending(true);
    setTokenAccountError(undefined);
    const selection = window.codexbar.selectTokenAccount({
      provider,
      accountId,
      expectedRevision: previous.revision,
    });
    void selection
      .then(
        (roster) => {
          if (tokenAccountScope.current !== scope) return;
          setTokenAccountRoster(roster);
          void loadOverview()
            .then(() => setActivityVersion((version) => version + 1))
            .catch(() => setError(localization.upstream("Unavailable")));
        },
        () => {
          if (tokenAccountScope.current !== scope) return;
          setTokenAccountRoster(previous);
          setTokenAccountError(localization.upstream("Unavailable"));
          void window.codexbar.listTokenAccounts({ provider }).then(
            (roster) => {
              if (tokenAccountScope.current === scope) setTokenAccountRoster(roster);
            },
            () => undefined,
          );
        },
      )
      .finally(() => {
        if (tokenAccountScope.current !== scope) return;
        setTokenAccountPending(false);
      });
  };
  const renameTokenAccount = (accountId: string, label: string): void => {
    const previous = tokenAccountRoster;
    const provider = selectedTokenAccountProvider;
    if (provider === undefined || previous?.provider !== provider) return;
    const optimistic = optimisticRenameTokenAccountRoster(previous, accountId, label);
    if (optimistic === undefined) return;
    const scope = tokenAccountScope.current;
    setTokenAccountRoster(optimistic);
    setTokenAccountPending(true);
    setTokenAccountError(undefined);
    const rename = window.codexbar.renameTokenAccount({
      provider,
      accountId,
      label: label.trim(),
      expectedRevision: previous.revision,
    });
    void rename
      .then(
        (roster) => {
          if (tokenAccountScope.current !== scope) return;
          setTokenAccountRoster(roster);
        },
        () => {
          if (tokenAccountScope.current !== scope) return;
          setTokenAccountRoster(previous);
          setTokenAccountError(localization.upstream("Unavailable"));
          void window.codexbar.listTokenAccounts({ provider }).then(
            (roster) => {
              if (tokenAccountScope.current === scope) setTokenAccountRoster(roster);
            },
            () => undefined,
          );
        },
      )
      .finally(() => {
        if (tokenAccountScope.current !== scope) return;
        setTokenAccountPending(false);
      });
  };
  const removeTokenAccount = (accountId: string): void => {
    const previous = tokenAccountRoster;
    const provider = selectedTokenAccountProvider;
    if (provider === undefined || previous?.provider !== provider) return;
    const optimistic = optimisticRemoveTokenAccountRoster(previous, accountId);
    if (optimistic === undefined) return;
    const scope = tokenAccountScope.current;
    setTokenAccountRoster(optimistic);
    setTokenAccountPending(true);
    setTokenAccountError(undefined);
    const removal = window.codexbar.removeTokenAccount({
      provider,
      accountId,
      expectedRevision: previous.revision,
    });
    void removal
      .then(
        (roster) => {
          if (tokenAccountScope.current !== scope) return;
          setTokenAccountRoster(roster);
          void loadOverview()
            .then(() => setActivityVersion((version) => version + 1))
            .catch(() => setError(localization.upstream("Unavailable")));
        },
        () => {
          if (tokenAccountScope.current !== scope) return;
          // Config-first deletion may already be durable even when keyring
          // cleanup fails. Hide stale controls until a host relist succeeds.
          setTokenAccountRoster(undefined);
          setTokenAccountError(localization.upstream("Unavailable"));
          void window.codexbar.listTokenAccounts({ provider }).then(
            (roster) => {
              if (tokenAccountScope.current === scope) setTokenAccountRoster(roster);
            },
            () => undefined,
          );
        },
      )
      .finally(() => {
        if (tokenAccountScope.current !== scope) return;
        setTokenAccountPending(false);
      });
  };
  const startCodexAccountLogin = (): void => {
    if (
      selectedProviderSettings?.tokenAccounts?.creation !== "codex-cli" ||
      codexAccountLoginPending
    )
      return;
    const scope = tokenAccountScope.current;
    codexAccountLoginCancelled.current = false;
    codexAccountLoginAutoCancelRequested.current = false;
    setCodexAccountLoginPending(true);
    setTokenAccountError(undefined);
    void window.codexbar
      .startCodexAccountLogin({ provider: "codex" })
      .then((roster) => {
        const disposition = codexAccountLoginSuccessDisposition(
          scope,
          tokenAccountScope.current,
          selectedProviderFirstPartyIdRef.current,
        );
        if (disposition.publishRoster) setTokenAccountRoster(roster);
        // Reconcile even after Codex -> other -> Codex. The intermediate
        // relist may have raced the host's durable credential publication.
        if (disposition.reconcile) {
          void loadOverview()
            .then(() => setActivityVersion((version) => version + 1))
            .catch(() => setError(localization.upstream("Unavailable")));
        }
      })
      .catch(() => {
        if (
          !shouldPublishCodexAccountLoginFailure(
            scope,
            tokenAccountScope.current,
            selectedProviderFirstPartyIdRef.current,
            codexAccountLoginCancelled.current,
          )
        )
          return;
        setTokenAccountError(localization.upstream("Could not add Codex account"));
      })
      .finally(() => {
        setCodexAccountLoginPending(false);
      });
  };
  const cancelCodexAccountLogin = (): void => {
    if (!codexAccountLoginPending) return;
    const scope = tokenAccountScope.current;
    codexAccountLoginCancelled.current = true;
    void window.codexbar.cancelCodexAccountLogin({ provider: "codex" }).catch(() => {
      if (
        scope === tokenAccountScope.current &&
        selectedProviderFirstPartyIdRef.current === "codex"
      ) {
        setTokenAccountError(localization.upstream("Unavailable"));
      }
    });
  };
  const updateSessionQuotaNotificationSettings = (
    request: UpdateSessionQuotaNotificationSettingsRequestDTO,
  ): void => {
    setSavingSessionQuotaNotificationSettings(true);
    setSessionQuotaNotificationSettingsError(undefined);
    void window.codexbar
      .updateSessionQuotaNotificationSettings(request)
      .then((next) => setSessionQuotaNotificationSettings(next))
      .catch(() => setSessionQuotaNotificationSettingsError(localization.upstream("Unavailable")))
      .finally(() => setSavingSessionQuotaNotificationSettings(false));
  };
  const inspectLegacyImport = (): void => {
    setLegacyImportBusy("inspect");
    setLegacyImportError(undefined);
    setLegacyImportExecution(undefined);
    setLegacyImportRollback(undefined);
    void window.codexbar
      .inspectLegacyImport()
      .then(setLegacyImportInspection)
      .catch(() => setLegacyImportError(copy.unavailable))
      .finally(() => setLegacyImportBusy(undefined));
  };
  const executeLegacyImport = (ticket: string): void => {
    setLegacyImportBusy("execute");
    setLegacyImportError(undefined);
    void window.codexbar
      .executeLegacyImport({ ticket })
      .then((result) => {
        setLegacyImportExecution(result);
        if (result.status !== "cancelled") setActivityVersion((version) => version + 1);
      })
      .catch(() => setLegacyImportError(copy.unavailable))
      .finally(() => setLegacyImportBusy(undefined));
  };
  const rollbackLegacyImport = (importId: string): void => {
    setLegacyImportBusy("rollback");
    setLegacyImportError(undefined);
    void window.codexbar
      .rollbackLegacyImport({ importId })
      .then((result) => {
        setLegacyImportRollback(result);
        if (result.status !== "cancelled") setActivityVersion((version) => version + 1);
      })
      .catch(() => setLegacyImportError(copy.unavailable))
      .finally(() => setLegacyImportBusy(undefined));
  };
  const partialCount = snapshot?.providers.filter(
    (provider) => implementationPresentation(provider) === "parity-pending",
  ).length;
  const copy = {
    unavailable: localization.upstream("Unavailable"),
    parityPending: localization.t("awaitingParity"),
    refresh: localization.upstream("Refresh"),
    refreshing: localization.upstream("Refreshing"),
    activate: localization.upstream("Activate"),
    activating: localization.upstream("Activating"),
    active: localization.upstream("Active"),
    disabled: localization.upstream("Disabled"),
    enabled: localization.upstream("Enabled"),
    provider: localization.upstream("Provider"),
    source: localization.upstream("Source"),
    history: localization.upstream("Usage history (30 days)"),
    costs: localization.upstream("Usage & Spend"),
    settings: localization.upstream("Settings..."),
    usageDashboard: localization.upstream("Usage Dashboard"),
    noUsageYet: localization.upstream("No usage yet"),
    emptyCosts: localization.upstream("No cost history data."),
    tokens: localization.upstream("tokens"),
    usageUsed: localization.upstream("Usage used"),
    usageRemaining: localization.upstream("Usage remaining"),
    spend: localization.upstream("Spend"),
    spendDescription: localization.upstream(
      "Local estimated cost history across supported providers.",
    ),
    spendEmptyTitle: localization.upstream("No local cost history yet"),
    spendEmptyDescription: localization.upstream(
      "Turn on cost tracking or refresh after using a supported provider.",
    ),
    estimatedSpend: localization.upstream("Estimated spend"),
    trackedTokens: localization.upstream("Tracked tokens"),
    sources: localization.upstream("Sources"),
    coverage: localization.upstream("Coverage"),
    input: localization.upstream("Input"),
    output: localization.upstream("Output"),
    bySource: localization.upstream("By source"),
    dailyEstimatedSpend: localization.upstream("Daily estimated spend"),
    stale: localization.upstream("stale data"),
    partial: localization.upstream("Partial estimate"),
    savedAccounts: localization.upstream("Saved accounts"),
    account: localization.upstream("Account"),
    noSavedAccounts: localization.upstream("No saved accounts"),
  };
  const loginCopy = {
    waiting: localization.t("loginWaiting"),
    connected: localization.t("loginConnected"),
    start: localization.t("loginStart"),
    logout: localization.t("logout"),
    unavailable: copy.unavailable,
  };
  const claudeLoginAction = browserLoginActionState(claudeStatus, "Claude", loginCopy);
  const t3LoginAction = browserLoginActionState(t3Status, "T3 Chat", loginCopy);
  const grokLoginAction = browserLoginActionState(grokStatus, "Grok", loginCopy);
  const startBrowserLogin = (
    provider: BrowserLoginProvider,
    setStatus: (status: BrowserLoginPresentationStatus) => void,
  ): void => {
    if (!browserLoginMutationGate.tryStart()) return;
    setBrowserLoginMutationPending(true);
    browserSessionStatusLoader.invalidate();
    setStatus("waiting");
    window.codexbar.startLogin(DEFAULT_BROWSER_LOGIN_REQUESTS[provider]).then(
      () => {
        browserLoginMutationGate.finish();
        setBrowserLoginMutationPending(false);
        void loadDefaultBrowserSessionStatuses();
      },
      () => {
        browserLoginMutationGate.finish();
        setBrowserLoginMutationPending(false);
        setError(copy.unavailable);
        void loadDefaultBrowserSessionStatuses();
      },
    );
  };
  const logoutBrowserLogin = (
    provider: BrowserLoginProvider,
    setStatus: (status: BrowserLoginPresentationStatus) => void,
  ): void => {
    if (!browserLoginMutationGate.tryStart()) return;
    setBrowserLoginMutationPending(true);
    browserSessionStatusLoader.invalidate();
    setStatus("waiting");
    void window.codexbar.logout(DEFAULT_BROWSER_LOGIN_REQUESTS[provider]).then(
      () => {
        browserLoginMutationGate.finish();
        setBrowserLoginMutationPending(false);
        void loadDefaultBrowserSessionStatuses();
      },
      () => {
        browserLoginMutationGate.finish();
        setBrowserLoginMutationPending(false);
        setError(copy.unavailable);
        void loadDefaultBrowserSessionStatuses();
      },
    );
  };
  const focusTab = (next: DashboardTab): void => {
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  const moveTabFocus = (current: DashboardTab, direction: -1 | 1): void => {
    const currentIndex = DASHBOARD_TABS.indexOf(current);
    const nextIndex = (currentIndex + direction + DASHBOARD_TABS.length) % DASHBOARD_TABS.length;
    const next = DASHBOARD_TABS[nextIndex];
    if (next === undefined) return;
    focusTab(next);
  };
  return (
    <main>
      <header>
        <div>
          <small>{localization.t("usageOverview")}</small>
          <h1>CodexBar Multi</h1>
        </div>
        <span className="platform">{localization.t("platform")}</span>
      </header>
      <p className="parity-notice" role="status">
        {partialCount === undefined
          ? localization.t("loadingProviders")
          : `${partialCount} / ${snapshot?.providers.length ?? 0} · ${copy.parityPending}`}
      </p>
      {error === undefined ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="login-actions">
        <button
          disabled={browserLoginMutationPending || claudeLoginAction.loginDisabled}
          onClick={() => startBrowserLogin("claude", setClaudeStatus)}
        >
          {claudeLoginAction.loginLabel}
        </button>
        {claudeLoginAction.showLogout ? (
          <button
            className="secondary"
            disabled={browserLoginMutationPending || claudeLoginAction.logoutDisabled}
            onClick={() => logoutBrowserLogin("claude", setClaudeStatus)}
          >
            {claudeLoginAction.logoutLabel}
          </button>
        ) : null}
        <button
          disabled={browserLoginMutationPending || t3LoginAction.loginDisabled}
          onClick={() => startBrowserLogin("t3chat", setT3Status)}
        >
          {t3LoginAction.loginLabel}
        </button>
        {t3LoginAction.showLogout ? (
          <button
            className="secondary"
            disabled={browserLoginMutationPending || t3LoginAction.logoutDisabled}
            onClick={() => logoutBrowserLogin("t3chat", setT3Status)}
          >
            {t3LoginAction.logoutLabel}
          </button>
        ) : null}
        <button
          disabled={browserLoginMutationPending || grokLoginAction.loginDisabled}
          onClick={() => startBrowserLogin("grok", setGrokStatus)}
        >
          {grokLoginAction.loginLabel}
        </button>
        {grokLoginAction.showLogout ? (
          <button
            className="secondary"
            disabled={browserLoginMutationPending || grokLoginAction.logoutDisabled}
            onClick={() => logoutBrowserLogin("grok", setGrokStatus)}
          >
            {grokLoginAction.logoutLabel}
          </button>
        ) : null}
      </div>
      <div
        className="tabs"
        role="tablist"
        aria-label={copy.usageDashboard}
        aria-orientation="horizontal"
      >
        {DASHBOARD_TABS.map((id) => {
          const label =
            id === "usage"
              ? localization.upstream("Usage")
              : id === "history"
                ? localization.upstream("Usage history (30 days)")
                : id === "costs"
                  ? localization.upstream("Usage & Spend")
                  : id === "spend"
                    ? copy.spend
                    : localization.upstream("Settings...");
          return (
            <button
              className={tab === id ? "tab active" : "tab"}
              id={`tab-${id}`}
              key={id}
              role="tab"
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                if (event.key === "Home") {
                  event.preventDefault();
                  focusTab(DASHBOARD_TABS[0]);
                  return;
                }
                if (event.key === "End") {
                  event.preventDefault();
                  const lastTab = DASHBOARD_TABS.at(-1);
                  if (lastTab !== undefined) focusTab(lastTab);
                  return;
                }
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                moveTabFocus(id, event.key === "ArrowLeft" ? -1 : 1);
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <section
        className="detail-panel"
        hidden={tab !== "usage"}
        id="panel-usage"
        role="tabpanel"
        aria-labelledby="tab-usage"
      >
        {selectedProvider === undefined ? (
          <p className="muted">{copy.noUsageYet}</p>
        ) : (
          <UsagePanel provider={selectedProvider} locale={localization.locale} copy={copy} />
        )}
      </section>
      <section
        className="detail-panel"
        hidden={tab !== "history"}
        id="panel-history"
        role="tabpanel"
        aria-labelledby="tab-history"
      >
        {selectedProvider === undefined ? (
          <p className="muted">{copy.noUsageYet}</p>
        ) : (
          <HistoryPanel
            copy={copy}
            history={history}
            loading={activityLoading}
            error={activityError}
            locale={localization.locale}
          />
        )}
      </section>
      <section
        className="detail-panel"
        hidden={tab !== "costs"}
        id="panel-costs"
        role="tabpanel"
        aria-labelledby="tab-costs"
      >
        {selectedProvider === undefined ? (
          <p className="muted">{copy.noUsageYet}</p>
        ) : (
          <CostsPanel
            copy={copy}
            costs={costs}
            loading={activityLoading}
            error={activityError}
            locale={localization.locale}
          />
        )}
      </section>
      <section
        className="detail-panel"
        hidden={tab !== "settings"}
        id="panel-settings"
        role="tabpanel"
        aria-labelledby="tab-settings"
      >
        <SessionQuotaNotificationSettings
          copy={{
            title: localization.upstream("Session quota notifications"),
            subtitle: localization.upstream("session_quota_notifications_subtitle"),
            enabled: copy.enabled,
            disabled: copy.disabled,
            refreshing: copy.refreshing,
          }}
          error={sessionQuotaNotificationSettingsError}
          pending={savingSessionQuotaNotificationSettings}
          settings={sessionQuotaNotificationSettings}
          onUpdate={updateSessionQuotaNotificationSettings}
        />
        <LegacyImportSettings
          busy={legacyImportBusy}
          copy={{
            title: localization.upstream("Import legacy CodexBar data"),
            description: localization.upstream(
              "Select a copied Swift installation. Credentials and approvals are never imported.",
            ),
            inspect: localization.upstream("Inspect"),
            execute: localization.upstream("Import"),
            rollback: localization.upstream("Roll Back"),
            cancelled: localization.upstream("Cancelled"),
            ready: copy.refreshing,
            completed: localization.upstream("Imported"),
            unavailable: copy.unavailable,
          }}
          error={legacyImportError}
          execution={legacyImportExecution}
          inspection={legacyImportInspection}
          rollback={legacyImportRollback}
          onExecute={executeLegacyImport}
          onInspect={inspectLegacyImport}
          onRollback={rollbackLegacyImport}
        />
        {selectedProvider === undefined ? <p className="muted">{copy.noUsageYet}</p> : null}
        {selectedProvider === undefined ? null : (
          <SettingsPanel
            provider={selectedProvider}
            settings={selectedProviderSettings}
            copy={copy}
            error={
              settingsError?.provider === selectedProvider.id ? settingsError.message : undefined
            }
            pending={savingProviderId === selectedProvider.id}
            onUpdate={updateProviderSettings}
          >
            {selectedProviderSettings?.tokenAccounts === undefined ? null : (
              <TokenAccountSettings
                copy={{
                  title: copy.savedAccounts,
                  account: copy.account,
                  label: localization.upstream("Label"),
                  empty: copy.noSavedAccounts,
                  apply: localization.upstream("apply"),
                  refreshing: copy.refreshing,
                  remove: localization.upstream("Remove"),
                  add: localization.upstream("Add Account"),
                  cancel: localization.upstream("Cancel"),
                  source: copy.source,
                  manual: localization.upstream("Manual"),
                }}
                error={tokenAccountError}
                loginPending={
                  selectedProviderSettings.tokenAccounts.creation === "codex-cli" &&
                  codexAccountLoginPending
                }
                loading={tokenAccountLoading}
                pending={tokenAccountPending}
                roster={tokenAccountRoster}
                {...(selectedProviderSettings.tokenAccounts.selectionSetsCookieSource === undefined
                  ? {}
                  : {
                      selectionSetsCookieSource:
                        selectedProviderSettings.tokenAccounts.selectionSetsCookieSource,
                    })}
                {...(selectedProviderSettings.tokenAccounts.creation === "codex-cli"
                  ? {
                      creation: "codex-cli" as const,
                      onAdd: startCodexAccountLogin,
                      onCancelAdd: cancelCodexAccountLogin,
                    }
                  : { creation: "none" as const })}
                onRename={renameTokenAccount}
                onRemove={removeTokenAccount}
                onSelect={selectTokenAccount}
              />
            )}
          </SettingsPanel>
        )}
      </section>
      <section
        className="detail-panel"
        hidden={tab !== "spend"}
        id="panel-spend"
        role="tabpanel"
        aria-labelledby="tab-spend"
      >
        <SpendDashboard
          copy={{
            title: copy.spend,
            description: copy.spendDescription,
            refresh: copy.refresh,
            refreshing: copy.refreshing,
            unavailable: copy.unavailable,
            emptyTitle: copy.spendEmptyTitle,
            emptyDescription: copy.spendEmptyDescription,
            estimatedSpend: copy.estimatedSpend,
            trackedTokens: copy.trackedTokens,
            sources: copy.sources,
            coverage: copy.coverage,
            input: copy.input,
            output: copy.output,
            bySource: copy.bySource,
            dailyEstimatedSpend: copy.dailyEstimatedSpend,
            stale: copy.stale,
            partial: copy.partial,
          }}
          dashboard={spendDashboard}
          error={spendError}
          loading={spendLoading}
          locale={localization.locale}
          overview={spendOverview}
          onRefresh={loadSpend}
        />
      </section>
      <section className="providers-panel" aria-label={localization.upstream("Providers")}>
        <label className="provider-search">
          <span>{localization.upstream("Providers")}</span>
          <input
            value={providerSearch}
            onChange={(event) => setProviderSearch(event.target.value)}
            placeholder={localization.upstream("Provider")}
          />
        </label>
        {snapshot === undefined ? (
          <p className="muted">{localization.t("loadingProviders")}</p>
        ) : null}
        {snapshot !== undefined && filteredProviders.length === 0 ? (
          <p className="muted">{localization.upstream("No usage configured.")}</p>
        ) : null}
        <div className="provider-list">
          {filteredProviders.map((provider) => (
            <ProviderCard
              copy={copy}
              key={provider.id}
              locale={localization.locale}
              provider={provider}
              refreshing={refreshingProviderId === provider.id}
              activatingAccountId={activatingClaudeSwapAccountId}
              selected={selectedProvider?.id === provider.id}
              onRefresh={() => refreshProvider(provider)}
              onActivateClaudeSwap={activateClaudeSwap}
              onSelect={() => setSelectedProviderId(provider.id)}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

type StartupShellProps =
  | { readonly status: "starting" }
  | { readonly status: "failed"; readonly stage: HostFailureStageDTO };

const startupStageLabels: Readonly<Record<HostFailureStageDTO, string>> = {
  shell: "the desktop window",
  storage: "local storage",
  config: "your settings",
  plugins: "plugins",
  runtime: "providers",
};

function StartupShell(props: StartupShellProps) {
  if (props.status === "starting") {
    return (
      <main className="startup-shell">
        <header>
          <div>
            <small>CodexBar Multi</small>
            <h1>Starting CodexBar Multi…</h1>
          </div>
        </header>
        <p className="muted">Preparing your local data and providers. This can take a moment.</p>
      </main>
    );
  }
  return (
    <main className="startup-shell">
      <header>
        <div>
          <small>CodexBar Multi</small>
          <h1>CodexBar Multi couldn&apos;t finish starting</h1>
        </div>
      </header>
      <p className="error" role="alert">
        Startup stopped while preparing {startupStageLabels[props.stage]}. Close this window and
        open the app again.
      </p>
    </main>
  );
}

function HostGate() {
  const [hostStatus, setHostStatus] = useState<HostStatusDTO | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.codexbar.getHostStatus();
        if (cancelled) return;
        setHostStatus(next);
        if (next.status === "starting") {
          timer = window.setTimeout(() => {
            void poll();
          }, 250);
        }
      } catch {
        if (cancelled) return;
        timer = window.setTimeout(() => {
          void poll();
        }, 250);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);
  if (hostStatus === undefined || hostStatus.status === "starting") {
    return <StartupShell status="starting" />;
  }
  if (hostStatus.status === "failed") {
    return <StartupShell status="failed" stage={hostStatus.failure.stage} />;
  }
  if (hostStatus.status === "ready") {
    return <App />;
  }
  return <StartupShell status="starting" />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Renderer root is missing");
createRoot(root).render(
  <StrictMode>
    <HostGate />
  </StrictMode>,
);
