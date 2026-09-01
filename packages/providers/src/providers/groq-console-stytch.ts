import type { ProviderContext, ProviderResponse } from "../types.ts";

export const GROQ_STYTCH_DEFAULT_PUBLIC_TOKEN =
  "public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f";
export const GROQ_STYTCH_PUBLIC_TOKEN_KEY = "GROQ_STYTCH_PUBLIC_TOKEN";
export const GROQ_STYTCH_URL_KEY = "GROQ_STYTCH_URL";
export const GROQ_SESSION_JWT_KEY = "GROQ_SESSION_JWT";
export const GROQ_SESSION_TOKEN_KEY = "GROQ_SESSION_TOKEN";

const GROQ_STYTCH_DEFAULT_BASE_URL = "https://api.stytchb2b.groq.com";
const GROQ_CONSOLE_ORIGIN = "https://console.groq.com";
const GROQ_STYTCH_SDK_VERSION = "5.43.0";
const AUTHENTICATE_PATH = "/sdk/v1/b2b/sessions/authenticate";

export class InvalidGroqConsoleStytchSession extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGroqConsoleStytchSession";
  }
}

export interface GroqConsoleJWTSessionInfo {
  readonly sessionToken?: string;
  readonly directJWT?: string;
  readonly sourceLabel: string;
}

const compact = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

const utf8Base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export const groqConsoleStytchSDKClientHeader = (): string =>
  utf8Base64(
    JSON.stringify({
      app: { identifier: "console.groq.com" },
      sdk: {
        identifier: "Stytch.js Javascript SDK",
        version: GROQ_STYTCH_SDK_VERSION,
      },
    }),
  );

export const resolveGroqConsoleStytchEndpoint = (baseURL: string): URL => {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new InvalidGroqConsoleStytchSession("invalid Stytch URL");
  }

  if (url.protocol !== "https:") {
    throw new InvalidGroqConsoleStytchSession("Stytch URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new InvalidGroqConsoleStytchSession("Stytch URL must not include credentials");
  }
  if (url.search || url.hash) {
    throw new InvalidGroqConsoleStytchSession("Stytch URL must not include query or fragment");
  }

  const pathPrefix = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${pathPrefix}${AUTHENTICATE_PATH}`;
  return url;
};

const parseSessionJWT = (ctx: ProviderContext, response: ProviderResponse): string => {
  let payload: unknown;
  try {
    payload = JSON.parse(response.bodyText) as unknown;
  } catch {
    throw ctx.fail.parseFailure("Groq Stytch response was not valid JSON.");
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw ctx.fail.parseFailure("Groq Stytch response must be an object.");
  }
  const data = (payload as { readonly data?: unknown }).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw ctx.fail.parseFailure("Groq Stytch response missing data.");
  }
  const jwt = (data as { readonly session_jwt?: unknown }).session_jwt;
  if (typeof jwt !== "string" || !jwt.trim()) {
    throw ctx.fail.parseFailure("Groq Stytch response missing session_jwt.");
  }
  return jwt.trim();
};

const stytchFailureSummary = (response: ProviderResponse): string =>
  response.bodyText.trim().slice(0, 300);

const postStytch = async (
  ctx: ProviderContext,
  url: URL,
  options: Record<string, unknown>,
): Promise<ProviderResponse> => {
  if (ctx.http.post === undefined) {
    throw ctx.fail.apiFailure("Groq Stytch refresh requires raw POST support.");
  }
  try {
    return await ctx.http.post(url.href, options);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof Error) throw ctx.fail.networkFailure(error.message);
    throw ctx.fail.networkFailure(String(error));
  }
};

export const refreshGroqConsoleSessionJWT = async (
  ctx: ProviderContext,
  sessionToken: string,
): Promise<string> => {
  const token = compact(sessionToken);
  if (token === undefined) throw ctx.fail.missingCredential("Missing Groq console session.");

  const publicToken =
    compact(ctx.settings.get(GROQ_STYTCH_PUBLIC_TOKEN_KEY)) ?? GROQ_STYTCH_DEFAULT_PUBLIC_TOKEN;
  const baseURL = compact(ctx.settings.get(GROQ_STYTCH_URL_KEY)) ?? GROQ_STYTCH_DEFAULT_BASE_URL;
  let endpoint: URL;
  try {
    endpoint = resolveGroqConsoleStytchEndpoint(baseURL);
  } catch (error) {
    if (error instanceof Error) throw ctx.fail.apiFailure(error.message);
    throw ctx.fail.apiFailure("invalid Stytch URL");
  }

  const response = await postStytch(ctx, endpoint, {
    headers: {
      Authorization: `Basic ${utf8Base64(`${publicToken}:${token}`)}`,
      "Content-Type": "application/json",
      Origin: GROQ_CONSOLE_ORIGIN,
      "X-SDK-Parent-Host": GROQ_CONSOLE_ORIGIN,
      "X-SDK-Client": groqConsoleStytchSDKClientHeader(),
    },
    body: JSON.stringify({
      session_token: token,
      session_duration_minutes: 30,
    }),
    timeoutSeconds: 20,
  });

  if (response.status === 401 || response.status === 403) {
    const summary = stytchFailureSummary(response);
    throw ctx.fail.authenticationExpired(
      summary
        ? `Groq Stytch authentication failed: ${summary}`
        : "Groq Stytch authentication failed.",
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const summary = stytchFailureSummary(response);
    throw ctx.fail.apiFailure(
      summary
        ? `Groq Stytch API returned HTTP ${response.status}: ${summary}`
        : `Groq Stytch API returned HTTP ${response.status}.`,
    );
  }

  return parseSessionJWT(ctx, response);
};

export const resolveGroqConsoleJWT = async (
  ctx: ProviderContext,
  session: GroqConsoleJWTSessionInfo,
): Promise<string> => {
  const token = compact(session.sessionToken);
  if (token !== undefined) {
    try {
      return await refreshGroqConsoleSessionJWT(ctx, token);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const jwt = compact(session.directJWT);
      if (jwt !== undefined) return jwt;
      throw error;
    }
  }

  const jwt = compact(session.directJWT);
  if (jwt !== undefined) return jwt;
  throw ctx.fail.missingCredential("Missing Groq console session.");
};

export const groqConsoleEnvironmentSession = (
  ctx: ProviderContext,
): GroqConsoleJWTSessionInfo | undefined => {
  const token = compact(
    ctx.settings.getSecret(GROQ_SESSION_TOKEN_KEY) ?? ctx.settings.get(GROQ_SESSION_TOKEN_KEY),
  );
  const jwt = compact(
    ctx.settings.getSecret(GROQ_SESSION_JWT_KEY) ?? ctx.settings.get(GROQ_SESSION_JWT_KEY),
  );
  if (token !== undefined) {
    return {
      sessionToken: token,
      ...(jwt === undefined ? {} : { directJWT: jwt }),
      sourceLabel: "env",
    };
  }
  if (jwt !== undefined) {
    return { directJWT: jwt, sourceLabel: "env" };
  }
  return undefined;
};
