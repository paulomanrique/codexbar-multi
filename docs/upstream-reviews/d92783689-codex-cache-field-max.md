# Upstream review: Codex token-count parity slices

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

The port also accepts the four canonical non-event Codex envelopes (`usage`, `data.usage`,
`result.usage`, and `response.usage`) with the same alias precedence, cached-input subtraction,
model fallback, turn attribution, and all-zero rejection as Swift. Bare rows are absolute events
and never alter cumulative or fork baselines. The TypeScript scanner persists the last accepted
bare timestamp in its serializable cursor state so a timestamp-less row retains Swift's fallback
behavior when the host resumes the same file incrementally.

The bare-row representation deliberately matches the upstream `[billed input, cached, output]`
split. This also preserves upstream's current read-time pricing behavior, including its second
cache subtraction when the ordinary Codex pricing path consumes that split. A focused cost test
locks that choice so a future upstream correction can be reviewed explicitly rather than changing
money semantics accidentally.

The remaining behavior from `d92783689`—including stale counter policy, optional reasoning
semantics, dashboard work, and unrelated Antigravity changes—remains outside this review.
Component and provider `lastReviewedCommit` values therefore do not advance.
