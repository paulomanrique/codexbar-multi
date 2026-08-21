export interface ProviderMatrixEntry {
  readonly id: string;
  readonly swiftGlobs: readonly string[];
  readonly swiftTestGlobs: readonly string[];
  readonly tsGlobs: readonly string[];
  readonly fixtures: readonly string[];
  readonly expectedTsPaths: readonly string[];
  readonly realTsPaths: readonly string[];
  readonly tsTestGlobs: readonly string[];
  readonly status: string | undefined;
  readonly oracleStatus: string | undefined;
  readonly lastReviewedCommit: string | undefined;
}

export interface ProviderMatrixValidationOptions {
  readonly source: string;
  readonly canonicalProviderIds: readonly string[];
  readonly pluginResourceFiles: readonly string[];
  /** Paths returned by `git ls-files`; fixture globs must resolve inside this set. */
  readonly trackedFiles: readonly string[];
  /** Source text keyed by paths listed in `tsPaths.expected` or `tsPaths.real`. */
  readonly providerSources?: Readonly<Record<string, string>>;
}

const listValue = (block: string, name: string, indent: number): readonly string[] => {
  const lines = block.split("\n");
  const field = `${" ".repeat(indent)}${name}:`;
  const index = lines.findIndex((line) => line.startsWith(field));
  if (index < 0) return [];
  const inline = lines[index]?.slice(field.length).trim() ?? "";
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
      .filter((value) => value.length > 0);
  }
  const values: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\s*-\s+/.test(line)) {
      const valueIndent = line.search(/\S|$/);
      if (valueIndent <= indent) break;
      values.push(
        line
          .replace(/^\s*-\s+/, "")
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      );
      continue;
    }
    if (line.trim().length === 0) continue;
    const valueIndent = line.search(/\S|$/);
    if (valueIndent <= indent) break;
  }
  return values;
};

