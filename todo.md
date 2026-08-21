# CodexBar Multi migration tracker

Implementation checklist for the [published migration plan](https://plans.paulo.dev/p/port-completo-do-codexbar-para-typescript-electr-e4f0031f).
The states below describe the TypeScript `multi` branch; Swift remains the oracle on
`upstream-swift` until the final parity gate.

## Milestone 0 — fork and baseline

- [x] Configure `origin`, `upstream`, and the fast-forward-only `upstream-swift` branch.
- [x] Pin the CodexBar and T3 Code baseline commits.
- [x] Disable executable upstream workflows and preserve them as inert references.
- [x] Inventory all 69 provider IDs and the initial component/test/fixture mappings.
- [x] Add semantic upstream report and guarded baseline acceptance scripts.

## Milestone 1 — workspace and contracts

- [x] Create the pnpm/TypeScript workspace and strict architecture gate.
- [x] Add Effect schemas for provider IDs, snapshots, errors, config, and IPC DTOs.
- [x] Add platform-independent core capabilities and classified fetch/fallback pipeline.
- [x] Add canonical fixture normalization and a bounded Swift-oracle runner.
- [x] Port the adaptive refresh decision table and its Swift boundary cases.
- [x] Complete snapshot serialization parity against the checked-in Swift golden and preserve legacy identity keys.
- [x] Execute the bounded Swift oracle offline and accept real snapshot/Qwen fixture parity.
- [x] Port quota warnings, reset backfill/boundaries, and linear/workday pace behavior.
- [x] Port config decoding, normalization, validation, legacy-value migration, and atomic persistence.
- [ ] Port full cost scanning and history retention behavior.
  - [x] Add atomic SQLite pruning for history and cost rows with worker coverage.
  - [x] Add bounded incremental Codex/Claude JSONL scanners with resumable cursors, source-identity checks, provenance, and fail-closed counter regressions.
  - [ ] Complete recursive log inventory, fork lineage/issue #2037, priority metadata, scanner checkpoints/cache, and atomic cursor-plus-row persistence parity.

## Milestone 2 — first vertical slice

- [x] Port the 16 first-party providers already distributed upstream as JS/TS.
- [x] Add the minimal Codex OAuth usage path and CLI credential discovery.
- [x] Add the OpenAI API and T3 Chat isolated-session paths.
- [x] Add the Electron main/preload/React shell with typed high-level IPC.
- [x] Add the first `codexbar-multi usage` CLI path.
- [x] Add native keyring-backed credentials with explicit failure and no plaintext fallback.
- [x] Integrate the dedicated SQLite worker with Electron main startup/shutdown.
- [x] Add bounded desktop history/cost query/export APIs and build overview from persisted snapshots.
- [x] Wire provider refresh results into persisted overview/history records.
- [x] Keep overview enablement/source separate from TypeScript implementation status.
- [ ] Run native smoke tests on Windows, Linux, and macOS.
  - [x] Linux Electron and packaged-main smoke under isolated profiles.
  - [x] Windows x64 Node SEA build plus plugin install/approve/execute/remove smoke.
  - [x] Windows x64 Electron/NSIS host-native build with asar, unpacked executable, and native keyring verification.

## Milestone 3 — core, persistence, CLI, and legacy import

- [x] Add the SQLite worker, migrations, concurrency, backup, lock, and failure tests.
- [x] Keep WAL readers outside the serialized writer queue and retry contended writers cooperatively.
- [ ] Complete retention/pruning policies and full crash/disk-full parity tests.
- [x] Complete atomic config persistence and migrations.
- [ ] Complete history JSON compatibility where SQLite parity does not apply.
- [ ] Port adaptive refresh wiring, cache, status, redaction, and cancellation ownership.
- [ ] Implement all CLI commands, output formats, exit codes, and Node SEA artifacts.
  - [x] Add usage, providers, cost, cards, dashboard, diagnose, cache, config, guard, hooks, sessions, cookie, plugins, and bounded serve command surfaces.
  - [x] Connect the normal Node CLI to the sandboxed plugin lifecycle, native keyring, stdin-only secrets, and desktop-exported cookie credentials.
  - [x] Embed and verify the disposable QuickJS plugin child in the host-native SEA artifact.
  - [x] Port the serve Web UI, icon assets, progressive fill, cache/SWR, and cancellation behavior.
  - [ ] Produce the remaining Node SEA target matrix.
  - [x] Produce a host-native Node SEA CLI executable with a verified extracted keyring addon; cross-compilation and release archives remain disabled.
- [x] Implement the data-only opt-in legacy import, report, rollback, no-clobber writes, and secret-safe behavior.
- [x] Connect the explicit inspect/execute/rollback legacy import CLI with opt-in and mutation confirmation.
- [ ] Connect legacy import UI and a separately-approved native credential migration.

## Milestone 4 — untrusted plugin runtime

- [x] Preserve QuickJS source/heap/stack/execution limits and TS transpilation.
- [x] Preserve manifest, approval binding, origin, auth, secret, and cookie-domain policy.
- [x] Add a transport-neutral host HTTP broker with redirect, size, and timeout limits.
- [x] Connect the broker to QuickJS through a disposable Electron utility-process adapter.
- [x] Cover process recreation, CPU/memory/output limits, approval drift, capability isolation, cache, sync settings, and IANA/DST behavior.
- [x] Connect schema-validated list/install/approval-preview/approve/test/remove IPC without exposing paths or source to the renderer.
- [x] Validate plugin test snapshots with the bounded upstream-compatible mapper before IPC.
- [x] Add write/clear-only keyring IPC for declared plugin secrets and clear them during removal.
- [x] Persist plugin snapshots, compose browser sessions, and remove associated config/history.
- [ ] Port the complete upstream plugin suite.
  - [x] Add deterministic manifest/transpilation, snapshot, context, broker-policy, protocol, and QuickJS heap parity fixtures.

## Milestones 5–7 — remaining providers

- [x] Port the complete 14-provider simple HTTP wave with dedicated TypeScript tests.
- [ ] Finish Swift-oracle/native parity gates for the simple HTTP wave.
- [ ] Port multi-call/signing providers (Azure OpenAI, Gemini, Vertex AI, Bedrock, Copilot, MiniMax, LiteLLM, ZenMux, and Wayfinder are partial).
- [x] Port all 20 cookie/web provider domain modules with isolated-session/manual credential contracts; complete adapter/native parity remains gated separately.
- [ ] Complete local/CLI/OAuth parity; all provider IDs now have executable strategies, while Grok OAuth/CLI RPC and the remaining native discovery/login adapters still require parity work.
- [ ] Require descriptor, strategy, config, fixtures, and parity state for every provider.

## Milestones 8–9 — desktop parity and final gate

- [ ] Port tray/settings/accounts/history/cost/notifications/autostart/shortcuts/privacy UI.
  - [x] Add accessible provider cards, explicit refresh, persisted history/cost views, and an honest read-only settings shell.
  - [x] Add schema-validated provider enablement/source mutations with serialized atomic persistence.
  - [ ] Add account mutations, full dashboards, tray parity, notifications, autostart, shortcuts, and privacy controls.
- [ ] Port all 23 languages, pluralization, RTL, and visual tests.
  - [x] Establish the 23-locale catalog, current renderer messages, plural rules, and RTL direction.
  - [x] Import the complete upstream `.strings`/`.stringsdict` catalogs with deterministic regeneration and English fallback.
  - [ ] Apply the full catalog throughout the parity UI and complete locale/RTL visual tests.
- [ ] Pass functional, security, persistence, cancellation, renderer, and provider gates.
- [x] Add a pinned, host-native desktop artifact builder with AppImage smoke and declared NSIS/DMG targets; cross-build, signing and publication remain disabled.
- [ ] Remove Swift, SwiftPM, and CQuickJS from TypeScript `multi` only after parity.
- [ ] Add new TypeScript CI only after local parity gates pass.
- [ ] Keep release, publication, signing, notarization, and updater disabled pending approval.
