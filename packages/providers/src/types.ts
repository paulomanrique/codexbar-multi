/** Commands exposed to first-party providers by the local host broker. */
export type ProviderLocalCommand = "amp" | "kiro-cli";

/** Named, read-only local data sources. Providers never receive a filesystem API. */
export type ProviderLocalData = "jetbrains-ai-quota";

export interface ProviderLocalProcessResult {
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProviderLocalDataResult {
  readonly text: string;
  /** Host-derived metadata only; a filesystem path is deliberately never returned. */
  readonly label?: string;
}

/**
 * Deliberately narrow local capability broker. It is not a process or
 * filesystem API: every command and data source is an allowlisted symbolic
 * identifier, validated again by the platform host.
 */
export interface ProviderLocalCapabilities {
  readonly run: (
    command: ProviderLocalCommand,
    request: { readonly args: readonly string[]; readonly timeoutMs?: number },
  ) => Promise<ProviderLocalProcessResult>;
  readonly readData: (
    source: ProviderLocalData,
    request?: { readonly basePath?: string },
  ) => Promise<ProviderLocalDataResult | undefined>;
}

/** Small, platform-neutral host surface used by first-party providers. */
export interface ProviderContext {
  readonly settings: {
    get(key: string): string | undefined;
    getSecret(key: string): string | undefined;
  };
  readonly http: {
    get(url: string, options?: Record<string, unknown>): Promise<ProviderResponse>;
    getJSON(url: string, options?: Record<string, unknown>): Promise<ProviderJSONResponse>;
    postJSON(url: string, options?: Record<string, unknown>): Promise<ProviderJSONResponse>;
    /**
     * Bounded binary POST used only by non-JSON upstream protocols such as
     * gRPC-web.  Providers never receive a general transport or `fetch`.
     * Optional so parser-only test contexts do not gain privileged behavior.
     */
    postBinary?(
      url: string,
      options: {
        readonly body: Uint8Array;
        readonly headers?: Readonly<Record<string, string>>;
        readonly timeoutSeconds?: number;
      },
    ): Promise<ProviderBinaryResponse>;
  };
  readonly browser: { cookieHeader(domain: string): Promise<string> };
  /** Omitted in direct parser tests; composed runtimes always provide a fail-closed broker. */
  readonly local?: ProviderLocalCapabilities;
  readonly env: { timeZone?: string };
  /**
   * The host-selected source mode. Providers use it only to choose between
   * their declared strategies; it never grants a host capability.
   */
  readonly sourceMode?: "auto" | "web" | "cli" | "oauth" | "api";
  readonly date: {
    now(): Date;
    nowMillis(): number;
    iso(value: string): string;
    unixSeconds(value: number): string;
    unixMillis(value: number): string;
    nextDailyReset(timeZone: string, hour: number): string;
  };
  readonly format: {
    number(value: number, options?: Record<string, unknown>): string;
    usd(value: number): string;
    monthDay(value: Date): string;
  };
  readonly pct: (used: number, limit: number) => number;
  readonly amountFromPercent: (usedPercent: number, limit: number) => number;
  readonly __codexbarOptionalRequestTimeoutSeconds?: number;
  readonly fail: ProviderFailures;
}

export interface ProviderResponse {
  readonly status: number;
  readonly bodyText: string;
}

export interface ProviderJSONResponse extends ProviderResponse {
  readonly json: any;
}

export interface ProviderBinaryResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type ProviderSnapshot = Record<string, unknown>;

export interface ProviderFailures {
  readonly authenticationExpired: (message: string) => Error;
  readonly missingCredential: (message: string) => Error;
  readonly permissionDenied: (message: string) => Error;
  readonly rateLimited: (message: string) => Error;
  readonly providerUnavailable: (message: string) => Error;
  readonly parseFailure: (message: string) => Error;
  readonly networkFailure: (message: string) => Error;
  readonly apiFailure: (message: string) => Error;
}

export interface ProviderSetting {
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly type: "plain" | "secure";
}

export type ProviderEndpoint =
  | string
  | {
      readonly setting: string;
      readonly policy: "https" | "https-or-loopback-http" | "https-or-private-network-http";
      /** Safe provider-owned default; renderer input never controls this value. */
      readonly default?: string;
    }
  | {
      /** Allow only this exact DNS suffix (or a direct host), never a wildcard. */
      readonly domainSuffix: string;
      readonly policy: "https";
    };

export interface ProviderAuth {
  readonly type: "bearer" | "x-api-key" | "header" | "authorization-scheme" | "provider-managed";
  readonly secret: string;
  readonly scheme?: string;
  readonly header?: string;
}

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly name: string;
  readonly status: "partial" | "unported";
  /** Mirrors ProviderMetadata.isPrimaryProvider for CLI `--provider both` selection. */
  readonly isPrimaryProvider?: boolean;
  readonly endpoints: readonly ProviderEndpoint[];
  readonly auth?: ProviderAuth;
  readonly settings: readonly ProviderSetting[];
  readonly capabilities?: readonly ("browser-cookies" | "http-status")[];
  readonly cookieDomains?: readonly string[];
  readonly strategy?: ProviderStrategy;
}

/** Authoring shape for a first-party manifest before registry-only fields are attached. */
export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly name: string;
  readonly endpoints: readonly ProviderEndpoint[];
  readonly auth?: ProviderAuth;
  readonly settings: readonly ProviderSetting[];
  readonly capabilities?: readonly ("browser-cookies" | "http-status")[];
  readonly cookieDomains?: readonly string[];
  readonly fetchUsage: (context: ProviderContext) => Promise<ProviderSnapshot>;
}

export interface ProviderStrategy {
  readonly id: string;
  readonly kind: "api" | "web" | "cli" | "local";
  readonly fetchUsage: (context: ProviderContext) => Promise<ProviderSnapshot>;
}

export interface FirstPartyProvider extends ProviderStrategy {
  readonly descriptor: ProviderDescriptor;
}
import type { ProviderId } from "@codexbar/contracts";
