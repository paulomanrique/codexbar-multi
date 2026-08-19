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

First-party providers are trusted TypeScript modules. Installed user providers remain untrusted and execute in QuickJS with the upstream security surface: a 1 MiB source/response budget, 64 MiB heap, 2 MiB JavaScript stack, 20 second execution deadline, declared origins/auth/secrets/capabilities/cookie domains, and approval bindings that invalidate on capability drift. A transport-neutral host broker now enforces redirect, response-size, request-timeout, auth-header, cookie-domain, cancellation, and approval-drift policy; the Electron utility-process transport still needs to be connected. The package API does not expose Node or Electron to the guest.

## Upstream maintenance

- `upstream-swift` fast-forwards from `steipete/CodexBar` and remains an oracle branch.
- `multi` is the persistent TypeScript migration branch and receives every relevant milestone.
- `main`/`master` remains free to follow the original repository; the TypeScript rewrite is never merged there.
- `upstream/baseline.json` pins the last reviewed commits.
- `upstream/providers.yml`, `upstream/components.yml`, and `upstream/fixtures.manifest.json` keep semantic correspondence.
- `pnpm upstream:report [ref]` classifies upstream changes by provider, auth, parser, config, cost/history, plugin runtime, fixture, and test.
- `pnpm upstream:accept <commit>` only advances the reviewed baseline after the full local gate succeeds.

Upstream workflows are preserved as inert reference material in `upstream-reference/github-workflows/`. No GitHub Actions workflow, updater, deployment, signing, or release is active.

## Current vertical slice

- Workspace, strict TypeScript configuration, Effect contracts/services, architecture gate, and oracle normalization.
- Closed 69-provider ID roster and a registry that makes unported entries explicit rather than silently omitting them.
- Executable TypeScript modules for 31 providers: the 16 already shipped upstream as JavaScript/TypeScript plugins, Codex's first OAuth slice, and the first 14-provider HTTP wave. They remain `partial`; the upstream matrix only advances individual providers after dedicated fixtures/tests and Swift-oracle comparison.
- A minimal Codex OAuth vertical slice with cross-platform `auth.json` discovery in the CLI composition root and shared `wham/usage` parsing.
- Node/platform adapters, native keyring credentials, SQLite WAL/migrations in a dedicated worker, first CLI usage path, Electron tray/popup shell, typed preload IPC, and React overview.
- QuickJS manifest inspection, approval binding, and transport-neutral capability/HTTP broker with the upstream limits and security fields.

This is an implementation milestone, not feature parity. Entries remain `partial` until their Swift tests/fixtures and native smoke scenarios pass. Packaging scripts deliberately fail closed until the cross-platform parity gate is approved.
