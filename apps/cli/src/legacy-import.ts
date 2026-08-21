import type { LegacyImportInspection } from "@codexbar/core";
import type {
  NodeLegacyImportOptions,
  NodeLegacyImportResult,
  NodeLegacyRollbackResult,
} from "@codexbar/platform/node";
import type { CLICommandResult, CLIIO } from "./runner.ts";

/** The CLI exposes only the host-owned, already-safe legacy import boundary. */
export interface CLILegacyImportStore {
  readonly inspect: (options: NodeLegacyImportOptions) => Promise<LegacyImportInspection>;
  readonly execute: (options: NodeLegacyImportOptions) => Promise<NodeLegacyImportResult>;
  readonly rollback: (
    options: NodeLegacyImportOptions & { readonly importId: string },
  ) => Promise<NodeLegacyRollbackResult>;
}

type LegacyAction = "inspect" | "execute" | "rollback";
type LegacyFormat = "text" | "json";

interface ParsedLegacyImport {
  readonly action: LegacyAction;
  readonly options: NodeLegacyImportOptions;
  readonly importId?: string;
  readonly format: LegacyFormat;
  readonly pretty: boolean;
  readonly optedIn: boolean;
  readonly confirmed: boolean;
  readonly nonInteractive: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly value: ParsedLegacyImport }
  | { readonly ok: false; readonly message: string };

const importIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const optionValue = (
  arguments_: readonly string[],
  index: number,
  argument: string,
  name: string,
): { readonly value?: string; readonly nextIndex: number; readonly error?: string } => {
  if (argument === name) {
    const value = arguments_[index + 1];
    if (value === undefined || value === "" || value.startsWith("-"))
      return { nextIndex: index, error: `Missing value for ${name}` };
    return { value, nextIndex: index + 1 };
  }
  const prefix = `${name}=`;
  if (!argument.startsWith(prefix))
    return { nextIndex: index, error: `Unknown option ${argument}` };
  const value = argument.slice(prefix.length);
  return value === ""
    ? { nextIndex: index, error: `Missing value for ${name}` }
    : { value, nextIndex: index };
};

/**
 * Parse a deliberately small surface. A legacy root is always caller supplied;
 * no platform default or directory scan is selected by this parser.
 */
