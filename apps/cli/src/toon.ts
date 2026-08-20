/**
 * A small TOON v4.1 renderer for the CLI's JSON-shaped payloads.
 *
 * The CLI deliberately passes the very same DTO to JSON.stringify and this
 * renderer. Keeping it data-oriented avoids a second, subtly different,
 * output model for agents consuming `usage --format toon`.
 */
export type ToonValue =
  | null
  | boolean
  | number
  | string
  | readonly ToonValue[]
  | { readonly [key: string]: ToonValue | undefined };

const pad = (indent: number): string => "  ".repeat(indent);

const isRecord = (value: ToonValue): value is { readonly [key: string]: ToonValue | undefined } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value: ToonValue | undefined): value is null | boolean | number | string =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string";

const finite = (value: number): string => {
  if (!Number.isFinite(value)) throw new TypeError("TOON cannot encode a non-finite number");
  if (Object.is(value, -0) || value === 0) return "0";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(value).replace(/\.0$/u, "");
};

const looksNumeric = (value: string): boolean =>
  /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value);

const escape = (value: string): string =>
  Array.from(value, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return (character.codePointAt(0) ?? 0) < 0x20
          ? `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
          : character;
    }
  }).join("");

const quoteValue = (value: string): string => {
  const quote =
    value === "" ||
    value.trim() !== value ||
    value === "true" ||
    value === "false" ||
    value === "null" ||
    looksNumeric(value) ||
    value.startsWith("-") ||
    value.startsWith("#") ||
    /[:"\\[\]{},]/u.test(value) ||
    Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 0x20);
  return quote ? `"${escape(value)}"` : value;
};

const quoteKey = (key: string): string =>
  /^[A-Za-z_][A-Za-z0-9_.]*$/u.test(key) ? key : `"${escape(key)}"`;

const literal = (value: ToonValue | undefined): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return finite(value);
  if (typeof value === "string") return quoteValue(value);
  throw new TypeError("TOON table cells must be scalar values");
};

const ownEntries = (value: { readonly [key: string]: ToonValue | undefined }) =>
  Object.entries(value).filter((entry): entry is [string, ToonValue] => entry[1] !== undefined);

const tabularFields = (items: readonly ToonValue[]): readonly string[] | undefined => {
  const first = items[0];
  if (first === undefined || !isRecord(first)) return undefined;
  const fields = ownEntries(first).map(([key]) => key);
  if (fields.length === 0) return undefined;
  for (const item of items) {
    if (!isRecord(item)) return undefined;
    const entries = ownEntries(item);
    if (entries.length !== fields.length || entries.some(([key], index) => key !== fields[index]))
      return undefined;
    if (entries.some(([, value]) => !isScalar(value))) return undefined;
  }
  return fields;
};

const scalarLine = (key: string | undefined, value: ToonValue, indent: number): string =>
  `${pad(indent)}${key === undefined ? "" : `${quoteKey(key)}: `}${literal(value)}`;

const renderValue = (key: string | undefined, value: ToonValue, indent: number): string[] => {
  if (isScalar(value)) return [scalarLine(key, value, indent)];
  if (Array.isArray(value)) return renderArray(key, value, indent);
  if (isRecord(value)) return renderObject(key, value, indent);
  return [];
};

const renderObject = (
  key: string | undefined,
  value: { readonly [key: string]: ToonValue | undefined },
  indent: number,
): string[] => {
  const entries = ownEntries(value);
  if (entries.length === 0)
    return [`${pad(indent)}${key === undefined ? "{}" : `${quoteKey(key)}:`}`];
  const childIndent = key === undefined ? indent : indent + 1;
  return [
    ...(key === undefined ? [] : [`${pad(indent)}${quoteKey(key)}:`]),
    ...entries.flatMap(([childKey, child]) => renderValue(childKey, child, childIndent)),
  ];
};

const mergeHyphen = (lines: readonly string[], indent: number): string[] => {
  const first = lines[0];
  if (first === undefined) return [`${pad(indent)}-`];
  const content = first.slice((indent + 1) * 2);
  return [`${pad(indent)}- ${content}`, ...lines.slice(1)];
};

const renderListItem = (value: ToonValue, indent: number): string[] => {
  if (isRecord(value)) {
    const entries = ownEntries(value);
    const first = entries[0];
    if (first === undefined) return [`${pad(indent)}-`];
    return [
      ...mergeHyphen(renderValue(first[0], first[1], indent + 1), indent),
      ...entries.slice(1).flatMap(([key, child]) => renderValue(key, child, indent + 1)),
    ];
  }
  if (Array.isArray(value)) return mergeHyphen(renderArray(undefined, value, indent + 1), indent);
  return [`${pad(indent)}- ${literal(value)}`];
};

const renderArray = (
  key: string | undefined,
  items: readonly ToonValue[],
  indent: number,
): string[] => {
  const header = key === undefined ? "" : quoteKey(key);
  if (items.length === 0) return [`${pad(indent)}${key === undefined ? "[]" : `${header}: []`}`];
  if (items.every(isScalar)) {
    return [`${pad(indent)}${header}[${items.length}]: ${items.map(literal).join(",")}`];
  }
  const fields = tabularFields(items);
  if (fields !== undefined) {
    return [
      `${pad(indent)}${header}[${items.length}]{${fields.map(quoteKey).join(",")}}:`,
      ...items.map((item) => {
        const row = isRecord(item) ? ownEntries(item).map(([, value]) => literal(value)) : [];
        return `${pad(indent + 1)}${row.join(",")}`;
      }),
    ];
  }
  return [
    `${pad(indent)}${header}[${items.length}]:`,
    ...items.flatMap((item) => renderListItem(item, indent + 1)),
  ];
};

/** Returns an empty string when the input contains NaN/Infinity, matching Swift's fail-closed path. */
export const encodeToon = (value: ToonValue): string => {
  try {
    return renderValue(undefined, value, 0).join("\n");
  } catch {
    return "";
  }
};
