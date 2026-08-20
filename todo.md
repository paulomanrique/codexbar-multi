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
- [x] Port quota warnings, reset backfill/boundaries, and linear/workday pace behavior.
- [ ] Port full cost scanning, history retention, and config migration behavior.

## Milestone 2 — first vertical slice

- [x] Port the 16 first-party providers already distributed upstream as JS/TS.
- [x] Add the minimal Codex OAuth usage path and CLI credential discovery.
- [x] Add the OpenAI API and T3 Chat isolated-session paths.
- [x] Add the Electron main/preload/React shell with typed high-level IPC.
- [x] Add the first `codexbar-multi usage` CLI path.
- [x] Add native keyring-backed credentials with explicit failure and no plaintext fallback.
- [x] Integrate the dedicated SQLite worker with Electron main startup/shutdown.
- [x] Add bounded desktop history/cost query/export APIs and build overview from persisted snapshots.
- [ ] Wire provider refresh results into persisted overview/history records.
- [ ] Run native smoke tests on Windows, Linux, and macOS.

## Milestone 3 — core, persistence, CLI, and legacy import

- [x] Add the SQLite worker, migrations, concurrency, backup, lock, and failure tests.
- [ ] Complete retention/pruning policies and full crash/disk-full parity tests.
- [ ] Complete atomic config/history JSON persistence and migrations.
- [ ] Port adaptive refresh wiring, cache, status, redaction, and cancellation ownership.
- [ ] Implement all CLI commands, output formats, exit codes, and Node SEA artifacts.
- [ ] Implement opt-in legacy import, report, rollback, and secret-safe behavior.

## Milestone 4 — untrusted plugin runtime

- [x] Preserve QuickJS source/heap/stack/execution limits and TS transpilation.
- [x] Preserve manifest, approval binding, origin, auth, secret, and cookie-domain policy.
- [x] Add a transport-neutral host HTTP broker with redirect, size, and timeout limits.
- [ ] Connect the broker to QuickJS through an Electron utility-process adapter.
- [ ] Port the complete upstream plugin suite and process-recreation adversarial tests.

## Milestones 5–7 — remaining providers

- [ ] Complete and parity-test the simple HTTP provider wave.
- [ ] Port multi-call/signing providers.
- [ ] Port cookie/web providers using isolated Electron sessions plus manual fallback.
- [ ] Port local/CLI/OAuth-complex providers and their platform adapters.
- [ ] Require descriptor, strategy, config, fixtures, and parity state for every provider.

## Milestones 8–9 — desktop parity and final gate

- [ ] Port tray/settings/accounts/history/cost/notifications/autostart/shortcuts/privacy UI.
- [ ] Port all 23 languages, pluralization, RTL, and visual tests.
- [ ] Pass functional, security, persistence, cancellation, renderer, and provider gates.
- [ ] Remove Swift, SwiftPM, and CQuickJS from TypeScript `multi` only after parity.
- [ ] Add new TypeScript CI only after local parity gates pass.
- [ ] Keep release, publication, signing, notarization, and updater disabled pending approval.
