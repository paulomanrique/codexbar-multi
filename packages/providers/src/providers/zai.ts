import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";

type ZaiRegion = "global" | "bigmodel-cn";

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

/** Mirrors Swift's ProviderEndpointOverrideValidator.normalizedHTTPSURL. */
const normalizedHTTPSURL = (raw: string | undefined): URL | undefined => {
  const value = clean(raw);
  if (
    !value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
    })
  )
    return undefined;
  const candidate = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
      return undefined;
    return url;
  } catch {
    return undefined;
  }
};

const endpointOverride = (
  ctx: ProviderContext,
  key: string,
  region: ZaiRegion,
  knownRegionHosts: readonly string[],
): string | undefined => {
  const raw = clean(ctx.settings.get(key));
  if (!raw) return undefined;
  const url = normalizedHTTPSURL(raw);
  if (!url)
    throw ctx.fail.apiFailure(`z.ai endpoint override ${key} must use HTTPS or a bare host.`);
  const host = url.hostname.toLowerCase();
  if (knownRegionHosts.includes(host)) {
    const expectedHost = region === "global" ? "api.z.ai" : "open.bigmodel.cn";
    if (host !== expectedHost) {
      throw ctx.fail.apiFailure(
        `z.ai endpoint override ${key} does not match the selected ${region} region.`,
      );
    }
  }
  return url.href;
};

