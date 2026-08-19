/** JSON-compatible values used by fixture tests. No filesystem, network, or credential access. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

const SECRET_KEY = /(?:token|secret|password|cookie|credential|authorization|api[-_]?key)/i;

/** Deeply sorts object keys and normalizes dates/numeric edge cases for stable parity comparisons. */
export function normalizeJson(
  value: unknown,
  options: { redactSecrets?: boolean } = {},
): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, options));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [
          key,
          options.redactSecrets && SECRET_KEY.test(key)
            ? "[REDACTED]"
            : normalizeJson(source[key], options),
        ]),
    );
  }
  return null;
}

export function normalizeJsonText(input: string, options?: { redactSecrets?: boolean }): string {
  return JSON.stringify(normalizeJson(JSON.parse(input), options));
}

export function jsonParityEqual(
  left: unknown,
  right: unknown,
  options?: { redactSecrets?: boolean },
): boolean {
  return (
    JSON.stringify(normalizeJson(left, options)) === JSON.stringify(normalizeJson(right, options))
  );
}
