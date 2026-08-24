import * as Schema from "effect/Schema";
import { HostStatusDTO, HostFailureStageDTO } from "@codexbar/contracts";

export type HostFailureStage = Schema.Schema.Type<typeof HostFailureStageDTO>;
export type HostStatus = Schema.Schema.Type<typeof HostStatusDTO>;

export type HostLifecycleState =
  | { readonly status: "starting"; readonly bootstrapStage: HostFailureStage }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly failure: { readonly stage: HostFailureStage } };

const decodeHostStatus = Schema.decodeUnknownSync(HostStatusDTO);
const decodeStage = Schema.decodeUnknownSync(HostFailureStageDTO);

/**
 * Pure lifecycle: starting -> ready|failed only. Never accepts raw Error or text.
 */
export const createHostLifecycle = (
  initialStage: HostFailureStage = "shell",
): {
  readonly getState: () => HostLifecycleState;
  readonly getBootstrapStage: () => HostFailureStage | undefined;
  readonly toHostStatusDTO: () => HostStatus;
  readonly advanceBootstrapStage: (stage: HostFailureStage) => void;
  readonly markReady: () => void;
  readonly markFailed: (stage: HostFailureStage) => void;
  readonly shouldQuitOnWindowAllClosed: () => boolean;
} => {
  let state: HostLifecycleState = {
    status: "starting",
    bootstrapStage: decodeStage(initialStage) as HostFailureStage,
  };

  const toHostStatusDTO = (): HostStatus => {
    if (state.status === "starting") {
      return decodeHostStatus({ schemaVersion: 1, status: "starting" });
    }
    if (state.status === "ready") {
      return decodeHostStatus({ schemaVersion: 1, status: "ready" });
    }
    return decodeHostStatus({
      schemaVersion: 1,
      status: "failed",
      failure: { stage: state.failure.stage },
    });
  };

  const advanceBootstrapStage = (stage: HostFailureStage): void => {
    if (state.status !== "starting") {
      throw new Error("Cannot advance bootstrap stage after terminal state");
    }
    const next = decodeStage(stage) as HostFailureStage;
    state = { status: "starting", bootstrapStage: next };
  };

  const markReady = (): void => {
    if (state.status !== "starting") {
      throw new Error("Cannot mark ready from terminal state");
    }
    state = { status: "ready" };
  };

  const markFailed = (stage: HostFailureStage): void => {
    if (state.status !== "starting") {
      throw new Error("Cannot mark failed from terminal state");
    }
    const next = decodeStage(stage) as HostFailureStage;
    state = { status: "failed", failure: { stage: next } };
  };

  const shouldQuitOnWindowAllClosed = (): boolean => state.status === "failed";

  const getState = (): HostLifecycleState => state;

  const getBootstrapStage = (): HostFailureStage | undefined =>
    state.status === "starting" ? state.bootstrapStage : undefined;

  return {
    getState,
    getBootstrapStage,
    toHostStatusDTO,
    advanceBootstrapStage,
    markReady,
    markFailed,
    shouldQuitOnWindowAllClosed,
  };
};

export type HostLifecycle = ReturnType<typeof createHostLifecycle>;

/** Pure last-window-close policy. */
export const shouldQuitOnWindowAllClosedForStatus = (
  status: HostLifecycleState["status"],
): boolean => status === "failed";
