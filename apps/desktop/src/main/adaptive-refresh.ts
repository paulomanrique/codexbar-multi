import {
  nextAdaptiveRefreshDelay,
  type AdaptiveRefreshDecision,
  type ThermalPressure,
} from "@codexbar/core";

export interface DesktopAdaptiveRefreshSignals {
  readonly lowPowerModeEnabled: boolean;
  readonly thermalPressure: ThermalPressure;
  readonly lastCodingActivityAt?: Date | null;
}

export interface DesktopAdaptiveRefreshHost {
  readonly now: () => Date;
  /** The host owns timer implementation so this policy controller stays deterministic in tests. */
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** A cancelled generation must not publish a later background result. */
  readonly refresh: (signal: AbortSignal) => Promise<void>;
  readonly signals: () => DesktopAdaptiveRefreshSignals;
}

/**
 * Desktop composition around the portable adaptive policy. It owns only timer
 * generations and cancellation; provider execution, persistence, and secrets
 * remain in the main-process refresh operation supplied by the host.
 */
export class DesktopAdaptiveRefreshController {
  readonly #host: DesktopAdaptiveRefreshHost;
  #lastMenuOpenAt: Date | null = null;
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(host: DesktopAdaptiveRefreshHost) {
    this.#host = host;
  }

  start(): void {
    if (this.#running !== undefined) return;
    this.#startGeneration();
  }

  stop(): void {
    this.#controller?.abort();
    this.#controller = undefined;
  }

  /** Menu/tray interaction advances a sleeping adaptive tick to the fresh cadence. */
  noteMenuOpen(at: Date = this.#host.now()): void {
    if (!Number.isFinite(at.getTime())) return;
    this.#lastMenuOpenAt = at;
    if (this.#running === undefined) return;
    this.#controller?.abort();
    this.#startGeneration();
  }

  currentDecision(): AdaptiveRefreshDecision {
    const signals = this.#host.signals();
    return nextAdaptiveRefreshDelay({
      now: this.#host.now(),
      lastMenuOpenAt: this.#lastMenuOpenAt,
      ...(signals.lastCodingActivityAt === undefined
        ? {}
        : { lastCodingActivityAt: signals.lastCodingActivityAt }),
      lowPowerModeEnabled: signals.lowPowerModeEnabled,
      thermalPressure: signals.thermalPressure,
    });
  }

  #startGeneration(): void {
    const controller = new AbortController();
    this.#controller = controller;
    const running = this.#run(controller);
    this.#running = running;
    void running.finally(() => {
      // A superseded generation must not clear the controller owned by its
      // replacement. This is the same publication-ownership rule as refresh.
      if (this.#running !== running) return;
      this.#running = undefined;
      if (this.#controller === controller) this.#controller = undefined;
    });
  }

  async #run(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      const decision = this.currentDecision();
      try {
        await this.#host.sleep(decision.delayMs, controller.signal);
      } catch {
        return;
      }
      if (controller.signal.aborted) return;
      try {
        await this.#host.refresh(controller.signal);
      } catch {
        // Provider-specific errors are intentionally handled by the refresh
        // path. The timer stores/logs neither error text nor provider data.
        if (controller.signal.aborted) return;
      }
    }
  }
}
