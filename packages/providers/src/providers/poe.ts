import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "poe",
  name: "Poe",
  endpoints: ["https://api.poe.com"],
  auth: { type: "bearer", secret: "POE_API_KEY" },
  settings: [
    {
      key: "POE_API_KEY",
      title: "API key",
      subtitle: "Poe API key used for point balance and history.",
      type: "secure",
    },
  ],

  fetchUsage: async (ctx: ProviderContext) => {
    const balanceResponse: any = await ctx.http.getJSON(
      "https://api.poe.com/usage/current_balance",
    );
    if (balanceResponse.status === 401 || balanceResponse.status === 403) {
      throw new Error("Invalid or expired Poe API token");
    }
    if (balanceResponse.status < 200 || balanceResponse.status >= 300) {
      throw new Error(`Poe API error: HTTP ${balanceResponse.status}`);
    }
    const payload: any = balanceResponse.json;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Failed to parse Poe balance response");
    }

    function optionalNumber(value: any, field: any) {
      if (value === null || value === undefined) return null;
      const number: any =
        typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      if (!Number.isFinite(number)) throw new Error(`Poe ${field} must be numeric`);
      return number;
    }
    function compact(value: any) {
      return ctx.format.number(value, {
        maximumFractionDigits: value >= 1000 ? 0 : 1,
      });
    }
    function entryDate(value: any) {
      if (typeof value === "number" && Number.isFinite(value)) {
        if (value > 100000000000000) return new Date(value / 1000);
        if (value > 1000000000000) return new Date(value);
        return new Date(value * 1000);
      }
      if (typeof value === "string" && value.trim()) {
        const numeric: any = Number(value);
        if (Number.isFinite(numeric)) return entryDate(numeric);
        const date: any = new Date(value);
        if (Number.isFinite(date.getTime())) return date;
      }
      return null;
    }
    function timeString(date: any) {
      const pad: any = (value: any) => String(value).padStart(2, "0");
      return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    }
    function summaryRow(label: any, summary: any) {
      const secondary: any = [`${summary.requests} requests`];
      if (summary.hasCost) secondary.push(`$${summary.cost.toFixed(2)}`);
      return {
        label,
        value: `${compact(summary.points)} points`,
        secondaryValue: secondary.join(" · "),
      };
    }

    const balance: any = optionalNumber(payload.current_point_balance, "current_point_balance");
    const entries: any = [];
    try {
      let cursor: any = null;
      const cutoff: any = Date.now() - 30 * 86400000;
      for (let page = 0; page < 5; page += 1) {
        const query: any = cursor
          ? `?limit=100&starting_after=${encodeURIComponent(cursor)}`
          : "?limit=100";
        const response: any = await ctx.http.getJSON(
          `https://api.poe.com/usage/points_history${query}`,
        );
        if (response.status < 200 || response.status >= 300)
          throw new Error(`HTTP ${response.status}`);
        const root: any = response.json;
        if (!root || typeof root !== "object" || Array.isArray(root))
          throw new Error("invalid history JSON");
        const rows: any = Array.isArray(root.data)
          ? root.data
          : Array.isArray(root.items)
            ? root.items
            : Array.isArray(root.results)
              ? root.results
              : [];
        for (const row of rows) {
          if (!row || typeof row !== "object" || Array.isArray(row)) continue;
          const date: any = entryDate(row.creation_time ?? row.timestamp ?? row.created_at);
          if (!date || date.getTime() < cutoff) continue;
          const points: any = Math.max(
            0,
            optionalNumber(row.cost_points ?? row.points ?? row.point_cost, "points") ?? 0,
          );
          const cost: any = optionalNumber(row.cost_usd ?? row.usd, "cost_usd");
          const model: any =
            typeof row.bot_name === "string" && row.bot_name.trim()
              ? row.bot_name.trim()
              : "unknown";
          const usageType: any =
            typeof row.usage_type === "string" && row.usage_type.trim()
              ? row.usage_type.trim()
              : "unknown";
          entries.push({ date, points, cost, model, usageType });
        }
        const next: any =
          typeof root.next_cursor === "string" && root.next_cursor.trim()
            ? root.next_cursor.trim()
            : null;
        cursor =
          next ||
          (root.has_more === true &&
          rows.length &&
          typeof rows[rows.length - 1].query_id === "string"
            ? rows[rows.length - 1].query_id.trim()
            : null);
        if (!cursor) break;
        const lastDate: any = rows.length
          ? entryDate(
              rows[rows.length - 1].creation_time ??
                rows[rows.length - 1].timestamp ??
                rows[rows.length - 1].created_at,
            )
          : null;
        if (lastDate && lastDate.getTime() < cutoff) break;
      }
    } catch {}

    const daily: any = new Map();
    const models: any = new Map();
    const types: any = new Map();
    for (const entry of entries) {
      const day: any = entry.date.toISOString().slice(0, 10);
      const bucket: any = daily.get(day) || { points: 0, requests: 0, cost: 0, hasCost: false };
      bucket.points += entry.points;
      bucket.requests += 1;
      if (entry.cost !== null) {
        bucket.cost += Math.max(0, entry.cost);
        bucket.hasCost = true;
      }
      daily.set(day, bucket);
      models.set(entry.model, (models.get(entry.model) || 0) + entry.points);
      types.set(entry.usageType, (types.get(entry.usageType) || 0) + entry.points);
    }
    const days: any = Array.from(daily.entries()).sort((a: any, b: any) =>
      a[0].localeCompare(b[0]),
    );
    const summarize: any = (count: any) =>
      days.slice(-count).reduce(
        (sum: any, item: any) => {
          sum.points += item[1].points;
          sum.requests += item[1].requests;
          if (item[1].hasCost) {
            sum.cost += item[1].cost;
            sum.hasCost = true;
          }
          return sum;
        },
        { points: 0, requests: 0, cost: 0, hasCost: false },
      );
    const seven: any = summarize(7);
    const thirty: any = summarize(30);
    const now: any = new Date(Date.now());
    const todayUTC: any = now.toISOString().slice(0, 10);
    const todayEntries: any = entries.filter(
      (entry: any) => entry.date.toISOString().slice(0, 10) === todayUTC,
    );
    const today: any = todayEntries.reduce(
      (sum: any, entry: any) => {
        sum.points += entry.points;
        sum.requests += 1;
        if (entry.cost !== null) {
          sum.cost += Math.max(0, entry.cost);
          sum.hasCost = true;
        }
        return sum;
      },
      { points: 0, requests: 0, cost: 0, hasCost: false },
    );
    const topModel: any = Array.from(models.entries()).sort(
      (a: any, b: any) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    const topTypes: any = Array.from(types.entries()).sort(
      (a: any, b: any) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    const rows: any = [];
    if (balance !== null)
      rows.push({ label: "Current balance", value: `${compact(balance)} points` });
    if (entries.length) {
      rows.push(summaryRow("Today", today));
      rows.push(summaryRow("Last 7 days", seven));
      rows.push(summaryRow("Last 30 days", thirty));
      if (topModel)
        rows.push({
          label: "Top model",
          value: topModel[0],
          secondaryValue: `${compact(topModel[1])} points`,
        });
      if (topTypes.length) {
        rows.push({
          label: "Usage mix",
          value: topTypes
            .slice(0, 2)
            .map((item: any) => `${item[0]}: ${compact(item[1])} points`)
            .join(" · "),
        });
      }
      entries
        .slice()
        .sort((a: any, b: any) => b.date - a.date)
        .slice(0, 3)
        .forEach((entry: any, index: any) => {
          rows.push({
            label: index === 0 ? "Recent activity" : timeString(entry.date),
            value: index === 0 ? `${timeString(entry.date)} · ${entry.model}` : entry.model,
            secondaryValue: `${compact(entry.points)} points`,
          });
        });
    }
    const section: any = { title: "Points", rows };
    if (days.length) {
      section.chart = {
        kind: "bars",
        title: "Daily points",
        unit: "points",
        points: days.map((item: any) => ({ label: item[0], value: item[1].points })),
      };
    }
    const result: any = { details: [section], identity: {} };
    if (balance !== null) result.identity.loginMethod = `Balance: ${compact(balance)} points`;
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "poe.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const poe: FirstPartyProvider = { ...strategy, descriptor };
