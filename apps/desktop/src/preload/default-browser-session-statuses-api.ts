import {
  DefaultBrowserSessionStatusesDTO,
  type DefaultBrowserSessionStatusesDTO as DefaultBrowserSessionStatuses,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeDefaultBrowserSessionStatuses = Schema.decodeUnknownPromise(
  DefaultBrowserSessionStatusesDTO,
);

/** Testable, capability-minimal browser-session status projection. */
export const makeDefaultBrowserSessionStatusesApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    getDefaultBrowserSessionStatuses: async (): Promise<DefaultBrowserSessionStatuses> =>
      decodeDefaultBrowserSessionStatuses(
        await invoke(DesktopChannels.getDefaultBrowserSessionStatuses),
      ),
  });
