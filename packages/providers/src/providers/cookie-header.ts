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

/** Pure TypeScript port of Swift's CookieHeaderNormalizer.normalize. */
export const normalizeCookieHeader = (raw: string | undefined): string | undefined => {
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
