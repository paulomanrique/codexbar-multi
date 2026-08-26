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
  - [x] Persist xAI vendor-metered daily spend with atomic range replacement, exact/estimated coverage, confirmed-empty handling, and unavailable-source retention.
  - [x] Commit each local scanner cursor and its rows in one SQLite transaction, with checkpoint CAS across concurrent desktop/CLI processes and source-scoped reset.
  - [x] Connect bounded recursive Codex/Claude inventory to `cost --refresh`, with SIGINT/SIGTERM cancellation and explicit partial-coverage output.
  - [x] Reconcile Codex fork lineage/issue #2037 through one CAS-protected atomic family commit.
  - [x] Complete issue #2037 priority metadata and scanner cache parity; durable per-tier/model breakdown remains a schema migration.

## Milestone 2 — first vertical slice

- [x] Port the 16 first-party providers already distributed upstream as JS/TS.
- [x] Add the minimal Codex OAuth usage path and CLI credential discovery.
- [x] Add the OpenAI API and T3 Chat isolated-session paths.
- [x] Add the Electron main/preload/React shell with typed high-level IPC.
- [x] Add the first `codexbar-multi usage` CLI path.
- [x] Add native keyring-backed credentials with explicit failure and no plaintext fallback.
- [ ] Migrate legacy inline token-account payloads to the native credential store, retaining only account IDs and metadata in config.
  - [x] Add v1/v2 config compatibility, v1 plaintext-to-vault migration, v2 save enforcement, and selected-account vault resolution for Claude, Grok, and Antigravity.
  - [x] Serialize automatic migration across concurrent desktop/CLI processes with a Node SQLite mutex, lock-scoped reload, follower no-write path, and synthetic adapter/wrapper tests.
  - [x] Add metadata-only account listing plus revision-checked selection IPC, and route every desktop/CLI config writer through the shared cross-process modify primitive.
  - [x] Complete selected-account runtime mapping before enabling selection beyond Grok and Antigravity.
    - [x] Add Claude Admin API and organization-aware selected-account routing; keep remaining Claude parity scoped as partial.
    - [x] Add z.ai personal/team selected-account mapping with explicit ambient team-context scrub.
    - [x] Add Copilot selected-account mapping and keep managed OAuth auth off cookie budget pages.
    - [x] Add DeepInfra selected API-key mapping with terminal source routing and ambient-alias isolation.
    - [x] Add Groq selected API-key mapping while preserving the validated global metrics endpoint; console/web parity remains pending.
    - [x] Add Venice selected API-key mapping with canonical/legacy alias parity and classified provider errors.
    - [x] Add ElevenLabs selected API-key mapping with XI alias isolation and secure endpoint overrides.
    - [x] Add IBM Bob selected token mapping while preserving JWT/API-key authorization and regional host boundaries.
    - [x] Add Neuralwatt selected API-key mapping, secure endpoint overrides, and exact quota/error parsing.
    - [x] Add sub2api selected group-key mapping with validated global instance URLs and plugin parser parity.
    - [x] Add LLM Proxy selected API-key mapping with private-network endpoint parity.
    - [x] Add DeepSeek selected API-key mapping without cross-account platform-session enrichment.
    - [x] Add LiteLLM selected virtual-key mapping while preserving its validated global proxy URL.
    - [x] Normalize OpenAI Admin/legacy key precedence, project scope, and billing fallback policy.
    - [x] Add OpenAI selected Admin-key mapping with legacy-key and project-scope isolation.
    - [x] Add OpenRouter selected API-key mapping while preserving global management and client settings.
    - [x] Add selected cookie-account isolation for Abacus, Augment, Cursor, and Mistral.
    - [x] Add selected OpenCode cookie isolation with exact auth-cookie filtering.
    - [x] Add selected OpenCode Go web-account isolation and cancel-safe optional billing.
    - [x] Add selected Manus session isolation and exact session_id-to-Bearer normalization.
    - [x] Add selected StepFun Oasis token isolation and Swift-compatible cookie normalization.
    - [x] Add selected Ollama session isolation, full session-cookie normalization, and distinct web/API strategies.
    - [x] Add selected Factory Cookie/Bearer isolation with Swift-compatible manual credential parsing.
    - [x] Add selected Qoder cookie isolation with strict international/China host routing.
    - [x] Make the OpenRouter spend-history UI provenance explicit when it uses the independently global management key.
    - [x] Add descriptor-driven MiniMax Cookie/Bearer/Group ID mappers with selected-account scrub/source rules and bounded HTML-first usage parsing.
    - [x] Expose capability-driven metadata-only list/select/rename/remove UI for all 30 runtime-mapped providers; communicate host-owned manual-routing side effects, cancel Codex login on navigation, reconcile navigation races, and keep credential creation host-owned and Codex-only.
  - [ ] Add account CRUD/UI and full Codex selected-home/web semantics.
    - [x] Add fail-closed selected Codex `auth.json`/PAT credential mapping with ambient credential suppression and no refresh-token exposure.
    - [x] Share exact `CODEX_HOME` resolution between Codex credential discovery and local cost roots.
    - [x] Recover selected Codex account IDs from direct, namespaced, and organization JWT claims without exposing ID/refresh tokens.
    - [x] Match Swift `auth.json` API-key precedence for ambient and selected Codex credentials.
    - [x] Expose metadata-only Codex account selection in React with host revisions, optimistic rollback, and no renderer credential surface.
    - [x] Add metadata-only Codex account rename with trimmed labels, revision CAS, duplicate-label parity, and no credential mutation.
    - [x] Add Codex account removal with Swift active-row semantics, revision CAS, typed config tombstones, keyring readback verification, and crash recovery.
    - [ ] Add host-owned Codex account creation/login without credential material crossing renderer IPC.
      - [x] Add the isolated `codex login` host primitive plus marker-first vault publication and crash recovery.
      - [x] Wire the dedicated desktop controller, typed IPC/preload API, and cancellation without renderer credential material.
      - [x] Add the localized React account action with explicit start/cancel states.
      - [ ] Complete a live Windows smoke for `codex login` with a native Codex CLI installation.
  - [ ] Migrate other plaintext provider config secrets (`apiKey`, `secretKey`, `cookieHeader`, `pluginSecrets`) under separate milestones.
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
  - [x] Prove transactional retention rollback and same-connection/worker recovery after a write failure and in read-only mode.
  - [x] Prove genuine SQLite result code 13 recovery in the direct writer and data-only worker using a deterministic capacity cap.
  - [ ] Add a platform filesystem harness for a physical `SQLITE_FULL` failure.
