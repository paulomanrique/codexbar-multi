import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../../../../Sources/CodexBar/Resources/", import.meta.url);
const output = new URL("../localization/locales/", import.meta.url);
const locales = [
  "en",
  "de",
  "es",
  "ca",
  "zh-Hans",
  "zh-Hant",
  "pt-BR",
  "sv",
  "fr",
  "nl",
  "uk",
  "ru",
  "it",
  "vi",
  "ja",
  "ko",
  "tr",
  "id",
  "pl",
  "ar",
  "fa",
  "th",
  "gl",
];

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function readQuoted(value, start) {
  let result = "";
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      result +=
        character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return [result, index + 1];
    } else {
      result += character;
    }
  }
  throw new Error(`Unterminated quoted string near ${value.slice(start, start + 40)}`);
}

function parseStrings(source) {
  const messages = {};
  for (const line of source.split(/\r?\n/u)) {
    const first = line.indexOf('"');
    if (first < 0) continue;
    const [key, afterKey] = readQuoted(line, first + 1);
    const equals = line.indexOf("=", afterKey);
    if (equals < 0) continue;
    const valueStart = line.indexOf('"', equals);
    if (valueStart < 0) continue;
    const [value] = readQuoted(line, valueStart + 1);
    messages[key] = value;
  }
  return messages;
}

function parsePlistDictionary(source, dictionaryStart) {
  const values = {};
  let cursor = dictionaryStart;
  const whitespace = () => {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  };
  while (cursor < source.length) {
    whitespace();
    if (source.startsWith("</dict>", cursor)) return [values, cursor + "</dict>".length];
    if (!source.startsWith("<key>", cursor))
      throw new Error(`Expected a plist key near ${source.slice(cursor, cursor + 40)}`);
    const keyEnd = source.indexOf("</key>", cursor + "<key>".length);
    if (keyEnd < 0) throw new Error("Unterminated plist key");
    const key = decodeXml(source.slice(cursor + "<key>".length, keyEnd));
    cursor = keyEnd + "</key>".length;
    whitespace();
    if (source.startsWith("<string>", cursor)) {
      const valueEnd = source.indexOf("</string>", cursor + "<string>".length);
      if (valueEnd < 0) throw new Error(`Unterminated plist string for ${key}`);
      values[key] = decodeXml(source.slice(cursor + "<string>".length, valueEnd));
      cursor = valueEnd + "</string>".length;
      continue;
    }
    if (source.startsWith("<dict>", cursor)) {
      const [value, next] = parsePlistDictionary(source, cursor + "<dict>".length);
      values[key] = value;
      cursor = next;
      continue;
    }
    throw new Error(`Unsupported plist value for ${key}`);
  }
  throw new Error("Unbalanced stringsdict dictionary");
}

function parseStringsdict(source) {
  const rootStart = source.indexOf("<dict>");
  if (rootStart < 0) throw new Error("stringsdict root dictionary is missing");
  const [root] = parsePlistDictionary(source, rootStart + "<dict>".length);
  const plurals = {};
  for (const [key, value] of Object.entries(root)) {
    if (typeof value !== "object" || value === null) continue;
    const format = value.NSStringLocalizedFormatKey;
    if (typeof format !== "string") continue;
    const variables = {};
    for (const [name, variants] of Object.entries(value)) {
      if (
        name === "NSStringLocalizedFormatKey" ||
        typeof variants !== "object" ||
        variants === null
      )
        continue;
      const selected = {};
      for (const category of ["zero", "one", "two", "few", "many", "other"])
        if (typeof variants[category] === "string") selected[category] = variants[category];
      if (Object.keys(selected).length > 0) variables[name] = selected;
    }
    if (Object.keys(variables).length > 0) plurals[key] = { format, variables };
  }
  return plurals;
}

await mkdir(output, { recursive: true });
for (const locale of locales) {
  const directory = new URL(`${locale}.lproj/`, root);
  const strings = await readFile(new URL("Localizable.strings", directory), "utf8");
  const stringsdict = await readFile(new URL("Localizable.stringsdict", directory), "utf8");
  const catalog = {
    source: `Sources/CodexBar/Resources/${locale}.lproj/Localizable.strings`,
    messages: parseStrings(strings),
    plurals: parseStringsdict(stringsdict),
  };
  await writeFile(new URL(`${locale}.json`, output), `${JSON.stringify(catalog, null, 2)}\n`);
}
