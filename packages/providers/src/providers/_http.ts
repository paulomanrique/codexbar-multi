import type { ProviderContext, ProviderResponse } from "../types.ts";

export type JsonObject = { readonly [key: string]: unknown };
export const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
export const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
export const number = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
export const date = (value: unknown, ctx: ProviderContext): string | undefined => {
  const n = number(value);
  if (n !== undefined) return n > 10_000_000_000 ? ctx.date.unixMillis(n) : ctx.date.unixSeconds(n);
  return string(value) ? ctx.date.iso(string(value) as string) : undefined;
};
export async function get(
  ctx: ProviderContext,
  url: string,
  options?: Record<string, unknown>,
): Promise<ProviderResponse> {
  try {
    return await ctx.http.get(url, options);
  } catch (error) {
    throw ctx.fail.networkFailure(error instanceof Error ? error.message : String(error));
  }
}
export function status(ctx: ProviderContext, provider: string, response: ProviderResponse): void {
  if (response.status === 401)
    throw ctx.fail.authenticationExpired(`${provider} rejected the API key.`);
  if (response.status === 403) throw ctx.fail.permissionDenied(`${provider} denied access.`);
  if (response.status === 429) throw ctx.fail.rateLimited(`${provider} API returned HTTP 429.`);
  if (response.status >= 500)
    throw ctx.fail.providerUnavailable(`${provider} API returned HTTP ${response.status}.`);
  if (response.status < 200 || response.status >= 300)
    throw ctx.fail.apiFailure(`${provider} API returned HTTP ${response.status}.`);
}
export function json(ctx: ProviderContext, provider: string, response: ProviderResponse): unknown {
  try {
    return JSON.parse(response.bodyText) as unknown;
  } catch {
    throw ctx.fail.parseFailure(`${provider} response was not valid JSON.`);
  }
}
export const pct = (used: number, limit: number): number =>
  limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 100;
export const base = (value: string | undefined, fallback: string): string =>
  (value || fallback).replace(/\/+$/, "");
