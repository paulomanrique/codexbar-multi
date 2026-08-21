import {
  SessionQuotaNotificationSettingsDTO,
  UpdateSessionQuotaNotificationSettingsRequestDTO,
  type SessionQuotaNotificationSettingsDTO as SessionQuotaNotificationSettings,
  type UpdateSessionQuotaNotificationSettingsRequestDTO as UpdateSessionQuotaNotificationSettingsRequest,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeSettings = Schema.decodeUnknownPromise(SessionQuotaNotificationSettingsDTO);
const decodeUpdate = Schema.decodeUnknownPromise(UpdateSessionQuotaNotificationSettingsRequestDTO);

/** Deliberately small preload surface for the persisted global preference. */
export const makeSessionQuotaNotificationSettingsApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    getSessionQuotaNotificationSettings: async (): Promise<SessionQuotaNotificationSettings> =>
      decodeSettings(await invoke(DesktopChannels.getSessionQuotaNotificationSettings)),
    updateSessionQuotaNotificationSettings: async (
      request: UpdateSessionQuotaNotificationSettingsRequest,
    ): Promise<SessionQuotaNotificationSettings> =>
      decodeSettings(
        await invoke(
          DesktopChannels.updateSessionQuotaNotificationSettings,
          await decodeUpdate(request),
        ),
      ),
  });