export const parseLegacyImportArguments = (arguments_: readonly string[]): ParseResult => {
  const action = arguments_[0];
  if (action !== "inspect" && action !== "execute" && action !== "rollback")
    return { ok: false, message: "legacy-import accepts inspect, execute, or rollback" };

  let legacyRoot: string | undefined;
  let destinationRoot: string | undefined;
  let databasePath: string | undefined;
  let importId: string | undefined;
  let configFile: string | undefined;
  let historyFile: string | undefined;
  let costsFile: string | undefined;
  let pluginsDirectory: string | undefined;
  let targetConfigPath: string | undefined;
  let targetPluginsPath: string | undefined;
  let format: LegacyFormat = "text";
  let pretty = false;
  let optedIn = false;
  let confirmed = false;
  let nonInteractive = false;
  const seen = new Set<string>();
  const setValue = (
    name: string,
    value: string | undefined,
    setter: (value: string) => void,
  ): ParseResult | undefined => {
    if (seen.has(name)) return { ok: false, message: `Option ${name} may only be specified once` };
    seen.add(name);
    if (value === undefined) return { ok: false, message: `Missing value for ${name}` };
    setter(value);
    return undefined;
  };

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("-"))
      return {
        ok: false,
        message: "legacy-import does not accept positional arguments after the action",
      };
    if (argument === "--allow-legacy-import") {
      if (optedIn)
        return { ok: false, message: "Option --allow-legacy-import may only be specified once" };
      optedIn = true;
      continue;
    }
    if (argument === "--yes") {
      if (confirmed) return { ok: false, message: "Option --yes may only be specified once" };
      confirmed = true;
      continue;
    }
    if (argument === "--non-interactive") {
      if (nonInteractive)
        return { ok: false, message: "Option --non-interactive may only be specified once" };
      nonInteractive = true;
      continue;
    }
    if (argument === "--pretty") {
      if (pretty) return { ok: false, message: "Option --pretty may only be specified once" };
      pretty = true;
      continue;
    }
    if (argument === "--json" || argument === "--json-only") {
      if (seen.has("--format"))
        return { ok: false, message: "Option --format may only be specified once" };
      seen.add("--format");
      format = "json";
      continue;
    }
    if (argument === "--confirm" || argument.startsWith("--confirm=")) {
      const parsed = optionValue(arguments_, index, argument, "--confirm");
      if (parsed.error !== undefined) return { ok: false, message: parsed.error };
      if (argument === "--confirm") index = parsed.nextIndex;
      if (parsed.value !== "legacy-import")
        return { ok: false, message: "--confirm expects legacy-import" };
      if (confirmed) return { ok: false, message: "Only one confirmation may be specified" };
      confirmed = true;
      continue;
    }
    if (argument === "--format" || argument.startsWith("--format=")) {
      const parsed = optionValue(arguments_, index, argument, "--format");
      if (parsed.error !== undefined) return { ok: false, message: parsed.error };
      if (seen.has("--format"))
        return { ok: false, message: "Option --format may only be specified once" };
      seen.add("--format");
      if (argument === "--format") index = parsed.nextIndex;
      if (parsed.value !== "text" && parsed.value !== "json")
        return { ok: false, message: "Invalid value for --format (expected text or json)" };
      format = parsed.value;
      continue;
    }

    const valueOptions: Readonly<Record<string, (value: string) => void>> = {
      "--legacy-root": (value) => (legacyRoot = value),
      "--destination-root": (value) => (destinationRoot = value),
      "--database-path": (value) => (databasePath = value),
      "--database": (value) => (databasePath = value),
      "--import-id": (value) => (importId = value),
      "--config-file": (value) => (configFile = value),
      "--history-file": (value) => (historyFile = value),
      "--costs-file": (value) => (costsFile = value),
      "--plugins-directory": (value) => (pluginsDirectory = value),
      "--target-config-path": (value) => (targetConfigPath = value),
      "--target-plugins-path": (value) => (targetPluginsPath = value),
    };
    const name = Object.keys(valueOptions).find(
      (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
    );
    if (name === undefined) return { ok: false, message: `Unknown option ${argument}` };
    const parsed = optionValue(arguments_, index, argument, name);
    if (parsed.error !== undefined) return { ok: false, message: parsed.error };
    if (argument === name) index = parsed.nextIndex;
    const failure = setValue(name, parsed.value, valueOptions[name]!);
    if (failure !== undefined) return failure;
  }

  if (!optedIn)
    return { ok: false, message: "Refusing legacy import without --allow-legacy-import" };
  if (legacyRoot === undefined) return { ok: false, message: "Missing required --legacy-root" };
  if (destinationRoot === undefined)
    return { ok: false, message: "Missing required --destination-root" };
  if (databasePath === undefined) return { ok: false, message: "Missing required --database-path" };
  if (importId !== undefined && !importIdPattern.test(importId))
    return {
      ok: false,
      message: "--import-id must be 1-64 lowercase alphanumeric/dash characters",
    };
  if (action === "rollback" && importId === undefined)
    return { ok: false, message: "legacy-import rollback requires --import-id" };
  if (action !== "inspect" && !confirmed)
    return {
      ok: false,
      message: "Refusing legacy import mutation without --yes or --confirm=legacy-import",
    };
  if (action === "inspect" && confirmed)
    return {
      ok: false,
      message: "--yes and --confirm are only valid with execute or rollback",
    };

  return {
    ok: true,
    value: {
      action,
      options: {
        legacyRoot,
        destinationRoot,
        databasePath,
        ...(importId === undefined ? {} : { importId }),
        ...(configFile === undefined ? {} : { configFile }),
        ...(historyFile === undefined ? {} : { historyFile }),
        ...(costsFile === undefined ? {} : { costsFile }),
        ...(pluginsDirectory === undefined ? {} : { pluginsDirectory }),
        ...(targetConfigPath === undefined ? {} : { targetConfigPath }),
        ...(targetPluginsPath === undefined ? {} : { targetPluginsPath }),
      },
      ...(importId === undefined ? {} : { importId }),
      format,
      pretty,
      optedIn,
      confirmed,
      nonInteractive,
    },
  };
};

