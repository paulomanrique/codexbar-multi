import {
  CancelCodexBrowserSessionRequestDTO,
  CodexBrowserSessionStatusesDTO,
  GetCodexBrowserSessionStatusesRequestDTO,
  LogoutCodexBrowserSessionRequestDTO,
  StartCodexBrowserSessionRequestDTO,
  type CancelCodexBrowserSessionRequestDTO as CancelRequest,
  type CodexBrowserSessionStatusesDTO as SessionStatuses,
  type GetCodexBrowserSessionStatusesRequestDTO as StatusesRequest,
  type LogoutCodexBrowserSessionRequestDTO as LogoutRequest,
  type StartCodexBrowserSessionRequestDTO as StartRequest,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeStart = Schema.decodeUnknownPromise(StartCodexBrowserSessionRequestDTO);
const decodeCancel = Schema.decodeUnknownPromise(CancelCodexBrowserSessionRequestDTO);
const decodeLogout = Schema.decodeUnknownPromise(LogoutCodexBrowserSessionRequestDTO);
const decodeStatusesRequest = Schema.decodeUnknownPromise(GetCodexBrowserSessionStatusesRequestDTO);
const decodeStatuses = Schema.decodeUnknownPromise(CodexBrowserSessionStatusesDTO);

const exact = async <T extends object>(
  value: unknown,
  keys: readonly string[],
  decode: (value: unknown) => Promise<T>,
): Promise<T> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex browser-session request must be an object.");
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Codex browser-session request contains unsupported fields.");
  }
  return decode(value);
};

const decodeExactResult = async (value: unknown): Promise<SessionStatuses> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex browser-session result must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !new Set(["provider", "revision", "statuses"]).has(key))) {
    throw new Error("Codex browser-session result contains unsupported fields.");
  }
  if (!Array.isArray(record.statuses))
    throw new Error("Codex browser-session statuses must be an array.");
  for (const status of record.statuses) {
    if (typeof status !== "object" || status === null || Array.isArray(status)) {
      throw new Error("Codex browser-session status must be an object.");
    }
    if (Object.keys(status).some((key) => key !== "accountId" && key !== "status")) {
      throw new Error("Codex browser-session status contains unsupported fields.");
    }
  }
  return decodeStatuses(value);
};

/** Dedicated metadata-only Codex web-session bridge; no provider or credential fields cross IPC. */
export const makeCodexBrowserSessionApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    startCodexBrowserSession: async (request: StartRequest): Promise<SessionStatuses> =>
      decodeExactResult(
        await invoke(
          DesktopChannels.startCodexBrowserSession,
          await exact(request, ["accountId", "expectedRevision"], decodeStart),
        ),
      ),
    cancelCodexBrowserSession: async (request: CancelRequest): Promise<SessionStatuses> =>
      decodeExactResult(
        await invoke(
          DesktopChannels.cancelCodexBrowserSession,
          await exact(request, ["accountId"], decodeCancel),
        ),
      ),
    logoutCodexBrowserSession: async (request: LogoutRequest): Promise<SessionStatuses> =>
      decodeExactResult(
        await invoke(
          DesktopChannels.logoutCodexBrowserSession,
          await exact(request, ["accountId", "expectedRevision"], decodeLogout),
        ),
      ),
    getCodexBrowserSessionStatuses: async (request: StatusesRequest): Promise<SessionStatuses> =>
      decodeExactResult(
        await invoke(
          DesktopChannels.getCodexBrowserSessionStatuses,
          await exact(request, ["expectedRevision"], decodeStatusesRequest),
        ),
      ),
  });
