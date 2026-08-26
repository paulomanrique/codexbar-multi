import {
  ListTokenAccountsRequestDTO,
  RenameTokenAccountRequestDTO,
  SelectTokenAccountRequestDTO,
  TokenAccountRosterDTO,
  type ListTokenAccountsRequestDTO as ListTokenAccountsRequest,
  type RenameTokenAccountRequestDTO as RenameTokenAccountRequest,
  type SelectTokenAccountRequestDTO as SelectTokenAccountRequest,
  type TokenAccountRosterDTO as TokenAccountRoster,
} from "@codexbar/contracts";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import type { DesktopInvoke } from "./provider-settings-api.js";

const decodeListTokenAccountsRequest = Schema.decodeUnknownPromise(ListTokenAccountsRequestDTO);
const decodeRenameTokenAccountRequest = Schema.decodeUnknownPromise(RenameTokenAccountRequestDTO);
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
  });
