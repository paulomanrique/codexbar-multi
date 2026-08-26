import type { TokenAccountRosterDTO } from "@codexbar/contracts";
import type { NodeCodexLoginResult } from "@codexbar/platform/node";

export interface DesktopCodexAccountLoginDependencies {
  readonly cleanupStaleHomes: () => Promise<void>;
  readonly login: (signal: AbortSignal) => Promise<NodeCodexLoginResult>;
  readonly publish: (request: {
    readonly accountId: string;
    readonly label: string;
    readonly credentialJson: string;
    readonly addedAt: number;
    readonly externalIdentifier?: string;
  }) => Promise<void>;
  readonly list: () => Promise<TokenAccountRosterDTO>;
  readonly createAccountId: () => string;
  readonly now: () => number;
}

const loginFailure = (): Error => new Error("Codex account login did not complete.");

/** Serializes the renderer-visible login action while all credential work stays host-owned. */
export class DesktopCodexAccountLoginController {
  readonly #dependencies: DesktopCodexAccountLoginDependencies;
  #active: AbortController | undefined;

  constructor(dependencies: DesktopCodexAccountLoginDependencies) {
    this.#dependencies = dependencies;
  }

  async initialize(): Promise<void> {
    await this.#dependencies.cleanupStaleHomes();
  }

  async start(): Promise<TokenAccountRosterDTO> {
    if (this.#active !== undefined) throw new Error("Codex account login already running.");
    const controller = new AbortController();
    this.#active = controller;
    try {
      const login = await this.#dependencies.login(controller.signal);
      if (controller.signal.aborted) throw loginFailure();
      const externalIdentifier = login.credential.accountId;
      await this.#dependencies.publish({
        accountId: this.#dependencies.createAccountId(),
        label: login.email,
        credentialJson: login.credentialJson,
        addedAt: this.#dependencies.now() / 1_000,
        ...(externalIdentifier === undefined ? {} : { externalIdentifier }),
      });
      return await this.#dependencies.list();
    } catch {
      throw loginFailure();
    } finally {
      if (this.#active === controller) this.#active = undefined;
    }
  }

  cancel(): void {
    this.#active?.abort();
  }
}
