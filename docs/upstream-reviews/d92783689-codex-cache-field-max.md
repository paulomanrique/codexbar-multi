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

Light cumulative regressions now use the same tokscale predicate as Swift. A stale snapshot is
skipped before it can replace the accepted baseline or make the compact TypeScript scanner enter
its fail-closed unsafe state; raw fork evidence is still collected first. Codex cumulative state
also retains the distinction between an omitted reasoning counter and an explicit zero across
incremental scans, clamps observed reasoning to output, and compares reasoning regressions only
when both snapshots supplied the field.

This slice intentionally does not yet port Swift's last-event preference, monotonic watermark,
seen-snapshot set, interleaved-lineage containment, or fork snapshot accumulator. Non-stale hard
regressions therefore continue to use the existing TypeScript fail-closed policy. Dashboard work
and unrelated Antigravity changes from `d92783689` also remain outside this review. Component and
provider `lastReviewedCommit` values therefore do not advance.
