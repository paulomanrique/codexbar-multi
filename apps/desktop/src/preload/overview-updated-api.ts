import { DesktopChannels } from "../ipc/api.js";

export type DesktopEventListener = (...args: unknown[]) => void;
export type DesktopEventSubscribe = (channel: string, listener: DesktopEventListener) => void;

/** Capability-minimal subscription for background overview invalidation. */
export const makeOverviewUpdatedApi = (
  on: DesktopEventSubscribe,
  removeListener: DesktopEventSubscribe,
) =>
  Object.freeze({
    onOverviewUpdated: (listener: () => void): (() => void) => {
      let subscribed = true;
      const wrapper: DesktopEventListener = () => {
        listener();
      };
      on(DesktopChannels.overviewUpdated, wrapper);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        removeListener(DesktopChannels.overviewUpdated, wrapper);
      };
    },
  });
