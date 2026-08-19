#!/usr/bin/env node
import {
  PROVIDERS,
  fetchProviderUsage,
  providerDescriptor,
  type ProviderContext,
  type ProviderDescriptor,
} from "@codexbar/providers";
import { normalizeEndpoint } from "@codexbar/core";
import { makeNativeCredentialStore } from "@codexbar/platform/node";
import { Effect } from "effect";
import { discoverCodexCredential } from "./codex-credential.ts";

const maximumResponseBytes = 1024 * 1024;
const credentialStore = makeNativeCredentialStore();

function allowedOrigins(
  descriptor: ProviderDescriptor,
  setting: (key: string) => string | undefined,
): Set<string> {
  const origins = new Set<string>();
  for (const endpoint of descriptor.endpoints) {
    if (typeof endpoint === "string") {
      origins.add(new URL(endpoint).origin);
      continue;
    }
    const configured = setting(endpoint.setting);
    if (configured === undefined) continue;
    const transport =
      endpoint.policy === "https"
        ? "https-only"
        : endpoint.policy === "https-or-loopback-http"
          ? "loopback-http"
          : "private-network-http";
    const normalized = normalizeEndpoint(configured, { transport });
    if (normalized !== undefined) origins.add(normalized.origin);
  }
  return origins;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes)
    throw new Error("Provider response exceeded 1 MiB");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumResponseBytes) {
      await reader.cancel("response limit exceeded");
      throw new Error("Provider response exceeded 1 MiB");
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function providerContext(descriptor: ProviderDescriptor): ProviderContext {
  const codexCredential = descriptor.id === "codex" ? discoverCodexCredential() : undefined;
  const setting = (key: string) => {
    const environment =
      process.env[key] ??
      process.env[`CODEXBAR_MULTI_${descriptor.id.toUpperCase().replaceAll("-", "_")}_${key}`];
    if (environment !== undefined) return environment;
    if (key === "CODEX_ACCESS_TOKEN") return codexCredential?.accessToken;
    if (key === "CODEX_ACCOUNT_ID") return codexCredential?.accountId;
    return undefined;
  };
  const origins = allowedOrigins(descriptor, setting);
  const request = async (
    method: "GET" | "POST",
    url: string,
    options: Record<string, unknown> = {},
    parseJson = false,
  ) => {
    if (!origins.has(new URL(url).origin))
      throw new Error(`Provider endpoint is not declared: ${new URL(url).origin}`);
    const headers = new Headers(options.headers as HeadersInit | undefined);
    if (descriptor.auth !== undefined) {
      const secret = setting(
        descriptor.id === "openrouter" && options.openRouterManagementAuth === true
          ? "OPENROUTER_MANAGEMENT_API_KEY"
          : descriptor.auth.secret,
      );
      if (secret === undefined || secret === "")
        throw new Error(`Missing credential ${descriptor.auth.secret}`);
      const header =
        descriptor.auth.type === "x-api-key"
          ? "X-API-Key"
          : descriptor.auth.type === "header"
            ? (descriptor.auth.header ?? "Authorization")
            : "Authorization";
      if (headers.has(header)) throw new Error("Provider code may not override its auth header");
      const value =
        descriptor.auth.type === "bearer"
          ? `Bearer ${secret}`
          : descriptor.auth.type === "authorization-scheme"
            ? `${descriptor.auth.scheme} ${secret}`
            : secret;
      headers.set(header, value);
    }
    const requestedTimeout =
      typeof options.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds)
        ? options.timeoutSeconds * 1_000
        : 15_000;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1_000, Math.min(30_000, requestedTimeout)),
    );
    try {
      const response = await fetch(url, {
        method,
        headers,
        redirect: "error",
        signal: controller.signal,
        ...(method === "POST" && options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
      const body = await boundedBody(response);
      const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(body);
      return {
        status: response.status,
        bodyText,
        json: parseJson ? (JSON.parse(bodyText) as unknown) : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    settings: { get: setting, getSecret: setting },
    http: {
      get: async (url, options) => request("GET", url, options),
      getJSON: async (url, options) => request("GET", url, options, true),
      postJSON: async (url, options) => request("POST", url, options, true),
    },
    browser: {
      cookieHeader: async () => {
        const manual =
          process.env[`CODEXBAR_MULTI_${descriptor.id.toUpperCase().replaceAll("-", "_")}_COOKIE`];
        if (manual !== undefined) return manual;
        const encoded = await Effect.runPromise(
          credentialStore.read(`browser-session/${descriptor.id}/default`),
        );
        if (encoded === undefined)
          throw new Error("No exported desktop credential or manual cookie is available");
        const parsed = JSON.parse(encoded) as { readonly cookieHeader?: unknown };
        if (typeof parsed.cookieHeader !== "string" || parsed.cookieHeader === "")
          throw new Error("Stored browser credential is invalid");
        return parsed.cookieHeader;
      },
    },
    env: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    date: {
      now: () => new Date(),
      nowMillis: () => Date.now(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: (_timeZone, hour) => {
        const next = new Date();
        next.setUTCHours(hour, 0, 0, 0);
        if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
        return next.toISOString();
      },
    },
    format: {
      number: (value, options) =>
        new Intl.NumberFormat("en-US", options as Intl.NumberFormatOptions).format(value),
      usd: (value) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value),
      monthDay: (value) =>
        new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(value),
    },
    pct: (used, limit) => (limit <= 0 ? 0 : Math.max(0, Math.min(100, (used / limit) * 100))),
    amountFromPercent: (usedPercent, limit) =>
      (Math.max(0, usedPercent) / 100) * Math.max(0, limit),
    fail: {
      authenticationExpired: (message) => new Error(`authentication-expired: ${message}`),
      missingCredential: (message) => new Error(`missing-credential: ${message}`),
      permissionDenied: (message) => new Error(`permission-denied: ${message}`),
      rateLimited: (message) => new Error(`rate-limited: ${message}`),
      providerUnavailable: (message) => new Error(`provider-unavailable: ${message}`),
      parseFailure: (message) => new Error(`parse-failure: ${message}`),
      networkFailure: (message) => new Error(`network-failure: ${message}`),
      apiFailure: (message) => new Error(`api-failure: ${message}`),
    },
  };
}

function usage(): never {
  console.error(
    "Usage: codexbar-multi usage [provider] [--json]\n       codexbar-multi providers [--json]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, providerId] = process.argv.slice(2).filter((argument) => argument !== "--json");
  const json = process.argv.includes("--json");
  if (command === "providers") {
    const rows = PROVIDERS.map(({ id, name, status }) => ({ id, name, status }));
    console.log(
      json
        ? JSON.stringify(rows, null, 2)
        : rows.map((row) => `${row.id}\t${row.status}\t${row.name}`).join("\n"),
    );
    return;
  }
  if (command !== "usage" || providerId === undefined) usage();
  const descriptor = providerDescriptor(providerId);
  if (descriptor === undefined) throw new Error(`Unknown provider: ${providerId}`);
  if (descriptor.strategy === undefined)
    throw new Error(`Provider '${providerId}' is mapped but not ported yet`);
  const snapshot = await fetchProviderUsage(descriptor.id, providerContext(descriptor));
  console.log(
    json
      ? JSON.stringify({ provider: providerId, snapshot }, null, 2)
      : `${descriptor.name}\n${JSON.stringify(snapshot, null, 2)}`,
  );
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
