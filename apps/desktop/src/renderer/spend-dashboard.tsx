import type { CSSProperties } from "react";
import type { SpendDashboardDTO, SpendOverviewDTO } from "@codexbar/contracts";

import { spendPresentation } from "./spend-view-model.ts";

const formatNumber = (locale: string, value: number): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
const formatUsd = (locale: string, value: number): string =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
const formatDay = (locale: string, value: string): string => {
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(
        date,
      )
    : value;
};

export interface SpendCopy {
  readonly title: string;
  readonly description: string;
  readonly refresh: string;
  readonly refreshing: string;
  readonly unavailable: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly estimatedSpend: string;
  readonly trackedTokens: string;
  readonly subscriptions: string;
  readonly coverage: string;
  readonly input: string;
  readonly output: string;
  readonly bySubscription: string;
  readonly dailyEstimatedSpend: string;
  readonly stale: string;
  readonly partial: string;
}

export function SpendDashboard({
  overview,
  dashboard,
  loading,
  error,
  locale,
  copy,
  onRefresh,
}: {
  readonly overview: SpendOverviewDTO | undefined;
  readonly dashboard: SpendDashboardDTO | undefined;
  readonly loading: boolean;
  readonly error: boolean;
  readonly locale: string;
  readonly copy: SpendCopy;
  readonly onRefresh: () => void;
}) {
  const presentation = spendPresentation(overview, dashboard, loading, error);
  const maxDailyCost = Math.max(...presentation.dailySeries.map((point) => point.costUsd), 0);
  const sourceIssueCount =
    presentation.unavailableSourceCount +
    presentation.loadingSourceCount +
    presentation.estimatedSourceCount;

  return (
    <div className="spend-dashboard">
      <div className="spend-header">
        <div>
          <h2>{copy.title}</h2>
          <p className="muted">{copy.description}</p>
        </div>
        <button className="secondary compact" disabled={loading} onClick={onRefresh}>
          {loading ? copy.refreshing : copy.refresh}
        </button>
      </div>
      {presentation.state === "loading" ? <p className="muted">{copy.refreshing}</p> : null}
      {presentation.state === "error" ? (
        <p className="error" role="alert">
          {copy.unavailable}
        </p>
      ) : null}
      {presentation.staleSourceCount > 0 ? (
        <p className="spend-notice" role="status">
          {`${presentation.staleSourceCount} · ${copy.stale}`}
        </p>
      ) : null}
      {sourceIssueCount > 0 ? (
        <p className="spend-notice" role="status">
          {`${sourceIssueCount} · ${copy.partial}`}
        </p>
      ) : null}
      {presentation.state === "empty" ? (
        <div className="spend-empty">
          <strong>{copy.emptyTitle}</strong>
          <p className="muted">{copy.emptyDescription}</p>
        </div>
      ) : null}
      {presentation.state !== "ready" || presentation.overview === undefined ? null : (
        <>
          <dl className="spend-summary">
            <div>
              <dt>{copy.estimatedSpend}</dt>
              <dd>{formatUsd(locale, presentation.overview.totals.costUsd)}</dd>
            </div>
            <div>
              <dt>{copy.trackedTokens}</dt>
              <dd>{formatNumber(locale, presentation.overview.totals.totalTokens)}</dd>
            </div>
            <div>
              <dt>{copy.subscriptions}</dt>
              <dd>{formatNumber(locale, presentation.overview.totals.sourceCount)}</dd>
            </div>
            <div>
              <dt>{copy.coverage}</dt>
              <dd>{`${formatNumber(locale, presentation.overview.totals.coveredDayCount)} / ${formatNumber(locale, dashboard?.requestedDays ?? 0)}`}</dd>
            </div>
            <div>
              <dt>{copy.input}</dt>
              <dd>{formatNumber(locale, presentation.overview.totals.inputTokens)}</dd>
            </div>
            <div>
              <dt>{copy.output}</dt>
              <dd>{formatNumber(locale, presentation.overview.totals.outputTokens)}</dd>
            </div>
          </dl>
          <section className="spend-section" aria-labelledby="spend-providers-title">
            <h3 id="spend-providers-title">{copy.bySubscription}</h3>
            <ol className="spend-provider-list">
              {presentation.overview.providers.map((provider) => (
                <li key={provider.provider}>
                  <span>{provider.displayName}</span>
                  <span>{`${formatUsd(locale, provider.totals.costUsd)} · ${formatNumber(locale, provider.totals.totalTokens)}`}</span>
                </li>
              ))}
            </ol>
          </section>
          <section className="spend-section" aria-labelledby="spend-daily-title">
            <h3 id="spend-daily-title">{copy.dailyEstimatedSpend}</h3>
            {presentation.dailySeries.length === 0 ? (
              <p className="muted">{copy.unavailable}</p>
            ) : (
              <figure className="spend-chart" aria-labelledby="spend-daily-title">
                <ol>
                  {presentation.dailySeries.map((point) => {
                    const height = maxDailyCost === 0 ? 0 : (point.costUsd / maxDailyCost) * 100;
                    const label = `${formatDay(locale, point.day)}: ${formatUsd(locale, point.costUsd)}`;
                    return (
                      <li key={point.day} aria-label={label} title={label}>
                        <span
                          aria-hidden="true"
                          className="spend-bar"
                          style={{ "--spend-height": `${height}%` } as CSSProperties}
                        />
                        <span aria-hidden="true">{formatDay(locale, point.day)}</span>
                      </li>
                    );
                  })}
                </ol>
                <figcaption className="muted">
                  {formatUsd(locale, presentation.overview.totals.costUsd)}
                </figcaption>
              </figure>
            )}
          </section>
        </>
      )}
    </div>
  );
}
