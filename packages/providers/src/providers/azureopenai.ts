import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { status, string } from "./_http.ts";

const defaultAPIVersion = "2024-10-21";

const clean = (value: string | undefined): string | undefined => {
  let result = value?.trim();
  if (!result) return undefined;
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1).trim();
  }
  return result || undefined;
};

/** Swift's ProviderEndpointOverrideValidator.normalizedHTTPSURL, scoped to Azure's HTTPS policy. */
const endpointURL = (raw: string): URL | undefined => {
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
      return undefined;
    return url;
  } catch {
    return undefined;
  }
};

const appendPath = (url: URL, components: readonly string[]): URL => {
  const existing = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const expected = components.map((part) => part.toLowerCase());
  let shared = 0;
  for (let count = Math.min(existing.length, expected.length); count > 0; count -= 1) {
    if (existing.slice(-count).join("/") === expected.slice(0, count).join("/")) {
      shared = count;
      break;
    }
  }
  const result = new URL(url);
  const base = result.pathname.replace(/\/+$/u, "");
  const suffix = components.slice(shared).map(encodeURIComponent).join("/");
  result.pathname = `${base}/${suffix}`.replace(/\/+/gu, "/");
  return result;
};

const validationURL = (endpoint: URL, deployment: string, apiVersion: string): URL => {
  if (apiVersion.toLowerCase() === "v1")
    return appendPath(endpoint, ["openai", "v1", "chat", "completions"]);
  const url = appendPath(endpoint, ["openai", "deployments", deployment, "chat", "completions"]);
  url.searchParams.set("api-version", apiVersion);
  return url;
};

const definition: ProviderDefinition = {
  id: "azureopenai",
  name: "Azure OpenAI",
  endpoints: [{ setting: "AZURE_OPENAI_ENDPOINT", policy: "https" }],
  auth: { type: "header", secret: "AZURE_OPENAI_API_KEY", header: "api-key" },
  settings: [
    { key: "AZURE_OPENAI_API_KEY", title: "API key", type: "secure" },
    { key: "AZURE_OPENAI_ENDPOINT", title: "Endpoint", type: "plain" },
    { key: "AZURE_OPENAI_DEPLOYMENT_NAME", title: "Deployment", type: "plain" },
    { key: "AZURE_OPENAI_API_VERSION", title: "API version", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const apiKey = clean(ctx.settings.getSecret("AZURE_OPENAI_API_KEY"));
    const endpoint = clean(ctx.settings.get("AZURE_OPENAI_ENDPOINT"));
    const deployment = clean(ctx.settings.get("AZURE_OPENAI_DEPLOYMENT_NAME"));
    if (!apiKey) throw ctx.fail.missingCredential("Azure OpenAI API key is not configured.");
    if (!endpoint) throw ctx.fail.missingCredential("Azure OpenAI endpoint is not configured.");
    if (!deployment) throw ctx.fail.missingCredential("Azure OpenAI deployment not configured.");
    const url = endpointURL(endpoint);
    if (!url) throw ctx.fail.apiFailure("AZURE_OPENAI_ENDPOINT must be an HTTPS endpoint.");
    const apiVersion = clean(ctx.settings.get("AZURE_OPENAI_API_VERSION")) ?? defaultAPIVersion;
    const response = await ctx.http.postJSON(validationURL(url, deployment, apiVersion).href, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body:
        apiVersion.toLowerCase() === "v1"
          ? {
              messages: [{ role: "user", content: "ping" }],
              model: deployment,
              max_completion_tokens: 64,
            }
          : { messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
    });
    status(ctx, "Azure OpenAI", response);
    const root = response.json;
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      throw ctx.fail.parseFailure("Azure OpenAI response must be an object.");
    }
    const model = string((root as Record<string, unknown>).model);
    return {
      primary: {
        usedPercent: 0,
        resetDescription: `Deployment: ${deployment}${model ? ` · Model: ${model}` : ""}`,
      },
      identity: { organization: url.host, loginMethod: `Deployment: ${deployment}` },
    };
  },
};

const strategy: ProviderStrategy = {
  id: "azureopenai.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};

export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const azureopenai: FirstPartyProvider = { ...strategy, descriptor };
