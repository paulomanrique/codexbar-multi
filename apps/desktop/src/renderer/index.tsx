import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CostUsageQueryResultDTO,
  DashboardProviderDTO,
  DashboardSnapshotDTO,
  HistoryQueryResultDTO,
} from "@codexbar/contracts";

import { createLocalization } from "./localization.ts";
import {
  costTotals,
  displayPercent,
  firstPartyProviderId,
  historySince,
  implementationPresentation,
  safeDateFromTimestamp,
} from "./view-model.ts";
import "./styles.css";

type DashboardTab = "usage" | "history" | "costs" | "settings";

const HISTORY_DAYS = 30;
const HISTORY_LIMIT = 100;
const DASHBOARD_TABS = ["usage", "history", "costs", "settings"] as const;

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
  locale,
  onSelect,
  onRefresh,
  copy,
}: {
  readonly provider: DashboardProviderDTO;
  readonly selected: boolean;
  readonly refreshing: boolean;
  readonly locale: string;
  readonly onSelect: () => void;
  readonly onRefresh: () => void;
  readonly copy: {
    readonly unavailable: string;
    readonly parityPending: string;
    readonly refresh: string;
    readonly refreshing: string;
    readonly disabled: string;
    readonly usageUsed: string;
    readonly usageRemaining: string;
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
  copy,
}: {
  readonly provider: DashboardProviderDTO;
  readonly copy: {
    readonly enabled: string;
    readonly disabled: string;
    readonly settings: string;
    readonly provider: string;
    readonly source: string;
    readonly unavailable: string;
    readonly parityPending: string;
  };
}) {
  return (
    <>
      <h2>{copy.settings}</h2>
      <label className="settings-toggle">
        <input checked={provider.enabled} disabled type="checkbox" />
        <span>{provider.enabled ? copy.enabled : copy.disabled}</span>
      </label>
      <p className="muted">
        Provider enablement is read-only in this desktop slice. A settings IPC is required before it
        can be changed safely.
      </p>
      <dl className="settings-summary">
        <div>
          <dt>{copy.provider}</dt>
          <dd>{provider.name}</dd>
        </div>
        <div>
          <dt>{copy.source}</dt>
          <dd>{provider.source}</dd>
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

function App() {
  const localization = useMemo(() => createLocalization("system", navigator.languages), []);
  const [snapshot, setSnapshot] = useState<DashboardSnapshotDTO>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<DashboardTab>("usage");
  const [selectedProviderId, setSelectedProviderId] = useState<string>();
  const [providerSearch, setProviderSearch] = useState("");
  const [refreshingProviderId, setRefreshingProviderId] = useState<string>();
  const [history, setHistory] = useState<HistoryQueryResultDTO>();
  const [costs, setCosts] = useState<CostUsageQueryResultDTO>();
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string>();
  const [activityVersion, setActivityVersion] = useState(0);
  const [t3Status, setT3Status] = useState<"idle" | "waiting" | "connected">("idle");
  const selectedProvider = snapshot?.providers.find(
    (provider) => provider.id === selectedProviderId,
  );
  const selectedProviderFirstPartyId =
    selectedProvider === undefined ? undefined : firstPartyProviderId(selectedProvider.id);
  const filteredProviders =
    snapshot?.providers.filter((provider) => {
      const query = providerSearch.trim().toLocaleLowerCase(localization.locale);
      return (
        query.length === 0 ||
        provider.name.toLocaleLowerCase(localization.locale).includes(query) ||
        provider.id.toLocaleLowerCase(localization.locale).includes(query)
      );
    }) ?? [];
  const loadOverview = async (): Promise<void> => {
    try {
      const overview = await window.codexbar.getOverview();
      setSnapshot(overview);
      setSelectedProviderId((current) => current ?? overview.providers[0]?.id);
      setError(undefined);
    } catch {
      setError(localization.upstream("Unavailable"));
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
    void loadOverview();
  }, []);
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
  const partialCount = snapshot?.providers.filter(
    (provider) => implementationPresentation(provider) === "parity-pending",
  ).length;
  const copy = {
    unavailable: localization.upstream("Unavailable"),
    parityPending: localization.t("awaitingParity"),
    refresh: localization.upstream("Refresh"),
    refreshing: localization.upstream("Refreshing"),
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
          disabled={t3Status === "waiting"}
          onClick={() => {
            setT3Status("waiting");
            window.codexbar.startLogin({ provider: "t3chat", accountId: "default" }).then(
              (result) => setT3Status(result.status === "connected" ? "connected" : "idle"),
              () => {
                setError(copy.unavailable);
                setT3Status("idle");
              },
            );
          }}
        >
          {t3Status === "waiting"
            ? localization.t("loginWaiting")
            : t3Status === "connected"
              ? localization.t("loginConnected")
              : localization.t("loginStart")}
        </button>
        {t3Status === "connected" ? (
          <button
            className="secondary"
            onClick={() => {
              void window.codexbar.logout({ provider: "t3chat", accountId: "default" }).then(
                () => setT3Status("idle"),
                () => setError(copy.unavailable),
              );
            }}
          >
            {localization.t("logout")}
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
        {selectedProvider === undefined ? (
          <p className="muted">{copy.noUsageYet}</p>
        ) : (
          <SettingsPanel provider={selectedProvider} copy={copy} />
        )}
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
              selected={selectedProvider?.id === provider.id}
              onRefresh={() => refreshProvider(provider)}
              onSelect={() => setSelectedProviderId(provider.id)}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Renderer root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
