import {
  ExecuteLegacyImportRequestDTO,
  LegacyImportExecutionResultDTO,
  LegacyImportInspectionResultDTO,
  LegacyImportRollbackResultDTO,
  RollbackLegacyImportRequestDTO,
  type ExecuteLegacyImportRequestDTO as ExecuteLegacyImportRequest,
  type LegacyImportExecutionResultDTO as LegacyImportExecutionResult,
  type LegacyImportInspectionResultDTO as LegacyImportInspectionResult,
  type LegacyImportRollbackResultDTO as LegacyImportRollbackResult,
  type RollbackLegacyImportRequestDTO as RollbackLegacyImportRequest,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeInspection = Schema.decodeUnknownPromise(LegacyImportInspectionResultDTO);
const decodeExecuteRequest = Schema.decodeUnknownPromise(ExecuteLegacyImportRequestDTO);
const decodeExecution = Schema.decodeUnknownPromise(LegacyImportExecutionResultDTO);
const decodeRollbackRequest = Schema.decodeUnknownPromise(RollbackLegacyImportRequestDTO);
const decodeRollback = Schema.decodeUnknownPromise(LegacyImportRollbackResultDTO);

/** Capability-minimal migration bridge; paths and filesystem selection remain in main. */
export const makeLegacyImportApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    inspectLegacyImport: async (): Promise<LegacyImportInspectionResult> =>
      decodeInspection(await invoke(DesktopChannels.inspectLegacyImport)),
    executeLegacyImport: async (
      request: ExecuteLegacyImportRequest,
    ): Promise<LegacyImportExecutionResult> =>
      decodeExecution(
        await invoke(DesktopChannels.executeLegacyImport, await decodeExecuteRequest(request)),
      ),
    rollbackLegacyImport: async (
      request: RollbackLegacyImportRequest,
    ): Promise<LegacyImportRollbackResult> =>
      decodeRollback(
        await invoke(DesktopChannels.rollbackLegacyImport, await decodeRollbackRequest(request)),
      ),
  });
