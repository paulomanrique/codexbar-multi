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

First-party providers are trusted TypeScript modules. Installed user providers remain untrusted and execute in QuickJS with the upstream security surface: a 1 MiB source/response budget, 64 MiB heap, 2 MiB JavaScript stack, 20 second execution deadline, declared origins/auth/secrets/capabilities/cookie domains, and approval bindings that invalidate on capability drift. A transport-neutral host broker enforces redirect, response-size, request-timeout, auth-header, cookie-domain, cancellation, and approval-drift policy. The Electron utility process is kill-and-recreate, serializes QuickJS work, preserves synchronous declared settings, bounds a per-plugin cache, and does not expose Node or Electron to the guest. Explicit, schema-validated IPC now supports list/install/approval-preview/approve/test/remove without exposing plugin paths or source back to the renderer; test results pass through the same bounded snapshot mapper before IPC. Plugin secrets have a write/clear-only keyring API and are cleared during removal. Plugin snapshots are schema-validated before persistence, browser sessions are credential-scoped, and removal clears the plugin config, snapshot, history, secrets, and current or prior approved cookie domains before deleting its source/approval. The normal Node CLI and host-native SEA artifact now use the same approval/broker model in a disposable QuickJS child, accept plugin secrets only through bounded non-TTY stdin, and read only credential-bound cookie headers previously exported by the desktop. The SEA builder embeds a single-file ESM child as a digest-bound asset, extracts it into the private per-user cache, and smoke-tests install, approval, execution, and removal without requiring an external Node runtime.

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
- TypeScript domain modules and executable first-party strategies now exist for all 69 provider IDs. Amp, Kiro, and JetBrains use a narrow platform-owned process/private-data broker; Grok uses the real bounded gRPC-web billing transport. Every entry remains `partial`; the upstream matrix only advances individual providers after dedicated fixtures/tests and Swift-oracle comparison.
- A minimal Codex OAuth vertical slice with cross-platform `auth.json` discovery in the CLI composition root and shared `wham/usage` parsing.
- Swift-compatible UsageSnapshot wire codecs preserve stable null lanes, omission defaults, legacy identity keys, bounded details, ISO dates, and persisted provider enrichments.
- A fixed-operation Swift oracle runs prebuilt Swift code with a scrubbed environment, bounded output and no network/credential capability. Real macOS runs currently accept snapshot serialization and the Qwen Cloud flat-subscription fixture; the latter corrected the TypeScript legacy label to the upstream `TOKEN PLAN` spelling.
- Shared quota warning, reset boundary/backfill, and linear/workday pace calculations are ported from the Swift decision tables.
- Node/platform adapters, native keyring credentials, normalized atomic config, SQLite WAL/migrations in a dedicated worker, a dedicated WAL reader outside the writer FIFO, bounded history/cost queries, persisted provider refresh, constant-size latest-snapshot overview reads, first CLI framework, Electron tray/popup shell, typed preload IPC, and React overview. xAI daily vendor spend now uses an atomic source-scoped ledger replacement and publishes only safe exact/estimated coverage metadata; Kiro enriches its CLI-authoritative report from the fixed `GetUsageLimits` API while retaining tokens inside the platform adapter.
- The semantic provider matrix contains all 69 provider IDs as `partial`, with dedicated contract coverage and parser/fixture coverage growing provider-by-provider; no entry is called `parity` before its Swift fixtures, fallback rules, and native scenario pass.
- Opt-in data-only legacy import rescans bounded JSON/JSONL, disables imported hooks, copies plugins without approvals, journals rollback, and never imports credentials implicitly.
- The renderer now resolves all 23 upstream locale IDs, regional/script fallbacks, plurals, and RTL direction for its current message surface; the full upstream string catalog remains a tracked parity gap.

This is an implementation milestone, not feature parity. Entries remain `partial` until their Swift tests/fixtures and native smoke scenarios pass. `pnpm build:cli:artifact` builds and smoke-tests a host-native Node 24.13.1 SEA executable only: it embeds CommonJS plus a SHA-256-verified `@napi-rs/keyring` addon that is atomically extracted into a private per-user cache before startup. `pnpm build:desktop:artifact` likewise packages only the current host/architecture and verifies the asar, unpacked executable, and native keyring module; host-native gates now produce a tested Linux AppImage and Windows x64 NSIS installer, while DMG and remaining architectures are still pending. Neither path cross-compiles, archives, publishes, signs, or enables release packaging. macOS CLI SEA fails closed before producing an artifact because postject invalidates the executable signature; a build-only ad-hoc `codesign` step must be implemented and validated before macOS smoke tests are allowed. The full target matrix remains gated.
