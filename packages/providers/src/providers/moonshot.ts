import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object } from "./_http.ts";

type MoonshotRegion = "international" | "china";
type MoonshotSettings = ProviderContext["settings"];

const cleanSetting = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  let value = raw;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  value = value.trim();
  return value === "" ? undefined : value;
};

const setting = (settings: MoonshotSettings, key: string): string | undefined =>
  cleanSetting(settings.getSecret(key)) ?? cleanSetting(settings.get(key));

export const resolveMoonshotRegion = (settings: MoonshotSettings): MoonshotRegion =>
  setting(settings, "MOONSHOT_REGION")?.toLowerCase() === "china" ? "china" : "international";

export const resolveMoonshotAPIKey = (
  settings: MoonshotSettings,
  selectedRegion: MoonshotRegion,
): string | undefined => {
  const configuredRegion = setting(settings, "CODEXBAR_MOONSHOT_API_KEY_REGION")?.toLowerCase();
  if (configuredRegion === selectedRegion) {
    const configured = setting(settings, "CODEXBAR_MOONSHOT_API_KEY");
    if (configured !== undefined) return configured;
  }
  if (resolveMoonshotRegion(settings) !== selectedRegion) return undefined;
  return setting(settings, "MOONSHOT_API_KEY") ?? setting(settings, "MOONSHOT_KEY");
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const definition: ProviderDefinition = {
  id: "moonshot",
  name: "Moonshot / Kimi Open Platform",
  endpoints: ["https://api.moonshot.ai", "https://api.moonshot.cn"],
  auth: { type: "provider-managed", secret: "MOONSHOT_API_KEY" },
  settings: [
    { key: "MOONSHOT_API_KEY", title: "API key", type: "secure" },
    { key: "MOONSHOT_KEY", title: "Legacy API key", type: "secure" },
    {
      key: "CODEXBAR_MOONSHOT_API_KEY",
      title: "Region-bound API key",
      type: "secure",
    },
    {
      key: "CODEXBAR_MOONSHOT_API_KEY_REGION",
      title: "Region-bound API key region",
      type: "plain",
    },
    { key: "MOONSHOT_REGION", title: "Region", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const selectedRegion = resolveMoonshotRegion(ctx.settings);
    const key = resolveMoonshotAPIKey(ctx.settings, selectedRegion);
    if (!key) throw ctx.fail.missingCredential("Missing Moonshot API key.");
    const host = selectedRegion === "china" ? "api.moonshot.cn" : "api.moonshot.ai";
    const response = await get(ctx, `https://${host}/v1/users/me/balance`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      timeoutSeconds: 15,
    });
    if (response.status !== 200) {
      throw ctx.fail.apiFailure(`Moonshot API returned HTTP ${response.status}.`);
    }
    const root = object(json(ctx, "Moonshot", response));
    const data = root && object(root.data);
    const code = integer(root?.code);
    const scode = typeof root?.scode === "string" ? root.scode : undefined;
    const successful = typeof root?.status === "boolean" ? root.status : undefined;
    const balance = finiteNumber(data?.available_balance);
    const voucher = finiteNumber(data?.voucher_balance);
    const cash = finiteNumber(data?.cash_balance);
    if (
      !root ||
      !data ||
      code === undefined ||
      scode === undefined ||
      successful === undefined ||
      balance === undefined ||
      voucher === undefined ||
      cash === undefined
    ) {
      throw ctx.fail.parseFailure("Moonshot balance response is missing required fields.");
    }
    if (code !== 0 || !successful) throw ctx.fail.apiFailure(`code ${code}, scode ${scode}`);
    return {
      identity: {
        loginMethod: `Balance: ${ctx.format.usd(balance)}${cash < 0 ? ` · ${ctx.format.usd(Math.abs(cash))} in deficit` : ""}`,
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "moonshot.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const moonshot: FirstPartyProvider = { ...strategy, descriptor };
