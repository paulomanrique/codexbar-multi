import type { ProviderId } from "@codexbar/contracts";

/**
 * A provider-owned, reviewable browser-login boundary. A web provider never
 * receives a BrowserWindow or a cookie jar, only an exported header for one
 * of its declared hosts.
 */
export interface BrowserLoginDescriptor {
  readonly startUrl: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly cookieDomains: readonly string[];
  readonly cookieNames: ReadonlySet<string>;
  /** Explicit support for provider cookie families whose suffix is rotated. */
  readonly cookieNamePrefixes: readonly string[];
  /** At least one of these cookies must exist before a login is connected. */
  readonly completionCookieNames: ReadonlySet<string>;
  readonly completionCookieNamePrefixes: readonly string[];
}

export interface BrowserCookieValue {
  readonly name: string;
  readonly value: string;
}

type DescriptorInput = Omit<
  BrowserLoginDescriptor,
  | "allowedOrigins"
  | "cookieNames"
  | "cookieNamePrefixes"
  | "completionCookieNames"
  | "completionCookieNamePrefixes"
> & {
  readonly allowedOrigins: readonly string[];
  readonly cookieNames?: readonly string[];
  readonly cookieNamePrefixes?: readonly string[];
  readonly completionCookieNames?: readonly string[];
  readonly completionCookieNamePrefixes?: readonly string[];
};

const descriptor = (input: DescriptorInput): BrowserLoginDescriptor => ({
  startUrl: input.startUrl,
  allowedOrigins: new Set(input.allowedOrigins),
  cookieDomains: input.cookieDomains,
  cookieNames: new Set(input.cookieNames),
  cookieNamePrefixes: input.cookieNamePrefixes ?? [],
  completionCookieNames: new Set(input.completionCookieNames),
  completionCookieNamePrefixes: input.completionCookieNamePrefixes ?? [],
});

/*
 * Login endpoints and exported cookie names are intentionally explicit. Do
 * not add a provider merely because it has a web strategy: providers that
 * require localStorage, IndexedDB, a pasted cURL capture, or an undeclared
 * bearer token remain manual until their host capability is modelled.
 */