const scalarValue = (block: string, name: string, indent: number): string | undefined => {
  const prefix = `${" ".repeat(indent)}${name}:`;
  const line = block.split("\n").find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value === undefined || value.length === 0 ? undefined : value.replace(/^['"]|['"]$/g, "");
};

export const parseProviderMatrix = (source: string): readonly ProviderMatrixEntry[] =>
  source
    .split(/\n(?=\s+- id:\s)/)
    .filter((block) => /^\s+- id:\s/m.test(block))
    .map((block) => ({
      id: /^\s+- id:\s*([^\s#]+)/m.exec(block)?.[1] ?? "",
      swiftGlobs: listValue(block, "swiftGlobs", 4),
      swiftTestGlobs: listValue(block, "swiftGlobs", 6),
      tsGlobs: listValue(block, "tsGlobs", 6),
      fixtures: listValue(block, "fixtures", 4),
      expectedTsPaths: listValue(block, "expected", 6),
      realTsPaths: listValue(block, "real", 6),
      tsTestGlobs: listValue(block, "tsTestGlobs", 4),
      status: scalarValue(block, "status", 4),
      oracleStatus: scalarValue(block, "oracleStatus", 4),
      lastReviewedCommit: scalarValue(block, "lastReviewedCommit", 4),
    }));

const isSha = (value: string | undefined): boolean =>
  value !== undefined && /^[0-9a-f]{7,40}$/i.test(value);

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const expandBraceGlobs = (glob: string): readonly string[] => {
  const match = /\{([^{}]+)\}/.exec(glob);
  if (match === null) return [glob];
  const token = match[0];
  return (match[1]?.split(",") ?? []).flatMap((choice) =>
    expandBraceGlobs(glob.replace(token, choice)),
  );
};

const globRegularExpression = (glob: string): RegExp => {
  const escaped = escapeRegularExpression(glob)
    .replaceAll("**/*", "__GLOBSTAR_SLASH__")
    .replaceAll("**", "__GLOBSTAR__")
    .replaceAll("*", "[^/]*")
    .replaceAll("__GLOBSTAR_SLASH__", ".*")
    .replaceAll("__GLOBSTAR__", ".*");
  return new RegExp(`^${escaped}$`);
};

const fixtureGlobResolves = (glob: string, trackedFiles: readonly string[]): boolean =>
  expandBraceGlobs(glob).some((expanded) => {
    const pattern = globRegularExpression(expanded);
    return trackedFiles.some((path) => pattern.test(path));
  });

const sourceFor = (
  entry: ProviderMatrixEntry,
  sources: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  if (sources === undefined) return undefined;
  return entry.expectedTsPaths.map((path) => sources[path]).find((source) => source !== undefined);
};

const validateImplementationContracts = (
  entry: ProviderMatrixEntry,
  providerSources: Readonly<Record<string, string>> | undefined,
): void => {
  if (entry.expectedTsPaths.length === 0)
    throw new Error(`provider ${entry.id} is missing its descriptor mapping (tsPaths.expected)`);
  if (entry.realTsPaths.length === 0)
    throw new Error(`provider ${entry.id} is missing its strategy mapping (tsPaths.real)`);

  const source = sourceFor(entry, providerSources);
  if (providerSources === undefined) return;
  for (const path of entry.expectedTsPaths) {
    if (providerSources[path] === undefined)
      throw new Error(`provider ${entry.id} has no readable descriptor module at ${path}`);
  }
  for (const path of entry.realTsPaths) {
    if (providerSources[path] === undefined)
      throw new Error(`provider ${entry.id} has no readable strategy module at ${path}`);
  }
  if (source === undefined)
    throw new Error(`provider ${entry.id} has no readable TypeScript strategy module`);
  if (!/export\s+const\s+descriptor\s*[:=]/.test(source))
    throw new Error(`provider ${entry.id} strategy module has no exported descriptor`);
  if (
    !/(?:const|export\s+const)\s+(?:strategy|legacyStrategy)\s*[:=]|\bfetchUsage\s*:/.test(source)
  )
    throw new Error(`provider ${entry.id} strategy module has no fetch strategy`);
  if (!/\bsettings\s*:/.test(source))
    throw new Error(`provider ${entry.id} strategy module has no provider config/settings mapping`);
};

export const validateProviderMatrix = ({
  source,
  canonicalProviderIds,
  pluginResourceFiles,
  trackedFiles,
  providerSources,
}: ProviderMatrixValidationOptions): readonly ProviderMatrixEntry[] => {
  const entries = parseProviderMatrix(source);
  const ids = entries.map((entry) => entry.id);
  if (ids.length !== 69) {
    throw new Error(`upstream/providers.yml must contain exactly 69 entries (found ${ids.length})`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("upstream/providers.yml contains duplicate provider IDs");
  }
  if (ids.join("\n") !== canonicalProviderIds.join("\n")) {
    throw new Error("upstream/providers.yml provider order does not match contracts/provider.ts");
  }
  const declaredCount = scalarValue(source, "providerCount", 0);
  if (declaredCount !== "69")
    throw new Error("upstream/providers.yml must declare providerCount: 69");

  for (const entry of entries) {
    validateImplementationContracts(entry, providerSources);
    if (entry.swiftGlobs.length === 0)
      throw new Error(`provider ${entry.id} is missing Swift oracle source mapping`);
    if (entry.swiftTestGlobs.length === 0 || entry.tsGlobs.length === 0)
      throw new Error(`provider ${entry.id} is missing Swift/TypeScript test mapping`);
    if (entry.fixtures.length === 0)
      throw new Error(`provider ${entry.id} is missing fixture/golden mapping`);
    for (const fixture of entry.fixtures) {
      if (!fixtureGlobResolves(fixture, trackedFiles))
        throw new Error(`provider ${entry.id} fixture mapping does not resolve: ${fixture}`);
    }
    if (entry.tsTestGlobs.length === 0)
      throw new Error(`provider ${entry.id} is missing TypeScript test mapping`);
    if (entry.status !== "unported" && entry.status !== "partial" && entry.status !== "parity")
      throw new Error(
        `provider ${entry.id} has invalid migration status '${entry.status ?? "missing"}'`,
      );
    if (entry.oracleStatus !== "pending" && entry.oracleStatus !== "accepted")
      throw new Error(`provider ${entry.id} must declare oracleStatus pending|accepted`);
    if (entry.status === "parity" && entry.oracleStatus !== "accepted")
      throw new Error(
        `provider ${entry.id} cannot be parity without an accepted Swift oracle comparison`,
      );
    if (!isSha(entry.lastReviewedCommit))
      throw new Error(`provider ${entry.id} is missing a valid lastReviewedCommit oracle mapping`);
  }

  for (const file of pluginResourceFiles) {
    const id = file.replace(/\.(?:js|ts)$/, "");
    if (!canonicalProviderIds.includes(id)) continue;
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new Error(`bundled plugin ${file} has no provider matrix entry`);
    const expectedPath = `Sources/CodexBarCore/Resources/Plugins/${file}`;
    if (!entry.swiftGlobs.includes(expectedPath)) {
      throw new Error(`provider ${id} does not track its bundled upstream source ${expectedPath}`);
    }
  }
  return entries;
};
