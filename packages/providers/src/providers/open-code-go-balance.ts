const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === "boolean") return undefined;
  const normalized = typeof value === "string" ? value.trim().replaceAll(",", "") : value;
  const parsed =
    typeof normalized === "number"
      ? normalized
      : typeof normalized === "string"
        ? Number(normalized)
        : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const explicitBalanceKeys = new Set([
  "zenbalance",
  "zencurrentbalance",
  "currentbalance",
  "currentbalanceusd",
  "balanceusd",
  "usdbalance",
]);

const normalizedKey = (key: string): string =>
  [...key.toLowerCase()].filter((character) => /[\p{L}\p{N}]/u.test(character)).join("");

const findExplicitBalance = (root: unknown): number | undefined => {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (explicitBalanceKeys.has(normalizedKey(key))) {
        const balance = finiteNumber(child);
        if (balance !== undefined) return balance;
      }
      pending.push(child);
    }
  }
  return undefined;
};

export const parseOpenCodeGoZenBalance = (text: string): number | undefined => {
  try {
    const balance = findExplicitBalance(JSON.parse(text) as unknown);
    if (balance !== undefined) return balance;
  } catch {
    // Dashboard responses are often HTML/hydration text rather than JSON.
  }
  const localized =
    /(?:current\s+balance|zen\s+balance|現在の残高)[^$]{0,80}\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/iu.exec(
      text,
    )?.[1];
  const nearby = /(?:balance|残高)[\s\S]{0,120}?\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/iu.exec(text)?.[1];
  return finiteNumber(localized ?? nearby);
};

const findRawBillingBalance = (root: unknown): number | undefined => {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "balance")) {
      if (typeof record.customerID !== "string" || record.customerID === "") return undefined;
      return finiteNumber(record.balance);
    }
    pending.push(...Object.values(record));
  }
  return undefined;
};

export const parseOpenCodeGoBillingBalance = (text: string): number | undefined => {
  try {
    const raw = findRawBillingBalance(JSON.parse(text) as unknown);
    if (raw !== undefined) return raw / 100_000_000;
  } catch {
    // SolidStart server-function payloads are JavaScript, not JSON.
  }
  if (!/(?:"customerID"|customerID)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?"[^"]+"/u.test(text)) {
    return undefined;
  }
  const raw = /(?:"balance"|balance)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(-?[0-9]+(?:\.[0-9]+)?)/u.exec(
    text,
  )?.[1];
  const parsed = finiteNumber(raw);
  return parsed === undefined ? undefined : parsed / 100_000_000;
};
