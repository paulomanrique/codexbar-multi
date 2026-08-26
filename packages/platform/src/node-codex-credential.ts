import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveNodeCodexHome } from "./node-codex-home.ts";

export interface NodeCodexCredential {
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly personalAccessToken?: string;
}

export interface ParsedNodeCodexAuth {
  readonly credential: NodeCodexCredential;
  readonly email?: string;
  readonly plan?: string;
}

const jwtPayload = (token: string | undefined): Record<string, unknown> | undefined => {
  if (token === undefined) return undefined;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export function accountIdFromJwt(token: string | undefined): string | undefined {
  const payload = jwtPayload(token);
  if (payload !== undefined) {
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
  }
  return undefined;
}

export function parseNodeCodexAuthJson(sourceText: string): ParsedNodeCodexAuth | undefined {
  if (
    sourceText.includes("\u0000") ||
    Buffer.byteLength(sourceText, "utf8") === 0 ||
    Buffer.byteLength(sourceText, "utf8") > 1024 * 1024
  ) {
    return undefined;
  }
  try {
    const source: unknown = JSON.parse(sourceText);
    if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
    const root = source as Record<string, unknown>;
    const tokens =
      typeof root.tokens === "object" && root.tokens !== null && !Array.isArray(root.tokens)
        ? (root.tokens as Record<string, unknown>)
        : {};
    const apiKey = nonEmptyString(root.OPENAI_API_KEY);
    const oauthAccessToken = nonEmptyString(tokens.access_token ?? tokens.accessToken);
    const oauthRefreshToken = nonEmptyString(tokens.refresh_token ?? tokens.refreshToken);
    // Match the native Codex parser: OAuth is durable only as an
    // access+refresh pair. Refresh validates the source but never leaves this
    // host-side parser or crosses provider/IPC boundaries.
    const accessToken =
      apiKey ??
      (oauthAccessToken !== undefined && oauthRefreshToken !== undefined
        ? oauthAccessToken
        : undefined);
    const personalAccessToken = nonEmptyString(
      root.personal_access_token ?? root.personalAccessToken,
    );
    if (accessToken === undefined && personalAccessToken === undefined) return undefined;
    const idToken =
      apiKey === undefined && accessToken !== undefined
        ? nonEmptyString(tokens.id_token ?? tokens.idToken)
        : undefined;
    const payload = jwtPayload(idToken);
    const auth =
      payload?.["https://api.openai.com/auth"] !== null &&
      typeof payload?.["https://api.openai.com/auth"] === "object" &&
      !Array.isArray(payload?.["https://api.openai.com/auth"])
        ? (payload["https://api.openai.com/auth"] as Record<string, unknown>)
        : undefined;
    const profile =
      payload?.["https://api.openai.com/profile"] !== null &&
      typeof payload?.["https://api.openai.com/profile"] === "object" &&
      !Array.isArray(payload?.["https://api.openai.com/profile"])
        ? (payload["https://api.openai.com/profile"] as Record<string, unknown>)
        : undefined;
    const configuredAccount =
      accessToken === undefined ? undefined : nonEmptyString(tokens.account_id ?? tokens.accountId);
    const accountId =
      apiKey === undefined
        ? (configuredAccount ?? accountIdFromJwt(idToken) ?? accountIdFromJwt(accessToken))
        : undefined;
    const email = nonEmptyString(payload?.email ?? profile?.email)?.toLowerCase();
    const plan = nonEmptyString(auth?.chatgpt_plan_type ?? payload?.chatgpt_plan_type);
    return {
      credential: {
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(personalAccessToken === undefined ? {} : { personalAccessToken }),
      },
      ...(email === undefined ? {} : { email }),
      ...(plan === undefined ? {} : { plan }),
    };
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
    return parseNodeCodexAuthJson(sourceText)?.credential ?? {};
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
