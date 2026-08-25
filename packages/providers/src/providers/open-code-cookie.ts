const cookieHeaderPatterns = [
  /-H\s*'Cookie:\s*([^']+)'/iu,
  /-H\s*"Cookie:\s*([^"]+)"/iu,
  /\bcookie:\s*'([^']+)'/iu,
  /\bcookie:\s*"([^"]+)"/iu,
  /\bcookie:\s*([^\r\n]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s*'([^']+)'/iu,
  /(?:^|\s)(?:--cookie|-b)\s*"([^"]+)"/iu,
  /(?:^|\s)-b([^\s=]+=[^\s]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s+([^\s]+)/iu,
] as const;

const stripWrappingQuotes = (raw: string): string => {
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
};

const normalizeCookieHeader = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (value === "") return undefined;
  for (const pattern of cookieHeaderPatterns) {
    const match = pattern.exec(value);
    if (match?.[1]?.trim()) {
      value = match[1].trim();
      break;
    }
  }
  const trimmed = value.trim();
  value = trimmed.toLowerCase().startsWith("cookie:")
    ? trimmed.slice("cookie:".length).trim()
    : trimmed;
  value = stripWrappingQuotes(value).trim();
  return value === "" ? undefined : value;
};

const allowedOpenCodeCookieNames = new Set(["auth", "__Host-auth"]);
const maximumCookieBytes = 1024 * 1024;
const cookieTextEncoder = new TextEncoder();

/** Swift-compatible OpenCode cookie projection: exact names, stable order, duplicates preserved. */
export const openCodeRequestCookieHeader = (raw: string | undefined): string | undefined => {
  if (
    raw === undefined ||
    raw.includes("\u0000") ||
    cookieTextEncoder.encode(raw).byteLength > maximumCookieBytes
  ) {
    return undefined;
  }
  const normalized = normalizeCookieHeader(raw);
  if (normalized === undefined) return undefined;
  const filtered: string[] = [];
  for (const part of normalized.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const name = trimmed.slice(0, separator).trim();
    if (!allowedOpenCodeCookieNames.has(name)) continue;
    filtered.push(`${name}=${trimmed.slice(separator + 1).trim()}`);
  }
  return filtered.length === 0 ? undefined : filtered.join("; ");
};