const definition: ProviderDefinition = {
  id: "zai",
  name: "z.ai / GLM",
  endpoints: [
    "https://api.z.ai",
    "https://open.bigmodel.cn",
    "https://www.bigmodel.cn",
    { setting: "Z_AI_QUOTA_ENDPOINT", policy: "https" },
    { setting: "Z_AI_MODEL_USAGE_ENDPOINT", policy: "https" },
    { setting: "Z_AI_BALANCE_URL", policy: "https" },
    { setting: "Z_AI_BALANCE_ENDPOINT", policy: "https" },
  ],
  auth: { type: "bearer", secret: "Z_AI_API_KEY" },
  settings: [
    { key: "Z_AI_API_KEY", title: "API key", type: "secure" },
    { key: "Z_AI_REGION", title: "API region", type: "plain" },
    { key: "Z_AI_USAGE_SCOPE", title: "Usage scope", type: "plain" },
    { key: "Z_AI_ORGANIZATION", title: "Organization", type: "plain" },
    { key: "Z_AI_PROJECT", title: "Project", type: "plain" },
    { key: "Z_AI_QUOTA_ENDPOINT", title: "Quota endpoint", type: "plain" },
    { key: "Z_AI_MODEL_USAGE_ENDPOINT", title: "Model usage endpoint", type: "plain" },
    { key: "Z_AI_BALANCE_URL", title: "Balance URL", type: "plain" },
    { key: "Z_AI_BALANCE_ENDPOINT", title: "Balance endpoint", type: "plain" },
  ],

  fetchUsage: async (ctx: ProviderContext) => {
    const region: ZaiRegion = (ctx.settings.get("Z_AI_REGION") || "global") as ZaiRegion;
    const scope: any = ctx.settings.get("Z_AI_USAGE_SCOPE") || "personal";
    const organization: any = ctx.settings.get("Z_AI_ORGANIZATION");
    const project: any = ctx.settings.get("Z_AI_PROJECT");
    if (region !== "global" && region !== "bigmodel-cn") throw new Error("Unsupported z.ai region");
    if (scope !== "personal" && scope !== "team") throw new Error("Unsupported z.ai usage scope");
    if (scope === "team" && (!organization || !project))
      throw ctx.fail.missingCredential("z.ai team scope needs organization and project");
    const base: any = region === "bigmodel-cn" ? "https://open.bigmodel.cn" : "https://api.z.ai";
    const knownRegionHosts = ["api.z.ai", "open.bigmodel.cn"];
    const quotaEndpoint: any =
      endpointOverride(ctx, "Z_AI_QUOTA_ENDPOINT", region, knownRegionHosts) ||
      `${base}/api/monitor/usage/quota/limit`;
    const modelUsageEndpoint: any =
      // Model usage is independently proxyable in the plugin contract; only the
      // region-selecting quota endpoint participates in known-host matching.
      endpointOverride(ctx, "Z_AI_MODEL_USAGE_ENDPOINT", region, []) ||
      `${base}/api/monitor/usage/model-usage`;
    // Validate this even for the global region, matching the Swift settings reader;
    // the region gate below still ensures global never performs the optional request.
    // Z_AI_BALANCE_URL is the public Swift/environment key. The endpoint name is
    // retained for plugin/runtime compatibility, but the public key wins whenever
    // both are present (including when the public value is invalid).
    const configuredBalanceEndpoint =
      endpointOverride(ctx, "Z_AI_BALANCE_URL", region, []) ??
      endpointOverride(ctx, "Z_AI_BALANCE_ENDPOINT", region, []);
    const headers: any =
      scope === "team"
        ? { "Bigmodel-Organization": organization, "Bigmodel-Project": project }
        : {};
    function withType(url: any, value: any) {
      const parts: any = String(url).split("?");
      const query: any =
        parts.length > 1 ? parts.slice(1).join("?").split("&").filter(Boolean) : [];
      const filtered: any = query.filter(
        (item: any) => decodeURIComponent(item.split("=", 1)[0]) !== "type",
      );
      filtered.push(`type=${value}`);
      return `${parts[0]}?${filtered.join("&")}`;
    }
    const quotaURL: any = scope === "team" ? withType(quotaEndpoint, 2) : quotaEndpoint;
    const quotaResponse: any = await ctx.http.getJSON(quotaURL, { headers });
    if (quotaResponse.status !== 200)
      throw new Error(`z.ai quota API error: HTTP ${quotaResponse.status}`);
    const root: any = quotaResponse.json;
    if (
      !root ||
      typeof root !== "object" ||
      Array.isArray(root) ||
      root.success !== true ||
      root.code !== 200
    ) {
      throw new Error(`z.ai quota API error: ${root && root.msg ? root.msg : "invalid response"}`);
    }
    if (!root.data || typeof root.data !== "object" || !Array.isArray(root.data.limits)) {
      throw new Error("Failed to parse z.ai quota data");
    }

    function optionalInteger(value: any, field: any) {
      if (value === null || value === undefined) return null;
      if (!Number.isInteger(value)) throw new Error(`z.ai ${field} must be an integer`);
      return value;
    }
    function parseLimit(raw: any) {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        typeof raw.type !== "string" ||
        !Number.isInteger(raw.unit) ||
        !Number.isInteger(raw.number) ||
        !Number.isInteger(raw.percentage)
      ) {
        throw new Error("Failed to parse z.ai limit entry");
      }
      if (raw.type !== "TOKENS_LIMIT" && raw.type !== "TIME_LIMIT" && raw.type !== "CREDIT_LIMIT")
        return null;
      const usage: any = optionalInteger(raw.usage, "limit.usage");
      const current: any = optionalInteger(raw.currentValue, "limit.currentValue");
      const remaining: any = optionalInteger(raw.remaining, "limit.remaining");
      let percent: any = raw.percentage;
      if (usage !== null && usage > 0) {
        let used: any = null;
        if (remaining !== null)
          used = Math.max(usage - remaining, current === null ? usage - remaining : current);
        else if (current !== null) used = current;
        if (used !== null) percent = ctx.pct(Math.max(0, Math.min(usage, used)), usage);
      }
      percent = Math.max(0, Math.min(100, percent));
      const multipliers: any = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
      const windowMinutes: any =
        raw.number > 0 && multipliers[raw.unit] ? raw.number * multipliers[raw.unit] : null;
      const reset: any = optionalInteger(raw.nextResetTime, "limit.nextResetTime");
      const details: any =
        raw.usageDetails === null || raw.usageDetails === undefined ? [] : raw.usageDetails;
      if (!Array.isArray(details)) throw new Error("z.ai usageDetails must be an array");
      return { raw, usage, current, remaining, percent, windowMinutes, reset, details };
    }
    function window(limit: any) {
      const result: any = { usedPercent: limit.percent };
      if (limit.raw.type === "TIME_LIMIT") {
        const isMonthlyMCPMarker: any = limit.raw.unit === 5 && limit.raw.number === 1;
        if (isMonthlyMCPMarker) result.windowMinutes = 30 * 24 * 60;
        else if (limit.windowMinutes !== null) result.windowMinutes = limit.windowMinutes;
      } else if (limit.windowMinutes !== null) {
        result.windowMinutes = limit.windowMinutes;
      }
      if (limit.reset !== null) result.resetsAt = ctx.date.unixMillis(limit.reset);
      if (limit.raw.type === "TIME_LIMIT") result.resetDescription = "MCP";
      else if (limit.windowMinutes === 300) result.resetDescription = "5-hour";
      else if (limit.windowMinutes !== null) {
        const units: any = { 1: "day", 3: "hour", 5: "minute", 6: "week" };
        const name: any = units[limit.raw.unit];
        if (name)
          result.resetDescription = `${limit.raw.number} ${name}${limit.raw.number === 1 ? "" : "s"} window`;
      }
      return result;
    }
    function limitRow(label: any, limit: any) {
      const parts: any = [];
      if (limit.usage !== null) parts.push(`${limit.usage} limit`);
      if (limit.remaining !== null) parts.push(`${limit.remaining} remaining`);
      return {
        label,
        value: `${limit.percent.toFixed(limit.percent % 1 ? 1 : 0)}% used`,
        secondaryValue: parts.join(" · ") || undefined,
      };
    }
    // Mirrors UsageFormatter.resetCountdownDescription so the row reads like native reset text.
    function countdownText(millis: any) {
      const seconds: any = Math.max(0, millis / 1000);
      if (seconds < 1) return "now";
      const totalMinutes: any = Math.max(1, Math.ceil(seconds / 60));
      const days: any = Math.floor(totalMinutes / 1440);
      const hours: any = Math.floor(totalMinutes / 60) % 24;
      const minutes: any = totalMinutes % 60;
      if (days > 0) {
        if (hours > 0) return `in ${days}d ${hours}h`;
        if (minutes > 0) return `in ${days}d ${minutes}m`;
        return `in ${days}d`;
      }
      if (hours > 0) return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
      return `in ${totalMinutes}m`;
    }
    // Peak is Mon-Fri 06:00-10:00 UTC (14:00-18:00 UTC+8); weekends are off-peak all day.
    // Credit plans charge 1x peak / 0.5x off-peak (docs.z.ai/devpack/overview); legacy
    // TOKENS_LIMIT plans charge model-dependent flat rates, so the row is credit-only.
    // No z.ai endpoint exposes this - it is purely a function of the injected clock.
    function quotaRateRow() {
      const PEAK_START: any = 6;
      const PEAK_END: any = 10;
      const now: any = new Date(ctx.date.nowMillis());
      const day: any = now.getUTCDay();
      const hour: any = now.getUTCHours();
      const isPeak: any = day >= 1 && day <= 5 && hour >= PEAK_START && hour < PEAK_END;
      const boundary: any = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          isPeak ? PEAK_END : PEAK_START,
        ),
      );
      if (!isPeak) {
        if (hour >= PEAK_START) boundary.setUTCDate(boundary.getUTCDate() + 1);
        while (boundary.getUTCDay() === 0 || boundary.getUTCDay() === 6) {
          boundary.setUTCDate(boundary.getUTCDate() + 1);
        }
      }
      const countdown: any = countdownText(boundary.getTime() - now.getTime());
      return {
        label: "Quota rate",
        value: isPeak ? "Peak" : "Off-peak",
        secondaryValue: `${isPeak ? "off-peak" : "peak"} ${countdown}`,
      };
    }

    const limits: any = root.data.limits.map(parseLimit).filter(Boolean);
    const tokenLimits: any = limits
      .filter((item: any) => item.raw.type === "TOKENS_LIMIT" || item.raw.type === "CREDIT_LIMIT")
      .sort(
        (a: any, b: any) =>
          (a.windowMinutes || Number.MAX_SAFE_INTEGER) -
          (b.windowMinutes || Number.MAX_SAFE_INTEGER),
      );
    const timeLimit: any =
      limits.filter((item: any) => item.raw.type === "TIME_LIMIT").pop() || null;
    const tokenLimit: any = tokenLimits.length ? tokenLimits[tokenLimits.length - 1] : null;
    const sessionLimit: any = tokenLimits.length >= 2 ? tokenLimits[0] : null;
    const primaryLimit: any = sessionLimit || tokenLimit || timeLimit;
    const result: any = {
      primary: primaryLimit ? window(primaryLimit) : { usedPercent: 0 },
      identity: {},
      details: [{ title: "Quota details", rows: [] }],
    };
    if (sessionLimit && tokenLimit) result.secondary = window(tokenLimit);
    if ((tokenLimit || sessionLimit) && timeLimit) {
      result.extraWindows = [{ id: "zai-mcp", title: "MCP", window: window(timeLimit) }];
    }
    if (tokenLimit)
      result.details[0].rows.push(
        limitRow(
          tokenLimit.raw.type === "CREDIT_LIMIT" ? "Credit quota" : "Token quota",
          tokenLimit,
        ),
      );
    if (sessionLimit)
      result.details[0].rows.push(
        limitRow(
          sessionLimit.raw.type === "CREDIT_LIMIT" ? "Session credit quota" : "Session token quota",
          sessionLimit,
        ),
      );
    const hasCreditLimit: any = [tokenLimit, sessionLimit].some(
      (item: any) => item && item.raw.type === "CREDIT_LIMIT",
    );
    if (hasCreditLimit) result.details[0].rows.push(quotaRateRow());
    if (timeLimit) {
      result.details[0].rows.push(limitRow("MCP quota", timeLimit));
      for (const detail of timeLimit.details.slice(0, 20)) {
        if (detail && typeof detail.modelCode === "string" && Number.isInteger(detail.usage)) {
          result.details[0].rows.push({ label: detail.modelCode, value: String(detail.usage) });
        }
      }
    }
    const plan: any = [
      root.data.planName,
      root.data.plan,
      root.data.plan_type,
      root.data.packageName,
      root.data.level,
    ].find((value: any) => typeof value === "string" && value.trim());
    if (plan) result.identity.loginMethod = plan.trim();

    // BigModel CN exposes account balance on the console host, not the API
    // host. This is best-effort: quota remains authoritative when the optional
    // balance service is slow, unavailable, or changes shape.
    if (region === "bigmodel-cn") {
      try {
        const balanceEndpoint: any =
          configuredBalanceEndpoint ||
          "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";
        const balanceResponse: any = await ctx.http.getJSON(balanceEndpoint, {
          timeoutSeconds: 5,
        });
        const balanceRoot: any = balanceResponse.json;
        if (
          balanceResponse.status === 200 &&
          balanceRoot &&
          typeof balanceRoot === "object" &&
          balanceRoot.success === true
        ) {
          const data: any =
            balanceRoot.data && typeof balanceRoot.data === "object" ? balanceRoot.data : {};
          const numeric = (value: any) =>
            value === null || value === undefined ? undefined : Number(value);
          const available: any = numeric(data.availableBalance);
          const current: any = numeric(data.balance);
          const value: any = Number.isFinite(available) ? available : current;
          if (Number.isFinite(value)) {
            const recharged: any = numeric(data.rechargeAmount);
            const granted: any = numeric(data.giveAmount);
            const spent: any = numeric(data.totalSpendAmount);
            const secondary: any[] = [];
            if (Number.isFinite(recharged)) secondary.push(`recharged ¥${recharged.toFixed(2)}`);
            if (Number.isFinite(granted) && granted > 0)
              secondary.push(`granted ¥${granted.toFixed(2)}`);
            if (Number.isFinite(spent)) secondary.push(`spent ¥${spent.toFixed(2)}`);
            result.details[0].rows.push({
              label: "Account balance",
              value: `¥${Number(value).toFixed(2)}`,
              secondaryValue: secondary.join(" · ") || undefined,
            });
          }
        }
      } catch {
        // Keep the already-fetched quota snapshot when this optional endpoint fails.
      }
    }

    async function modelUsage(daysBack: any) {
      const end: any = ctx.date.now();
      const start: any = new Date(end);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - Math.max(1, daysBack));
      const rangeEnd: any = new Date(end);
      rangeEnd.setMinutes(59, 59, 0);
      const pad: any = (value: any) => String(value).padStart(2, "0");
      const stamp: any = (date: any) =>
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      const type: any = scope === "team" ? "&type=3" : "";
      const modelUsageBase: any = modelUsageEndpoint.split("?", 1)[0];
      const url: any =
        `${modelUsageBase}?startTime=${encodeURIComponent(stamp(start))}` +
        `&endTime=${encodeURIComponent(stamp(rangeEnd))}${type}`;
      const response: any = await ctx.http.getJSON(url, { headers });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const body: any = response.json;
      if (!body || body.success !== true || body.code !== 200)
        throw new Error("invalid model usage response");
      const data: any = body.data || {};
      const labels: any = Array.isArray(data.x_time) ? data.x_time : [];
      const models: any = Array.isArray(data.modelDataList) ? data.modelDataList : [];
      const points: any = labels
        .map((label: any, index: any) => {
          let total: any = 0;
          for (const model of models) {
            const value: any =
              model && Array.isArray(model.tokensUsage) ? model.tokensUsage[index] : null;
            if (Number.isInteger(value) && value > 0) total += value;
          }
          return { label: String(label), value: total };
        })
        .filter((point: any) => point.value > 0);
      const totals: any = models
        .map((model: any) => ({
          name: model && typeof model.modelName === "string" ? model.modelName : "Unknown",
          tokens:
            model && Array.isArray(model.tokensUsage)
              ? model.tokensUsage.reduce(
                  (sum: any, value: any) =>
                    sum + (Number.isInteger(value) && value > 0 ? value : 0),
                  0,
                )
              : 0,
        }))
        .filter((item: any) => item.tokens > 0)
        .sort((a: any, b: any) => b.tokens - a.tokens || a.name.localeCompare(b.name));
      return { points, totals };
    }

    for (const [days, title] of [
      [1, "Hourly tokens"],
      [30, "Daily tokens"],
    ]) {
      try {
        const usage: any = await modelUsage(days);
        if (usage.points.length) {
          result.details.push({
            title,
            rows: usage.totals
              .slice(0, 20)
              .map((item: any) => ({ label: item.name, value: String(item.tokens) })),
            chart: { kind: "bars", title, unit: "tokens", points: usage.points },
          });
        }
      } catch {}
    }
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "zai.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const zai: FirstPartyProvider = { ...strategy, descriptor };
