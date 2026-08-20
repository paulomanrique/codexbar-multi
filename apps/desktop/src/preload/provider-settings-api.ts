import {
  ProviderSettingsDTO,
  ProviderSettingsListDTO,
  UpdateProviderSettingsRequestDTO,
  type ProviderSettingsDTO as ProviderSettings,
  type ProviderSettingsListDTO as ProviderSettingsList,
  type UpdateProviderSettingsRequestDTO as UpdateProviderSettingsRequest,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";

export type DesktopInvoke = (channel: string, input?: unknown) => Promise<unknown>;

const decodeProviderSettings = Schema.decodeUnknownPromise(ProviderSettingsDTO);
const decodeProviderSettingsList = Schema.decodeUnknownPromise(ProviderSettingsListDTO);
const decodeUpdateProviderSettings = Schema.decodeUnknownPromise(UpdateProviderSettingsRequestDTO);

/** The testable, capability-minimal settings portion of the preload bridge. */
export const makeProviderSettingsApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    getProviderSettings: async (): Promise<ProviderSettingsList> =>
      decodeProviderSettingsList(await invoke(DesktopChannels.getProviderSettings)),
    updateProviderSettings: async (
      request: UpdateProviderSettingsRequest,
    ): Promise<ProviderSettings> =>
      decodeProviderSettings(
        await invoke(
          DesktopChannels.updateProviderSettings,
          await decodeUpdateProviderSettings(request),
        ),
      ),
  });
