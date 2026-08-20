# CodexBar Multi TypeScript port

Baseline: CodexBar `453174fe13eebdf403cc0776268eb2b101fd9553` and T3 Code `24c4ba68f536d56e8482a1e4d7070a6771da551d`.

## Runtime boundaries

```text
contracts <- core <- providers
                 ^
                 |
      platform adapters (Node/Electron)
                 |
        desktop main / CLI
                 |
       typed DTO / preload IPC
                 |
          React renderer
```

`contracts`, `core`, and `providers` cannot import Electron, Node, Bun, or inspect the operating system. Capabilities such as HTTP, credentials, private files, processes, PTYs, browser sessions, paths, persistence, and time enter through small services. Only composition roots execute Effect programs.

The React renderer receives high-level DTOs through an explicit frozen preload API. It has no raw IPC, filesystem, process, cookie, token, or credential-store access. Browser windows use context isolation, sandboxing, disabled Node integration, a restrictive CSP, and denied popup/navigation defaults.

First-party providers are trusted TypeScript modules. Installed user providers remain untrusted and execute in QuickJS with the upstream security surface: a 1 MiB source/response budget, 64 MiB heap, 2 MiB JavaScript stack, 20 second execution deadline, declared origins/auth/secrets/capabilities/cookie domains, and approval bindings that invalidate on capability drift. A transport-neutral host broker enforces redirect, response-size, request-timeout, auth-header, cookie-domain, cancellation, and approval-drift policy. The Electron utility process is kill-and-recreate, serializes QuickJS work, preserves synchronous declared settings, bounds a per-plugin cache, and does not expose Node or Electron to the guest. Explicit, schema-validated IPC now supports list/install/approval-preview/approve/test/remove without exposing plugin paths or source back to the renderer; test results pass through the same bounded snapshot mapper before IPC. Plugin secrets have a write/clear-only keyring API and are cleared during removal. Snapshot persistence, browser-session composition, and removal of associated config/history remain pending.

## Upstream maintenance

- `upstream-swift` fast-forwards from `steipete/CodexBar` and remains an oracle branch.
- `multi` is the persistent TypeScript migration branch and receives every relevant milestone.
- `main`/`master` remains free to follow the original repository; the TypeScript rewrite is never merged there.
- `upstream/baseline.json` pins the last reviewed commits.
- `upstream/providers.yml`, `upstream/components.yml`, and `upstream/fixtures.manifest.json` keep semantic correspondence. The report verifies every bundled upstream JS/TS provider source is owned by its provider entry and reports affected components as well as providers.
- `pnpm upstream:report [ref]` classifies upstream changes by provider, auth, parser, config, cost/history, plugin runtime, fixture, and test.
- `pnpm upstream:accept <commit>` only advances the reviewed baseline after the full local gate succeeds.

Upstream workflows are preserved as inert reference material in `upstream-reference/github-workflows/`. No GitHub Actions workflow, updater, deployment, signing, or release is active.

## Current vertical slice

- Workspace, strict TypeScript configuration, Effect contracts/services, architecture gate, and oracle normalization.
- Closed 69-provider ID roster and a registry that makes unported entries explicit rather than silently omitting them.
- Executable TypeScript modules for 60 providers: the 16 already shipped upstream as JavaScript/TypeScript plugins, Codex's first OAuth slice, the complete first 14-provider HTTP wave, the Azure OpenAI/Gemini/Vertex AI, Bedrock/Copilot/MiniMax, and LiteLLM/ZenMux/Wayfinder cloud slices, plus all twenty cookie/web provider modules. They remain `partial`; the upstream matrix only advances individual providers after dedicated fixtures/tests and Swift-oracle comparison.
- A minimal Codex OAuth vertical slice with cross-platform `auth.json` discovery in the CLI composition root and shared `wham/usage` parsing.
- Swift-compatible UsageSnapshot wire codecs preserve stable null lanes, omission defaults, legacy identity keys, bounded details, ISO dates, and persisted provider enrichments.
- Shared quota warning, reset boundary/backfill, and linear/workday pace calculations are ported from the Swift decision tables.
- Node/platform adapters, native keyring credentials, normalized atomic config, SQLite WAL/migrations in a dedicated worker, a dedicated WAL reader outside the writer FIFO, bounded history/cost queries, persisted provider refresh, constant-size latest-snapshot overview reads, first CLI framework, Electron tray/popup shell, typed preload IPC, and React overview.
- The semantic provider matrix contains 50 `partial` entries with dedicated coverage growing provider-by-provider; no entry is called `parity` before its Swift fixtures, fallback rules, and native scenario pass.
- Opt-in data-only legacy import rescans bounded JSON/JSONL, disables imported hooks, copies plugins without approvals, journals rollback, and never imports credentials implicitly.

This is an implementation milestone, not feature parity. Entries remain `partial` until their Swift tests/fixtures and native smoke scenarios pass. Packaging scripts deliberately fail closed until the cross-platform parity gate is approved.