const LOGIN_DESCRIPTORS: Readonly<Partial<Record<ProviderId, BrowserLoginDescriptor>>> = {
  t3chat: descriptor({
    startUrl: "https://t3.chat/settings/customization",
    allowedOrigins: ["https://t3.chat", "https://accounts.google.com", "https://github.com"],
    cookieDomains: ["t3.chat", "www.t3.chat"],
    cookieNames: ["__session", "__client_uat", "__clerk_db_jwt"],
    completionCookieNames: ["__session", "__clerk_db_jwt"],
  }),
  cursor: descriptor({
    startUrl: "https://www.cursor.com/settings",
    allowedOrigins: [
      "https://cursor.com",
      "https://www.cursor.com",
      "https://authenticator.cursor.sh",
    ],
    cookieDomains: ["cursor.com", "www.cursor.com"],
    cookieNames: ["WorkosCursorSessionToken"],
    completionCookieNames: ["WorkosCursorSessionToken"],
  }),
  opencode: descriptor({
    startUrl: "https://opencode.ai",
    allowedOrigins: ["https://opencode.ai"],
    cookieDomains: ["opencode.ai"],
    cookieNames: ["auth", "__Host-auth"],
    completionCookieNames: ["auth", "__Host-auth"],
  }),
  opencodego: descriptor({
    startUrl: "https://opencode.ai",
    allowedOrigins: ["https://opencode.ai"],
    cookieDomains: ["opencode.ai"],
    cookieNames: ["auth", "__Host-auth"],
    completionCookieNames: ["auth", "__Host-auth"],
  }),
  alibaba: descriptor({
    startUrl: "https://modelstudio.console.alibabacloud.com",
    allowedOrigins: [
      "https://modelstudio.console.alibabacloud.com",
      "https://bailian.console.aliyun.com",
      "https://account.aliyun.com",
    ],
    cookieDomains: ["modelstudio.console.alibabacloud.com", "bailian.console.aliyun.com"],
    cookieNames: ["login_aliyunid_ticket", "login_current_pk", "login_aliyunid_csrf", "sec_token"],
    completionCookieNames: ["login_aliyunid_ticket"],
  }),
  alibabatokenplan: descriptor({
    startUrl: "https://modelstudio.console.alibabacloud.com",
    allowedOrigins: [
      "https://modelstudio.console.alibabacloud.com",
      "https://bailian.console.aliyun.com",
      "https://account.aliyun.com",
    ],
    cookieDomains: ["modelstudio.console.alibabacloud.com", "bailian.console.aliyun.com"],
    cookieNames: ["login_aliyunid_ticket", "login_current_pk", "login_aliyunid_csrf", "sec_token"],
    completionCookieNames: ["login_aliyunid_ticket"],
  }),
  qwencloud: descriptor({
    startUrl: "https://home.qwencloud.com",
    allowedOrigins: ["https://home.qwencloud.com", "https://account.aliyun.com"],
    cookieDomains: ["home.qwencloud.com", "cs-data.qwencloud.com", "qwencloud.com"],
    cookieNames: [
      "login_aliyunid_ticket",
      "qwen_sso_ticket",
      "login_qwencloud_ticket",
      "login_current_pk",
      "login_aliyunid_csrf",
      "sec_token",
    ],
    completionCookieNames: ["login_aliyunid_ticket", "qwen_sso_ticket", "login_qwencloud_ticket"],
  }),
  kimi: descriptor({
    startUrl: "https://www.kimi.com/code/console",
    allowedOrigins: ["https://www.kimi.com", "https://kimi.com"],
    cookieDomains: ["www.kimi.com"],
    cookieNames: ["kimi-auth"],
    completionCookieNames: ["kimi-auth"],
  }),
  ollama: descriptor({
    startUrl: "https://ollama.com/settings",
    allowedOrigins: ["https://ollama.com", "https://www.ollama.com", "https://signin.ollama.com"],
    cookieDomains: ["ollama.com", "www.ollama.com"],
    cookieNames: ["__Secure-session", "ollama_session", "__Host-ollama_session"],
    completionCookieNames: ["__Secure-session", "ollama_session", "__Host-ollama_session"],
  }),
  mimo: descriptor({
    startUrl: "https://platform.xiaomimimo.com/#/console/balance",
    allowedOrigins: ["https://platform.xiaomimimo.com", "https://account.xiaomi.com"],
    cookieDomains: ["platform.xiaomimimo.com", "xiaomimimo.com"],
    cookieNames: ["api-platform_serviceToken", "userId"],
    completionCookieNames: ["api-platform_serviceToken", "userId"],
  }),
  mistral: descriptor({
    startUrl: "https://admin.mistral.ai",
    allowedOrigins: [
      "https://admin.mistral.ai",
      "https://console.mistral.ai",
      "https://auth.mistral.ai",
    ],
    cookieDomains: ["admin.mistral.ai", "console.mistral.ai"],
    cookieNames: ["csrftoken"],
    cookieNamePrefixes: ["ory_session_"],
    completionCookieNamePrefixes: ["ory_session_"],
  }),
  commandcode: descriptor({
    startUrl: "https://commandcode.ai",
    allowedOrigins: ["https://commandcode.ai", "https://www.commandcode.ai"],
    cookieDomains: ["commandcode.ai", "www.commandcode.ai"],
    cookieNames: ["__Secure-better-auth.session_token"],
    cookieNamePrefixes: ["__Secure-commandcode_"],
    completionCookieNames: ["__Secure-better-auth.session_token"],
    completionCookieNamePrefixes: ["__Secure-commandcode_"],
  }),
  longcat: descriptor({
    startUrl: "https://longcat.chat/platform/usage",
    allowedOrigins: ["https://longcat.chat", "https://www.longcat.chat"],
    cookieDomains: ["longcat.chat"],
    cookieNames: ["passport_token", "uid", "session"],
    completionCookieNames: ["passport_token", "session"],
  }),
  notion: descriptor({
    startUrl: "https://app.notion.com",
    allowedOrigins: ["https://app.notion.com", "https://www.notion.com", "https://notion.com"],
    cookieDomains: ["app.notion.com", "www.notion.com", "notion.com", "notion.so"],
    cookieNames: ["token_v2"],
    completionCookieNames: ["token_v2"],
  }),
  claude: descriptor({
    startUrl: "https://claude.ai",
    allowedOrigins: ["https://claude.ai", "https://www.claude.ai", "https://accounts.google.com"],
    cookieDomains: ["claude.ai"],
    cookieNames: ["sessionKey"],
    completionCookieNames: ["sessionKey"],
  }),
};

export const browserLoginDescriptor = (provider: ProviderId): BrowserLoginDescriptor | undefined =>
  LOGIN_DESCRIPTORS[provider];

export const browserLoginProviders = (): readonly ProviderId[] =>
  Object.keys(LOGIN_DESCRIPTORS).sort() as ProviderId[];

export function isAllowedBrowserLoginNavigation(
  descriptor: BrowserLoginDescriptor,
  rawUrl: string,
): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && descriptor.allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

const matchesName = (name: string, exactNames: ReadonlySet<string>, prefixes: readonly string[]) =>
  exactNames.has(name) || prefixes.some((prefix) => name.startsWith(prefix));

const containsCookieDelimiterOrControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === ";" || code <= 0x1f || code === 0x7f;
  });

/**
 * Produce the only credential material that may leave an isolated Electron
 * partition. Unknown cookies are discarded before the native keyring write.
 */
export function exportableCookieHeader(
  descriptor: BrowserLoginDescriptor,
  cookies: readonly BrowserCookieValue[],
): string | undefined {
  const selected = new Map<string, string>();
  let hasCompletionCookie = false;
  for (const cookie of cookies) {
    if (
      cookie.value.length === 0 ||
      cookie.value.length > 4_096 ||
      containsCookieDelimiterOrControl(cookie.value) ||
      !matchesName(cookie.name, descriptor.cookieNames, descriptor.cookieNamePrefixes)
    )
      continue;
    selected.set(cookie.name, cookie.value);
    hasCompletionCookie ||=
      descriptor.completionCookieNames.has(cookie.name) ||
      descriptor.completionCookieNamePrefixes.some((prefix) => cookie.name.startsWith(prefix));
  }
  if (!hasCompletionCookie) return undefined;
  const header = [...selected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return header.length <= 32_768 ? header : undefined;
}
