# Upstream review: Codex cache field maximum

- Upstream commit: `d92783689` (`fix(codex): tokscale parity for token counts`)
- Review status: partial; this note does not accept the complete upstream commit.
- Swift source: `Sources/CodexBarCore/Vendored/CostUsage/CostUsageScanner.swift`
- Swift tests: `Tests/CodexBarTests/CostUsageScannerTests.swift`
- TypeScript source: `packages/core/src/cost-jsonl.ts`
- TypeScript tests: `packages/core/test/cost-jsonl.test.ts`

The port now calculates the cached token counter in Codex `event_msg` records as
`max(cached_input_tokens, cache_read_input_tokens)` after normalizing each field independently.
This preserves the existing billed-input behavior while preventing a present zero or smaller
legacy field from hiding a larger cache-read counter.

The remaining behavior from `d92783689`—including bare usage envelopes, stale counter policy,
optional reasoning semantics, dashboard work, and unrelated Antigravity changes—remains outside
this review. Component and provider `lastReviewedCommit` values therefore do not advance.