- [x] Complete atomic config persistence and migrations.
- [ ] Complete history JSON compatibility where SQLite parity does not apply.
  - [x] Port the per-provider schema-v1 codec, ISO8601 behavior, sorting, sanitization, accounts, and identity buckets.
  - [x] Persist/load the provider JSON files through a bounded, no-follow private platform adapter.
  - [x] Port hourly peak/reset-segment coalescing, canonical window folding, and two-year sample retention.
  - [x] Add a load-before-mutate Effect coordinator with account-scoped selection and serialized publication.
  - [x] Port provider lane projection plus generic 5h/weekly source-identity reconciliation.
  - [x] Connect the always-tracked generic OpenCode Go history to desktop and CLI consumers.
  - [ ] Connect dedicated Codex, Claude, and Antigravity account-ownership history flows.
    - [x] Connect Codex canonical account-owned plan history to desktop and CLI.
    - [x] Port Claude snapshot-identity plan history ownership and legacy email migration.
    - [x] Port Claude OAuth/token-account plan history ownership.
      - [x] Bind OAuth history to a stable opaque credential owner in desktop and CLI without crossing DTO/IPC boundaries.
      - [x] Bind selected Claude token accounts to their dedicated history buckets.
    - [x] Port Antigravity pinned Gemini family history, snapshot email/organization ownership, and legacy unscoped adoption.
    - [x] Bind Antigravity remote OAuth history to ID-token/email claims and Swift-compatible plan tiers.
    - [ ] Connect Antigravity local GetUserStatus/token-account owner observation to the shared history policy.
      - [x] Port GetUserStatus email/tier parsing and merge a host-supplied bounded response into local quota usage.
      - [x] Wire native process/port/CSRF discovery through the platform broker.
      - [x] Connect selected token-account ownership to local observation and OAuth fallback without exposing raw account credentials.
      - [x] Restrict external `agy` reuse to an explicitly selected, same-user binary in one-shot CLI hosts.
      - [ ] Port the warm `agy` CLI lifecycle, readiness polling, idle teardown, and one-shot reset policy.
- [ ] Port adaptive refresh wiring, cache, status, redaction, and cancellation ownership.
  - [x] Add the desktop adaptive timer with generation replacement, abort propagation, persisted refresh, and error redaction.
  - [x] Invalidate renderer overview/settings with a payload-free IPC event after a background round persists at least one snapshot.
  - [ ] Add persistent snapshot/cache TTL, status probes, real low-power/thermal/activity adapters, plugin refresh, and CLI orchestration.
