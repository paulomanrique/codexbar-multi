import type {
  CancelCodexBrowserSessionRequestDTO,
  CodexBrowserSessionStatusesDTO,
  CodexBrowserSessionStatusDTO,
  GetCodexBrowserSessionStatusesRequestDTO,
  LogoutCodexBrowserSessionRequestDTO,
  StartCodexBrowserSessionRequestDTO,
  TokenAccountRosterDTO,
} from "@codexbar/contracts";

export interface DesktopCodexBrowserSessionDependencies {
  readonly listRoster: () => Promise<TokenAccountRosterDTO>;
  readonly readStatus: (accountId: string) => Promise<CodexBrowserSessionStatusDTO["status"]>;
  readonly cleanupIsPending: (accountId: string) => Promise<boolean>;
  readonly stageLoginFence: (accountId: string) => Promise<void>;
  readonly startBrowserSession: (
    accountId: string,
    expectedRevision: string,
  ) => Promise<"connected" | "cancelled">;
  readonly commitBrowserSession: (accountId: string, expectedRevision: string) => Promise<void>;
  readonly cancelBrowserSession: (accountId: string) => void;
  readonly cleanupBrowserSession: (accountId: string) => Promise<void>;
  readonly enqueueCleanup: (accountId: string) => Promise<void>;
  readonly drainCleanup: () => Promise<void>;
}

export type CodexBrowserSessionErrorCode =
  | "missing-account"
  | "inactive-account"
  | "stale-revision"
  | "cleanup-pending"
  | "start-in-progress"
  | "start-failed"
  | "cancel-failed"
  | "logout-failed";

export class CodexBrowserSessionError extends Error {
  readonly code: CodexBrowserSessionErrorCode;

  constructor(code: CodexBrowserSessionErrorCode, message: string) {
    super(message);
    this.name = "CodexBrowserSessionError";
    this.code = code;
  }
}

const failure = (code: CodexBrowserSessionErrorCode, message: string) =>
  new CodexBrowserSessionError(code, message);

/**
 * Host-only coordination for one account-scoped Codex web session.
 *
 * The renderer supplies only an opaque account ID and roster revision. The
 * host authorizes the currently selected account both before and after login,
 * validates the exported credential through the first-party Codex runtime,
 * and durably schedules cleanup whenever either post-login check fails.
 */
export class DesktopCodexBrowserSessionController {
  readonly #dependencies: DesktopCodexBrowserSessionDependencies;
  readonly #activeStarts = new Set<string>();
  readonly #cancelledStarts = new Set<string>();
  readonly #accountOperations = new Map<string, Promise<void>>();

  constructor(dependencies: DesktopCodexBrowserSessionDependencies) {
    this.#dependencies = dependencies;
  }

  async statuses(
    request: GetCodexBrowserSessionStatusesRequestDTO,
  ): Promise<CodexBrowserSessionStatusesDTO> {
    return this.#snapshot(await this.#requireRevision(request.expectedRevision));
  }

  async start(
    request: StartCodexBrowserSessionRequestDTO,
  ): Promise<CodexBrowserSessionStatusesDTO> {
    if (this.#activeStarts.has(request.accountId)) {
      throw failure("start-in-progress", "A Codex browser session action is already in progress.");
    }
    this.#activeStarts.add(request.accountId);
    try {
      return await this.#withAccountOperation(request.accountId, async () => {
        await this.#requireActiveAccount(request.accountId, request.expectedRevision);
        if (await this.#dependencies.cleanupIsPending(request.accountId)) {
          throw failure(
            "cleanup-pending",
            "Codex browser-session cleanup is pending for this account.",
          );
        }
        try {
          // Write-ahead fence: a crash from this point through final commit is
          // replayed as destructive partition/credential cleanup on startup.
          await this.#dependencies.stageLoginFence(request.accountId);
        } catch {
          throw failure("start-failed", "Codex browser-session fencing failed.");
        }

        let loginStatus: "connected" | "cancelled";
        try {
          loginStatus = await this.#dependencies.startBrowserSession(
            request.accountId,
            request.expectedRevision,
          );
        } catch {
          if (await this.#dependencies.cleanupIsPending(request.accountId).catch(() => true)) {
            await this.#cleanupUnsafeSession(request.accountId);
          }
          throw failure("start-failed", "Codex browser session did not connect.");
        }
        if (loginStatus === "cancelled") {
          try {
            await this.#dependencies.drainCleanup();
          } catch {
            throw failure("cancel-failed", "Codex browser-session cancellation did not complete.");
          }
          return this.#snapshot(
            await this.#requireActiveAccount(request.accountId, request.expectedRevision),
          );
        }

