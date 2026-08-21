import {
  ActivateClaudeSwapAccountRequestDTO,
  ActivateClaudeSwapAccountResultDTO,
  type ActivateClaudeSwapAccountRequestDTO as ActivateClaudeSwapAccountRequest,
  type ActivateClaudeSwapAccountResultDTO as ActivateClaudeSwapAccountResult,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeRequest = Schema.decodeUnknownPromise(ActivateClaudeSwapAccountRequestDTO);
const decodeResult = Schema.decodeUnknownPromise(ActivateClaudeSwapAccountResultDTO);

/** Minimal testable bridge for the one explicit Claude Swap mutation. */
export const makeClaudeSwapApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    activateClaudeSwapAccount: async (
      request: ActivateClaudeSwapAccountRequest,
    ): Promise<ActivateClaudeSwapAccountResult> =>
      decodeResult(
        await invoke(DesktopChannels.activateClaudeSwapAccount, await decodeRequest(request)),
      ),
  });
