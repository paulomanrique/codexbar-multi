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
  };
  readonly browser: { cookieHeader(domain: string): Promise<string> };
  readonly env: { timeZone?: string };
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
  readonly kind: "api" | "web";
  readonly fetchUsage: (context: ProviderContext) => Promise<ProviderSnapshot>;
}

export interface FirstPartyProvider extends ProviderStrategy {
  readonly descriptor: ProviderDescriptor;
}
import type { ProviderId } from "@codexbar/contracts";