        try {
          const validatedRoster = await this.#requireActiveAccount(
            request.accountId,
            request.expectedRevision,
          );
          if (this.#cancelledStarts.has(request.accountId)) {
            throw failure("start-failed", "Codex browser session was cancelled.");
          }
          await this.#dependencies.commitBrowserSession(
            request.accountId,
            request.expectedRevision,
          );
          if (this.#cancelledStarts.has(request.accountId)) {
            throw failure("start-failed", "Codex browser session was cancelled.");
          }
          return this.#snapshot(validatedRoster);
        } catch (cause) {
          await this.#cleanupUnsafeSession(request.accountId);
          if (cause instanceof CodexBrowserSessionError) throw cause;
          throw failure("start-failed", "Codex browser session did not validate.");
        }
      });
    } finally {
      this.#activeStarts.delete(request.accountId);
      this.#cancelledStarts.delete(request.accountId);
    }
  }

  async cancel(
    request: CancelCodexBrowserSessionRequestDTO,
  ): Promise<CodexBrowserSessionStatusesDTO> {
    const hadActiveStart = this.#activeStarts.has(request.accountId);
    if (hadActiveStart) this.#cancelledStarts.add(request.accountId);
    this.#dependencies.cancelBrowserSession(request.accountId);
    try {
      if (hadActiveStart) {
        await this.#dependencies.enqueueCleanup(request.accountId);
        await this.#dependencies.drainCleanup();
      }
      const roster = await this.#dependencies.listRoster();
      if (!hadActiveStart) this.#requireAccount(roster, request.accountId);
      return this.#snapshot(roster);
    } catch (cause) {
      if (cause instanceof CodexBrowserSessionError) throw cause;
      throw failure("cancel-failed", "Codex browser-session cancellation did not complete.");
    }
  }

  async logout(
    request: LogoutCodexBrowserSessionRequestDTO,
  ): Promise<CodexBrowserSessionStatusesDTO> {
    return this.#withAccountOperation(request.accountId, async () => {
      await this.#requireActiveAccount(request.accountId, request.expectedRevision);
      try {
        await this.#dependencies.enqueueCleanup(request.accountId);
        await this.#dependencies.drainCleanup();
        return this.#snapshot(await this.#dependencies.listRoster());
      } catch {
        throw failure("logout-failed", "Codex browser-session cleanup did not complete.");
      }
    });
  }

  async cancelAll(): Promise<void> {
    const accountIds = [...this.#activeStarts];
    const results = await Promise.allSettled(
      accountIds.map((accountId) => this.cancel({ accountId }).then(() => undefined)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async #requireRevision(expectedRevision: string): Promise<TokenAccountRosterDTO> {
    const roster = await this.#dependencies.listRoster();
    if (roster.provider !== "codex" || roster.revision !== expectedRevision) {
      throw failure(
        "stale-revision",
        "The Codex account selection changed. Refresh and try again.",
      );
    }
    return roster;
  }

  async #requireActiveAccount(
    accountId: string,
    expectedRevision: string,
  ): Promise<TokenAccountRosterDTO> {
    const roster = await this.#requireRevision(expectedRevision);
    this.#requireAccount(roster, accountId);
    if (roster.accounts[roster.activeIndex]?.id !== accountId) {
      throw failure("inactive-account", "Only the selected Codex account can be connected.");
    }
    return roster;
  }

  #requireAccount(roster: TokenAccountRosterDTO, accountId: string): void {
    if (
      roster.provider !== "codex" ||
      !roster.accounts.some((account) => account.id === accountId)
    ) {
      throw failure("missing-account", "The selected Codex account is no longer available.");
    }
  }

  async #snapshot(roster: TokenAccountRosterDTO): Promise<CodexBrowserSessionStatusesDTO> {
    const statuses = await Promise.all(
      roster.accounts.map(async ({ id: accountId }) => ({
        accountId,
        status: (await this.#dependencies.cleanupIsPending(accountId))
          ? ("unavailable" as const)
          : await this.#dependencies.readStatus(accountId),
      })),
    );
    return { provider: "codex", revision: roster.revision, statuses };
  }

  async #cleanupUnsafeSession(accountId: string): Promise<void> {
    try {
      await this.#dependencies.enqueueCleanup(accountId);
      await this.#dependencies.drainCleanup();
    } catch {
      try {
        await this.#dependencies.cleanupBrowserSession(accountId);
      } catch {
        // The start stays fail-closed and never exposes the credential. If the
        // journal write succeeded, its marker remains for startup recovery.
      }
    }
  }

  async #withAccountOperation<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#accountOperations.get(accountId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const own = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => own);
    this.#accountOperations.set(accountId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#accountOperations.get(accountId) === tail) {
        this.#accountOperations.delete(accountId);
      }
    }
  }
}
