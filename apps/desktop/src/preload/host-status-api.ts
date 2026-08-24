import { HostStatusDTO, type HostStatusDTO as HostStatus } from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeHostStatus = Schema.decodeUnknownPromise(HostStatusDTO);

export const makeHostStatusApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    getHostStatus: async (): Promise<HostStatus> =>
      decodeHostStatus(await invoke(DesktopChannels.hostStatus)),
  });
