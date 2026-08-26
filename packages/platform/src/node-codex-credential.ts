import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveNodeCodexHome } from "./node-codex-home.ts";

export interface NodeCodexCredential {
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly personalAccessToken?: string;
}

export function accountIdFromJwt(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const direct = nonEmptyString(payload.chatgpt_account_id);
    if (direct !== undefined) return direct;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth === "object" && auth !== null && "chatgpt_account_id" in auth) {
      const accountId = nonEmptyString(auth.chatgpt_account_id);
      if (accountId !== undefined) return accountId;
    }
    if (Array.isArray(payload.organizations)) {
      for (const organization of payload.organizations) {
        if (typeof organization !== "object" || organization === null) continue;
        const accountId = nonEmptyString((organization as Record<string, unknown>).id);
        if (accountId !== undefined) return accountId;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function discoverNodeCodexCredential(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
    readonly read?: (path: string) => string;
  } = {},
): NodeCodexCredential {
  const environment = options.environment ?? process.env;
  const authPath = join(
    resolveNodeCodexHome(environment, options.homeDirectory ?? homedir()),
    "auth.json",
  );
  try {
    const sourceText =
      options.read === undefined ? readPrivateAuthFile(authPath) : options.read(authPath);
    const source = JSON.parse(sourceText) as Record<string, unknown>;
    if (typeof source !== "object" || source === null || Array.isArray(source)) return {};
    const tokens =
      typeof source.tokens === "object" && source.tokens !== null && !Array.isArray(source.tokens)
        ? (source.tokens as Record<string, unknown>)
        : {};
    const apiKey = nonEmptyString(source.OPENAI_API_KEY);
    const access = apiKey ?? tokens.access_token ?? tokens.accessToken;
    const idToken = tokens.id_token ?? tokens.idToken;
    const configuredAccount = tokens.account_id ?? tokens.accountId;
    const accessToken = nonEmptyString(access);
    const personalAccessToken = nonEmptyString(
      source.personal_access_token ?? source.personalAccessToken,
    );
    const accountId =
      apiKey === undefined
        ? (nonEmptyString(configuredAccount) ??
          accountIdFromJwt(typeof idToken === "string" ? idToken : undefined) ??
          accountIdFromJwt(accessToken))
        : undefined;
    return {
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(personalAccessToken === undefined ? {} : { personalAccessToken }),
    };
  } catch {
    return {};
  }
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const readPrivateAuthFile = (path: string): string => {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Codex auth file is not regular");
  if (info.size > 1024n * 1024n) throw new Error("Codex auth file exceeds 1 MiB");
  return readFileSync(path, "utf8");
};
