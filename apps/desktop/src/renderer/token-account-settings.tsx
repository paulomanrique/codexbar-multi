import { useEffect, useState } from "react";
import type { CodexBrowserSessionStatusDTO, TokenAccountRosterDTO } from "@codexbar/contracts";

import {
  tokenAccountDetail,
  tokenAccountLabel,
  tokenAccountSelectionViewState,
} from "./settings-view-model.ts";

export interface TokenAccountSettingsCopy {
  readonly title: string;
  readonly account: string;
  readonly label: string;
  readonly empty: string;
  readonly apply: string;
  readonly refreshing: string;
  readonly remove: string;
  readonly add: string;
  readonly cancel: string;
  readonly source: string;
  readonly manual: string;
  readonly browserSession: string;
  readonly connected: string;
  readonly disconnected: string;
  readonly unavailable: string;
  readonly refreshSession: string;
  readonly clearSession: string;
}

export interface CodexBrowserSessionControls {
  readonly status: CodexBrowserSessionStatusDTO["status"] | undefined;
  readonly pending: "start" | "cancel" | "logout" | undefined;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  readonly onLogout: () => void;
}

interface TokenAccountSettingsBaseProps {
  readonly roster: TokenAccountRosterDTO | undefined;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly loginPending: boolean;
  readonly error: string | undefined;
  readonly copy: TokenAccountSettingsCopy;
  readonly selectionSetsCookieSource?: "manual";
  readonly onSelect: (accountId: string) => void;
  readonly onRename: (accountId: string, label: string) => void;
  readonly onRemove: (accountId: string) => void;
  readonly browserSession?: CodexBrowserSessionControls;
}

export type TokenAccountSettingsProps = TokenAccountSettingsBaseProps &
  (
    | { readonly creation: "none" }
    | {
        readonly creation: "codex-cli";
        readonly onAdd: () => void;
        readonly onCancelAdd: () => void;
      }
  );

/** Metadata-only account controls; credential creation remains an optional host capability. */
export function TokenAccountSettings(props: TokenAccountSettingsProps) {
  const {
    roster,
    loading,
    pending,
    loginPending,
    error,
    copy,
    selectionSetsCookieSource,
    onSelect,
    onRename,
    onRemove,
    browserSession,
  } = props;
  const state = tokenAccountSelectionViewState(
    roster,
    loading,
    pending || loginPending || browserSession?.pending !== undefined,
    error,
  );
  const statusId = "provider-token-account-status";
  const [draftLabel, setDraftLabel] = useState("");
  const activeLabel = state.active?.label.trim() ?? "";
  const trimmedDraftLabel = draftLabel.trim();
  const renameDisabled =
    state.disabled ||
    state.active === undefined ||
    trimmedDraftLabel.length === 0 ||
    trimmedDraftLabel.length > 256 ||
    trimmedDraftLabel === activeLabel;
  useEffect(() => {
    setDraftLabel(activeLabel);
  }, [activeLabel, state.activeId]);
  return (
    <section className="settings-token-accounts" aria-labelledby="provider-token-account-heading">
      <h3 id="provider-token-account-heading">{copy.title}</h3>
      {selectionSetsCookieSource === "manual" && state.active !== undefined ? (
        <p className="muted token-account-source">
          {copy.source}: {copy.manual}
        </p>
      ) : null}
      {roster !== undefined && roster.accounts.length > 0 ? (
        <label className="settings-token-account">
          <span>{copy.account}</span>
          <select
            aria-describedby={state.status === "ready" ? undefined : statusId}
            aria-label={copy.account}
            disabled={state.disabled}
            value={state.activeId}
            onChange={(event) => {
              if (event.target.value === state.activeId) return;
              onSelect(event.target.value);
            }}
          >
            {roster.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {tokenAccountLabel(account, copy.account)}
              </option>
            ))}
          </select>
          {tokenAccountDetail(state.active) === undefined ? null : (
            <small className="token-account-detail">{tokenAccountDetail(state.active)}</small>
          )}
        </label>
      ) : null}
      {state.active === undefined ? null : (
        <form
          className="settings-token-account-rename"
          onSubmit={(event) => {
            event.preventDefault();
            if (renameDisabled || state.active === undefined) return;
            onRename(state.active.id, trimmedDraftLabel);
          }}
        >
          <label>
            <span>{copy.label}</span>
            <input
              aria-describedby={state.status === "ready" ? undefined : statusId}
              aria-label={copy.label}
              autoComplete="off"
              disabled={state.disabled}
              maxLength={256}
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.target.value)}
            />
          </label>
          <button className="secondary" disabled={renameDisabled} type="submit">
            {copy.apply}
          </button>
          <button
            className="secondary danger"
            disabled={state.disabled}
            type="button"
            onClick={() => {
              if (state.active !== undefined) onRemove(state.active.id);
            }}
          >
            {copy.remove}
          </button>
        </form>
      )}
      {state.active === undefined || browserSession === undefined ? null : (
        <div className="settings-browser-session">
          <div>
            <strong>{copy.browserSession}</strong>
            <span
              className={`browser-session-state browser-session-state-${browserSession.status ?? "loading"}`}
              role="status"
            >
              {browserSession.status === "persisted"
                ? copy.connected
                : browserSession.status === "absent"
                  ? copy.disconnected
                  : browserSession.status === "unavailable"
                    ? copy.unavailable
                    : copy.refreshing}
            </span>
          </div>
          <div className="settings-token-account-actions">
            {browserSession.pending === "start" ? (
              <button
                className="secondary"
                aria-label={`${copy.cancel}: ${copy.browserSession}`}
                type="button"
                onClick={browserSession.onCancel}
              >
                {copy.cancel}
              </button>
            ) : browserSession.status === "persisted" ? null : (
              <button
                className="secondary"
                aria-label={`${copy.refreshSession}: ${copy.browserSession}`}
                disabled={
                  state.disabled ||
                  browserSession.status === undefined ||
                  browserSession.status === "unavailable"
                }
                type="button"
                onClick={browserSession.onStart}
              >
                {copy.refreshSession}
              </button>
            )}
            {browserSession.status === "persisted" ? (
              <button
                className="secondary danger"
                aria-label={`${copy.clearSession}: ${copy.browserSession}`}
                disabled={state.disabled}
                type="button"
                onClick={browserSession.onLogout}
              >
                {copy.clearSession}
              </button>
            ) : null}
          </div>
        </div>
      )}
      {props.creation === "none" ? null : (
        <div className="settings-token-account-actions">
          {loginPending ? (
            <button className="secondary" type="button" onClick={props.onCancelAdd}>
              {copy.cancel}
            </button>
          ) : (
            <button
              className="secondary"
              disabled={state.disabled}
              type="button"
              onClick={props.onAdd}
            >
              {copy.add}
            </button>
          )}
        </div>
      )}
      {state.status === "loading" || state.status === "pending" ? (
        <p className="muted" id={statusId}>
          {copy.refreshing}
        </p>
      ) : null}
      {state.status === "empty" ? (
        <p className="muted" id={statusId}>
          {copy.empty}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="error" id={statusId} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