const terminalText = (value: string, maximum = 256): string => {
  const normalized = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
};

const safeInspection = (inspection: LegacyImportInspection): Record<string, unknown> => ({
  candidates: inspection.candidates.slice(0, 64).map((candidate) => ({
    kind: candidate.kind,
    source: terminalText(candidate.source, 64),
    state: candidate.state,
    itemCount: candidate.itemCount,
    byteCount: candidate.byteCount,
    ...(candidate.reason === undefined ? {} : { reason: "source could not be decoded" }),
  })),
  excludedFeatures: [...inspection.excludedFeatures],
  sqliteCompatibility: inspection.sqliteCompatibility,
});

const safeResult = (result: NodeLegacyImportResult): Record<string, unknown> => ({
  importId: terminalText(result.importId, 64),
  status: result.status,
  inspection: safeInspection(result.inspection),
  imported: result.imported,
  skipped: safeSkipped(result.skipped),
});

const safeRollback = (result: NodeLegacyRollbackResult): Record<string, unknown> => ({
  importId: terminalText(result.importId, 64),
  removed: result.removed,
  skipped: safeSkipped(result.skipped),
});

const safeSkipped = (values: readonly string[]): readonly string[] =>
  values
    .slice(0, 256)
    .map((value) =>
      value === "config: target already exists" ||
      value === "plugin target already exists" ||
      value === "no import journal"
        ? value
        : "skipped",
    );

const emit = (
  io: CLIIO,
  format: LegacyFormat,
  pretty: boolean,
  value: Record<string, unknown>,
): void => {
  if (format === "json") io.stdout(JSON.stringify(value, undefined, pretty ? 2 : undefined));
  else if ("candidates" in value) {
    const inspection = value as Record<string, unknown>;
    const candidates = inspection.candidates as readonly Record<string, unknown>[];
    io.stdout(
      candidates
        .map((candidate) => `${candidate.kind}\t${candidate.state}\t${candidate.itemCount}`)
        .join("\n"),
    );
  } else if ("removed" in value) {
    io.stdout(`${String(value.importId)}\trolled back`);
  } else {
    io.stdout(`${String(value.importId)}\t${String(value.status)}`);
  }
};

const failure = (
  io: CLIIO,
  format: LegacyFormat,
  pretty: boolean,
  message: string,
  exitCode: 1 | 64 | 69,
): CLICommandResult => {
  // Never include host/parser exception text: it may contain source data.
  if (format === "json")
    io.stdout(JSON.stringify({ error: message }, undefined, pretty ? 2 : undefined));
  else io.stderr(`Error: ${message}`);
  return { exitCode };
};

export const runLegacyImport = async (
  arguments_: readonly string[],
  io: CLIIO,
  store: CLILegacyImportStore | undefined,
): Promise<CLICommandResult> => {
  const jsonHint = arguments_.some(
    (argument) =>
      argument === "--json" || argument === "--json-only" || argument === "--format=json",
  );
  const parsed = parseLegacyImportArguments(arguments_);
  if (!parsed.ok) return failure(io, jsonHint ? "json" : "text", false, parsed.message, 64);
  const { action, options, importId, format, pretty } = parsed.value;
  if (store === undefined)
    return failure(io, format, pretty, "Legacy import is unavailable on this host", 69);
  try {
    if (action === "inspect") {
      const inspection = await store.inspect(options);
      emit(io, format, pretty, safeInspection(inspection));
    } else if (action === "execute") {
      emit(io, format, pretty, safeResult(await store.execute(options)));
    } else {
      emit(
        io,
        format,
        pretty,
        safeRollback(await store.rollback({ ...options, importId: importId! })),
      );
    }
    return { exitCode: 0 };
  } catch {
    return failure(
      io,
      format,
      pretty,
      action === "inspect"
        ? "Legacy import inspection failed"
        : action === "execute"
          ? "Legacy import execution failed"
          : "Legacy import rollback failed",
      1,
    );
  }
};