- [ ] Implement all CLI commands, output formats, exit codes, and Node SEA artifacts.
  - [x] Add usage, providers, cost, cards, dashboard, diagnose, cache, config, guard, hooks, sessions, cookie, plugins, and bounded serve command surfaces.
  - [x] Connect the normal Node CLI to the sandboxed plugin lifecycle, native keyring, stdin-only secrets, and desktop-exported cookie credentials.
  - [x] Embed and verify the disposable QuickJS plugin child in the host-native SEA artifact.
  - [x] Port the serve Web UI, icon assets, progressive fill, cache/SWR, and cancellation behavior.
  - [ ] Produce the remaining Node SEA target matrix.
  - [x] Produce a host-native Node SEA CLI executable with a verified extracted keyring addon; cross-compilation and release archives remain disabled.
- [x] Implement the data-only opt-in legacy import, report, rollback, no-clobber writes, and secret-safe behavior.
- [x] Connect the explicit inspect/execute/rollback legacy import CLI with opt-in and mutation confirmation.
- [x] Connect a ticketed native-picker legacy import UI without exposing paths, journals, or source data to the renderer.
- [ ] Reconcile legacy plugin/config layouts and add a separately-approved native credential migration.
  - [x] Import Swift's flat `providers/*.js|ts` layout and direct `config.json` path with ownership-safe rollback.
  - [ ] Add a separately-approved native credential migration without copying browser sessions or approvals.

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
- [ ] Port multi-call/signing providers (Azure OpenAI, Gemini, Vertex AI, Bedrock, Copilot, MiniMax, LiteLLM, ZenMux, and Wayfinder are partial; MiniMax selected-account isolation and HTML-first parsing are complete).
  - [x] Harden Wayfinder required payload decoding, cancellation, and no-redirect transport proof; native-oracle parity remains pending.
  - [x] Align ZenMux opt-in PAYG fetches, cancellation, strict decoding, and HTTP error classification; native-oracle parity remains pending.
- [x] Port all 20 cookie/web provider domain modules with isolated-session/manual credential contracts; complete adapter/native parity remains gated separately.
- [ ] Complete local/CLI/OAuth parity; all provider IDs now have executable strategies, while Grok OAuth/CLI RPC and the remaining native discovery/login adapters still require parity work.
  - [x] Port Kiro `GetUsageLimits` enrichment, including read-only CLI credentials, Windows/macOS/Linux state paths, overage cap/charges, and CLI-authoritative fallback.
  - [x] Port Grok's bounded local `signals.json` scanner and compose its aggregate only as non-quota diagnostics after successful billing.
  - [x] Port Grok auth.json ownership, OAuth proxy/gRPC, identity, and a bounded one-shot CLI billing probe.
  - [x] Replace the one-shot Grok CLI billing probe with a bounded streaming ACP session and deterministic teardown.
  - [x] Route selected Grok bearer/cookie accounts through the Swift-compatible Auto source override.
  - [ ] Complete Grok browser-session parity.
- [x] Require descriptor, strategy, config, resolving fixtures/goldens, tests, and parity state for every provider.

## Milestones 8–9 — desktop parity and final gate

- [ ] Port tray/settings/accounts/history/cost/notifications/autostart/shortcuts/privacy UI.
  - [x] Add accessible provider cards, explicit refresh, persisted history/cost views, and an honest read-only settings shell.
  - [x] Add schema-validated provider enablement/source mutations with serialized atomic persistence.
  - [x] Publish the provider-siloed spend overview/dashboard with xAI coverage state and no internal source IDs crossing IPC.
  - [x] Publish local Grok token activity independently from remote billing without attributing subscription dollars.
  - [x] Add opt-in Claude Swap account cards and a schema-validated, freshly reauthorized desktop account-switch transaction.
  - [x] Add localized session-quota notifications and a schema-validated persisted settings toggle.
  - [ ] Add remaining account mutations, full dashboards, tray parity, notifications, autostart, shortcuts, and privacy controls.
- [ ] Port all 23 languages, pluralization, RTL, and visual tests.
  - [x] Establish the 23-locale catalog, current renderer messages, plural rules, and RTL direction.
  - [x] Import the complete upstream `.strings`/`.stringsdict` catalogs with deterministic regeneration and English fallback.
  - [ ] Apply the full catalog throughout the parity UI and complete locale/RTL visual tests.
- [ ] Pass functional, security, persistence, cancellation, renderer, and provider gates.
- [x] Add a pinned, host-native desktop artifact builder with AppImage smoke and declared NSIS/DMG targets; cross-build, signing and publication remain disabled.
- [ ] Remove Swift, SwiftPM, and CQuickJS from TypeScript `multi` only after parity.
- [ ] Add new TypeScript CI only after local parity gates pass.
- [ ] Keep release, publication, signing, notarization, and updater disabled pending approval.
