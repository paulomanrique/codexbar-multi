---
summary: "Kiro provider data sources: CLI-based usage via kiro-cli /usage command."
read_when:
  - Debugging Kiro usage parsing
  - Updating kiro-cli command behavior
  - Reviewing Kiro credit window mapping
---

# Kiro provider

Kiro uses the AWS `kiro-cli` tool to fetch usage data. No browser cookies or OAuth flow—authentication is handled by AWS Builder ID through the CLI.

## Data sources

1. **CLI command** (authoritative strategy)
   - Command: `kiro-cli chat --no-interactive "/usage"`
   - Timeout: 20 seconds (idle cutoff after 4 seconds of no output once the CLI starts responding).
   - CodexBar tries ordinary stdout/stderr pipes first for current Kiro CLI releases. Incomplete or unusable
     pipe output falls back to a pseudo-terminal within the same overall command deadline for older releases.
   - Requires `kiro-cli` installed and logged in via AWS Builder ID.
   - Output is ANSI-decorated; CodexBar strips escape sequences before parsing.

2. **Usage-limit enrichment** (best effort, platform-owned)
   - Reads only the official CLI's token/profile rows from its SQLite state in read-only mode with a short busy timeout.
   - Resolves the CLI state under macOS Application Support, Linux XDG data, or Windows Local AppData; `KIRO_DATA_DIR` remains an explicit override.
   - Sends the token only to the fixed AWS CodeWhisperer `GetUsageLimits` endpoint with redirects rejected and a 10-second request timeout.
   - Provider code receives only the bounded response body/status. A missing, stale, or moved CLI state store leaves the parsed CLI report intact.

## Output format (example)

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                          | KIRO FREE      ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ Monthly credits:                                                          ┃
┃ ████████████████████████████████████████████████████████ 100% (resets on 01/01) ┃
┃                              (0.00 of 50 covered in plan)                 ┃
┃ Bonus credits:                                                            ┃
┃ 0.00/100 credits used, expires in 88 days                                 ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Snapshot mapping

- **Primary window**: Monthly credits percentage (bar meter).
  - `usedPercent`: extracted from `███...█ X%` pattern.
  - `resetsAt`: parsed from `resets on MM/DD` (assumes current or next year).
- **Secondary window**: Bonus credits (when present).
  - Parsed from `Bonus credits: X.XX/Y credits used`.
  - Expiry from `expires in N days`.
- **Overage window and cost** (when the service declares an enabled cap):
  - Plan usage excludes overage, preventing a spent plan from rendering above 100%.
  - Overage credits render against their own cap and reset.
  - Accrued charges render against `cap × rate` in the service-provided currency.
- **Identity**:
  - `accountOrganization`: plan name (e.g., "KIRO FREE").
  - `loginMethod`: plan name (used for menu display).

## Status

Kiro does not have a dedicated status page. The "View Status" link opens the AWS Health Dashboard:

- `https://health.aws.amazon.com/health/status`

## Key files

- `Sources/CodexBarCore/Providers/Kiro/KiroProviderDescriptor.swift`
- `Sources/CodexBarCore/Providers/Kiro/KiroStatusProbe.swift`
- `Sources/CodexBar/Providers/Kiro/KiroProviderImplementation.swift`
