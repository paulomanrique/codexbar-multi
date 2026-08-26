import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { TokenAccountRosterDTO } from "@codexbar/contracts";

import {
  TokenAccountSettings,
  type TokenAccountSettingsCopy,
  type TokenAccountSettingsProps,
} from "../src/renderer/token-account-settings.tsx";

const copy: TokenAccountSettingsCopy = {
  title: "Saved accounts",
  account: "Account",
  label: "Label",
  empty: "No saved accounts",
  apply: "Apply",
  refreshing: "Refreshing",
  remove: "Remove",
  add: "Add Account",
  cancel: "Cancel",
  source: "Source",
  manual: "Manual",
  browserSession: "Browser cookies",
  connected: "Connected",
  disconnected: "Disconnected",
  unavailable: "Unavailable",
  refreshSession: "Refresh Session",
  clearSession: "Clear",
};

const roster: TokenAccountRosterDTO = {
  provider: "openai",
  accounts: [
    {
      id: "account-1",
      label: "Personal",
      addedAt: 1,
      externalIdentifier: "person@example.test",
    },
  ],
  activeIndex: 0,
  selectionAvailable: true,
  revision: "a".repeat(64),
};

const baseProps = {
  roster,
  loading: false,
  pending: false,
  loginPending: false,
  error: undefined,
  copy,
  onSelect: () => undefined,
  onRename: () => undefined,
  onRemove: () => undefined,
} as const satisfies Omit<TokenAccountSettingsProps, "creation">;

describe("token account settings component", () => {
  it("renders metadata management without credential creation for creation none", () => {
    const markup = renderToStaticMarkup(
      <TokenAccountSettings {...baseProps} creation="none" selectionSetsCookieSource="manual" />,
    );

    expect(markup).toContain("Saved accounts");
    expect(markup).toContain("Personal");
    expect(markup).toContain("Source: Manual");
    expect(markup).toContain("Remove");
    expect(markup).not.toContain("Add Account");
    expect(markup).not.toContain(">Cancel<");
  });

  it("renders Add only for an idle codex-cli creation capability", () => {
    const markup = renderToStaticMarkup(
      <TokenAccountSettings
        {...baseProps}
        creation="codex-cli"
        onAdd={() => undefined}
        onCancelAdd={() => undefined}
      />,
    );

    expect(markup).toContain("Add Account");
    expect(markup).not.toContain(">Cancel<");
  });

  it("renders Cancel and disables roster mutations during codex-cli login", () => {
    const markup = renderToStaticMarkup(
      <TokenAccountSettings
        {...baseProps}
        creation="codex-cli"
        loginPending
        onAdd={() => undefined}
        onCancelAdd={() => undefined}
      />,
    );

    expect(markup).toContain(">Cancel<");
    expect(markup).not.toContain("Add Account");
    expect(markup).toMatch(/<select[^>]*disabled=""/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply<\/button>/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Remove<\/button>/u);
  });

  it("renders only metadata for the active Codex browser session", () => {
    const markup = renderToStaticMarkup(
      <TokenAccountSettings
        {...baseProps}
        roster={{ ...roster, provider: "codex" }}
        browserSession={{
          status: "persisted",
          pending: undefined,
          onStart: () => undefined,
          onCancel: () => undefined,
          onLogout: () => undefined,
        }}
        creation="none"
      />,
    );

    expect(markup).toContain("Browser cookies");
    expect(markup).toContain("Connected");
    expect(markup).not.toContain("Refresh Session");
    expect(markup).toContain("Clear");
    expect(markup).not.toMatch(/cookieHeader|credential|partition|secret/u);
  });

  it("offers cancellation while connecting and fails closed when status is unavailable", () => {
    const connecting = renderToStaticMarkup(
      <TokenAccountSettings
        {...baseProps}
        roster={{ ...roster, provider: "codex" }}
        browserSession={{
          status: "absent",
          pending: "start",
          onStart: () => undefined,
          onCancel: () => undefined,
          onLogout: () => undefined,
        }}
        creation="none"
      />,
    );
    expect(connecting).toContain(">Cancel<");
    expect(connecting).not.toContain("Refresh Session");

    const unavailable = renderToStaticMarkup(
      <TokenAccountSettings
        {...baseProps}
        roster={{ ...roster, provider: "codex" }}
        browserSession={{
          status: "unavailable",
          pending: undefined,
          onStart: () => undefined,
          onCancel: () => undefined,
          onLogout: () => undefined,
        }}
        creation="none"
      />,
    );
    expect(unavailable).toContain("Unavailable");
    expect(unavailable).toMatch(/<button[^>]*disabled=""[^>]*>Refresh Session<\/button>/u);
  });
});
