export interface MiniMaxCookieCredential {
  readonly cookieHeader: string;
  readonly authorizationToken?: string;
  readonly groupId?: string;
}

const maximumCredentialBytes = 1024 * 1024;
const textEncoder = new TextEncoder();

const cookieHeaderPatterns = [
  /-H\s*'Cookie:\s*([^']+)'/iu,
  /-H\s*"Cookie:\s*([^"]+)"/iu,
  /-H\s+Cookie:\s*([^\s]+)/iu,
  /\bcookie:\s*'([^']+)'/iu,
  /\bcookie:\s*"([^"]+)"/iu,
  /\bcookie:\s*([^\r\n]+)/iu,
  /(?:--cookie|-b)\s*'([^']+)'/iu,
  /(?:--cookie|-b)\s*"([^"]+)"/iu,
  /(?:--cookie|-b)\s*([^\s]+)/iu,
] as const;

const authorizationPattern = /\bauthorization:\s*bearer\s+([A-Za-z0-9._\-+=/]+)/iu;
const groupIdPatterns = [
  /\bx-group-id:\s*([0-9]{4,})/iu,
  /\bminimax_group_id_v2=([0-9]{4,})/iu,
  /\bgroup[_]?id=([0-9]{4,})/iu,
] as const;

const allowedHeaderNames = new Set(["authorization", "cookie", "x-group-id"]);

const byteLength = (value: string): number => textEncoder.encode(value).byteLength;

const trim = (value: string | undefined): string | undefined => {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
};

const stripWrappingQuotes = (raw: string): string => {
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
};

const hasLineBreaks = (raw: string): boolean => /[\r\n]/u.test(raw);

const hasUnsafeControlCharacter = (raw: string): boolean =>
  [...raw].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && ((codePoint >= 1 && codePoint <= 31) || codePoint === 127);
  });

const hasLoneCarriageReturn = (raw: string): boolean => /(?:^|[^\r])\r(?!\n)/u.test(raw);

const headerName = (line: string): string | undefined => {
  const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:/u.exec(line.trim());
  return match?.[1]?.toLowerCase();
};

const isCurlInput = (raw: string): boolean => /\bcurl\b/iu.test(raw);

const hasUnknownBareHeaderLine = (raw: string): boolean =>
  raw
    .split(/\r?\n/u)
    .map((line) => headerName(line))
    .some((name) => name !== undefined && !allowedHeaderNames.has(name));

const isControlledMultiline = (raw: string): boolean => {
  if (!hasLineBreaks(raw)) return true;
  if (hasLoneCarriageReturn(raw)) return false;
  if (isCurlInput(raw)) return !hasUnknownBareHeaderLine(raw);
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .every((line) => {
      const name = headerName(line);
      return name !== undefined && allowedHeaderNames.has(name);
    });
};

const extractHeader = (raw: string): string | undefined => {
  for (const pattern of cookieHeaderPatterns) {
    const captured = trim(pattern.exec(raw)?.[1]);
    if (captured) return captured;
  }
  return undefined;
};

const normalizedCookieHeader = (raw: string): string | undefined => {
  let value = extractHeader(raw) ?? raw;
  value = value.trim();
  if (value.toLowerCase().startsWith("cookie:")) value = value.slice("cookie:".length).trim();
  value = stripWrappingQuotes(value).trim();
  if (value === "" || hasLineBreaks(value) || value.includes("\u0000")) return undefined;
  if (hasUnsafeControlCharacter(value)) return undefined;
  if (byteLength(value) >= maximumCredentialBytes) return undefined;
  return value;
};

const hasCookiePair = (cookieHeader: string): boolean =>
  cookieHeader.split(";").some((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && part.slice(0, separator).trim() !== "";
  });

const extractFirst = (patterns: readonly RegExp[] | RegExp, raw: string): string | undefined => {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const pattern of list) {
    const value = trim(pattern.exec(raw)?.[1]);
    if (value) return value;
  }
  return undefined;
};

export const normalizeMiniMaxCookieCredential = (
  raw: string | undefined,
): MiniMaxCookieCredential | undefined => {
  const value = trim(raw);
  if (
    !value ||
    value.includes("\u0000") ||
    byteLength(value) >= maximumCredentialBytes ||
    !isControlledMultiline(value)
  ) {
    return undefined;
  }

  const cookieHeader = normalizedCookieHeader(value);
  if (!cookieHeader || !hasCookiePair(cookieHeader)) return undefined;

  const authorizationToken = extractFirst(authorizationPattern, value);
  const groupId = extractFirst(groupIdPatterns, value);
  return {
    cookieHeader,
    ...(authorizationToken ? { authorizationToken } : {}),
    ...(groupId ? { groupId } : {}),
  };
};
