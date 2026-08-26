import {
  CodexAccountLoginRequestDTO,
  ListTokenAccountsRequestDTO,
  RenameTokenAccountRequestDTO,
  RemoveTokenAccountRequestDTO,
  SelectTokenAccountRequestDTO,
  TokenAccountRosterDTO,
  type ListTokenAccountsRequestDTO as ListTokenAccountsRequest,
  type CodexAccountLoginRequestDTO as CodexAccountLoginRequest,
  type RenameTokenAccountRequestDTO as RenameTokenAccountRequest,
  type RemoveTokenAccountRequestDTO as RemoveTokenAccountRequest,
  type SelectTokenAccountRequestDTO as SelectTokenAccountRequest,
  type TokenAccountRosterDTO as TokenAccountRoster,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeListTokenAccountsRequest = Schema.decodeUnknownPromise(ListTokenAccountsRequestDTO);
const decodeCodexAccountLoginRequest = Schema.decodeUnknownPromise(CodexAccountLoginRequestDTO);
const decodeRenameTokenAccountRequest = Schema.decodeUnknownPromise(RenameTokenAccountRequestDTO);
const decodeRemoveTokenAccountRequest = Schema.decodeUnknownPromise(RemoveTokenAccountRequestDTO);
const decodeSelectTokenAccountRequest = Schema.decodeUnknownPromise(SelectTokenAccountRequestDTO);
const decodeTokenAccountRoster = Schema.decodeUnknownPromise(TokenAccountRosterDTO);

/** Metadata-only account switching bridge; no secrets or persisted config cross preload. */
export const makeTokenAccountsApi = (invoke: DesktopInvoke) =>
  Object.freeze({
    listTokenAccounts: async (request: ListTokenAccountsRequest): Promise<TokenAccountRoster> =>
      decodeTokenAccountRoster(
        await invoke(
          DesktopChannels.listTokenAccounts,
          await decodeListTokenAccountsRequest(request),
        ),
      ),
    selectTokenAccount: async (request: SelectTokenAccountRequest): Promise<TokenAccountRoster> =>
      decodeTokenAccountRoster(
        await invoke(
          DesktopChannels.selectTokenAccount,
          await decodeSelectTokenAccountRequest(request),
        ),
      ),
    renameTokenAccount: async (request: RenameTokenAccountRequest): Promise<TokenAccountRoster> =>
      decodeTokenAccountRoster(
        await invoke(
          DesktopChannels.renameTokenAccount,
          await decodeRenameTokenAccountRequest(request),
        ),
      ),
    removeTokenAccount: async (request: RemoveTokenAccountRequest): Promise<TokenAccountRoster> =>
      decodeTokenAccountRoster(
        await invoke(
          DesktopChannels.removeTokenAccount,
          await decodeRemoveTokenAccountRequest(request),
        ),
      ),
    startCodexAccountLogin: async (
      request: CodexAccountLoginRequest,
    ): Promise<TokenAccountRoster> =>
      decodeTokenAccountRoster(
        await invoke(
          DesktopChannels.startCodexAccountLogin,
          await decodeCodexAccountLoginRequest(request),
        ),
      ),
    cancelCodexAccountLogin: async (request: CodexAccountLoginRequest): Promise<void> => {
      await invoke(
        DesktopChannels.cancelCodexAccountLogin,
        await decodeCodexAccountLoginRequest(request),
      );
    },
  });
