import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexCredential {
  readonly accessToken?: string;
  readonly accountId?: string;
}

export function accountIdFromJwt(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth === "object" && auth !== null && "chatgpt_account_id" in auth) {
      const accountId = auth.chatgpt_account_id;
      return typeof accountId === "string" && accountId !== "" ? accountId : undefined;
    }
    return typeof payload.chatgpt_account_id === "string" ? payload.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

export function discoverCodexCredential(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
    readonly read?: (path: string) => string;
  } = {},
): CodexCredential {
  const environment = options.environment ?? process.env;
  const authPath = join(
    environment.CODEX_HOME ?? join(options.homeDirectory ?? homedir(), ".codex"),
    "auth.json",
  );
  try {
    const source = JSON.parse(
      (options.read ?? ((path) => readFileSync(path, "utf8")))(authPath),
    ) as Record<string, unknown>;
    const tokens =
      typeof source.tokens === "object" && source.tokens !== null
        ? (source.tokens as Record<string, unknown>)
        : {};
    const access = tokens.access_token ?? tokens.accessToken ?? source.OPENAI_API_KEY;
    const idToken = tokens.id_token ?? tokens.idToken;
    const configuredAccount = tokens.account_id ?? tokens.accountId;
    const accessToken = typeof access === "string" && access !== "" ? access : undefined;
    const accountId =
      typeof configuredAccount === "string" && configuredAccount !== ""
        ? configuredAccount
        : accountIdFromJwt(typeof idToken === "string" ? idToken : accessToken);
    return {
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(accountId === undefined ? {} : { accountId }),
    };
  } catch {
    return {};
  }
}
