import type { ProviderInstanceId } from "@codexbar/contracts";

/**
 * A source is a distinct account or local ledger within one provider. Source
 * identifiers intentionally are not provider instance identifiers: an account
 * source such as `codex:work` is internal-only and never crosses an IPC
 * boundary.
 */
export interface SpendSourceRosterEntry {
  readonly id: string;
  readonly providerId: ProviderInstanceId;
  readonly displayName: string;
  readonly role?: SpendSourceRole;
}

export type SpendSourceRole = "subscription" | "enrichment";

/** Mirrors SpendSourcePublication.State in the Swift oracle. */
export type SpendSourceState =
  | "loading"
  | "available"
  | "confirmed-empty"
  | "unavailable"
  | "stale-last-known";

export interface SpendPublicationInput {
  readonly id: string;
  readonly providerId: ProviderInstanceId;
  readonly displayName: string;
  readonly role?: SpendSourceRole;
}

export interface SpendSourcePublication {
  readonly id: string;
  readonly providerId: ProviderInstanceId;
  readonly displayName: string;
  readonly role: SpendSourceRole;
  readonly state: SpendSourceState;
}

/**
 * A deliberately opaque ownership marker produced by the desktop composition
 * root. Consumers must compare it before reusing a publication after account,
 * source, bucket, or settings changes.
 */
export interface SpendPublicationConfiguration {
  readonly ownershipFingerprint: string;
}

export interface SpendPublication<Input extends SpendPublicationInput> {
  readonly revision: number;
  readonly generation: number;
  readonly configuration: SpendPublicationConfiguration | undefined;
  readonly loadedAt: string;
  readonly isRefreshing: boolean;
  /** Canonical input order, without stale sources. */
  readonly inputs: ReadonlyArray<Input>;
  /** Canonical roster/source truth, including unavailable and empty sources. */
  readonly sources: ReadonlyArray<SpendSourcePublication>;
}

export interface CreateSpendPublicationRequest<Input extends SpendPublicationInput> {
  readonly revision: number;
  readonly generation: number;
  readonly configuration?: SpendPublicationConfiguration;
  readonly loadedAt: string;
  readonly isRefreshing: boolean;
  /** Ordered, configuration-owned source roster. */
  readonly roster: ReadonlyArray<SpendSourceRosterEntry>;
  /** Inputs retained by the caller; failed IDs become stale-last-known. */
  readonly inputs: ReadonlyArray<Input>;
  readonly failedSourceIds?: ReadonlySet<string>;
  readonly confirmedEmptySourceIds?: ReadonlySet<string>;
}

interface SourceOwner {
  readonly providerId: ProviderInstanceId;
  readonly displayName: string;
  readonly role: SpendSourceRole;
}

const sourceRole = (role: SpendSourceRole | undefined): SpendSourceRole => role ?? "subscription";
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const validCounter = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
};

const nonEmpty = (name: string, value: string): void => {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty.`);
};

/**
 * Builds the immutable logical publication used by both desktop overview and
 * spend dashboard projections. It has no I/O and never derives provider
 * ownership from a source ID, preventing cross-provider publication.
 */
export const createSpendPublication = <Input extends SpendPublicationInput>(
  request: CreateSpendPublicationRequest<Input>,
): SpendPublication<Input> => {
  validCounter("Spend publication revision", request.revision);
  validCounter("Spend publication generation", request.generation);
  nonEmpty("Spend publication loadedAt", request.loadedAt);
  if (!isoDatePattern.test(request.loadedAt) || !Number.isFinite(Date.parse(request.loadedAt))) {
    throw new TypeError("Spend publication loadedAt must be an ISO-8601 timestamp.");
  }
  if (
    request.configuration !== undefined &&
    request.configuration.ownershipFingerprint.trim().length === 0
  ) {
    throw new TypeError("Spend publication ownership fingerprint must not be empty.");
  }

  const owners = new Map<string, SourceOwner>();
  const order: string[] = [];
  for (const source of request.roster) {
    nonEmpty("Spend source ID", source.id);
    nonEmpty("Spend source display name", source.displayName);
    if (owners.has(source.id))
      throw new TypeError(`Spend source '${source.id}' appears more than once.`);
    owners.set(source.id, {
      providerId: source.providerId,
      displayName: source.displayName,
      role: sourceRole(source.role),
    });
    order.push(source.id);
  }

  const inputById = new Map<string, Input>();
  for (const input of request.inputs) {
    nonEmpty("Spend input ID", input.id);
    nonEmpty("Spend input display name", input.displayName);
    if (inputById.has(input.id))
      throw new TypeError(`Spend input '${input.id}' appears more than once.`);
    const owner = owners.get(input.id);
    if (owner !== undefined && owner.providerId !== input.providerId) {
      throw new TypeError(`Spend input '${input.id}' does not belong to its roster provider.`);
    }
    inputById.set(input.id, input);
  }

  const failedSourceIds = request.failedSourceIds ?? new Set<string>();
  const confirmedEmptySourceIds = request.confirmedEmptySourceIds ?? new Set<string>();
  for (const id of [...inputById.keys()].sort()) order.push(id);
  for (const id of [...confirmedEmptySourceIds].sort()) order.push(id);
  for (const id of [...failedSourceIds].sort()) order.push(id);

  const seen = new Set<string>();
  const sources: SpendSourcePublication[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const input = inputById.get(id);
    const owner = owners.get(id);
    // Failed/empty IDs without a roster or retained input have no provider
    // authority. Do not create a phantom coverage denominator for them.
    if (input === undefined && owner === undefined) continue;
    if (input !== undefined && owner !== undefined && input.providerId !== owner.providerId) {
      throw new TypeError(`Spend source '${id}' has conflicting provider ownership.`);
    }
    const providerId = owner?.providerId ?? input?.providerId;
    const displayName = input?.displayName ?? owner?.displayName;
    if (providerId === undefined || displayName === undefined) continue;
    sources.push({
      id,
      providerId,
      displayName,
      // A loaded source can turn a configured subscription into enrichment
      // (OpenCodex does this upstream); ownership still fixes its provider.
      role: input?.role ?? owner?.role ?? "subscription",
      state:
        input !== undefined
          ? failedSourceIds.has(id)
            ? "stale-last-known"
            : "available"
          : confirmedEmptySourceIds.has(id)
            ? "confirmed-empty"
            : request.isRefreshing
              ? "loading"
              : "unavailable",
    });
  }

  const sourceOrder = new Map(sources.map((source, index) => [source.id, index]));
  const inputs = request.inputs
    .filter((input) => !failedSourceIds.has(input.id))
    .toSorted((left, right) => (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0));

  return {
    revision: request.revision,
    generation: request.generation,
    configuration: request.configuration,
    loadedAt: request.loadedAt,
    isRefreshing: request.isRefreshing,
    // A stale-last-known input stays available for UI diagnostics but is not a
    // canonical spend input for overview totals.
    inputs,
    sources,
  };
};

export const visibleSpendPublicationInputs = <Input extends SpendPublicationInput>(
  publication: SpendPublication<Input>,
  providerIds?: ReadonlySet<ProviderInstanceId>,
): ReadonlyArray<Input> => {
  const availableIds = new Set(
    publication.sources
      .filter((source) => source.state === "available")
      .filter((source) => providerIds === undefined || providerIds.has(source.providerId))
      .map((source) => source.id),
  );
  return publication.inputs.filter(
    (input) =>
      availableIds.has(input.id) &&
      (providerIds === undefined || providerIds.has(input.providerId)),
  );
};

export interface SpendPublicationLease {
  readonly generation: number;
  readonly signal: AbortSignal;
}

/**
 * Owns only publication admission. Callers retain fetching and persistence;
 * replacing or cancelling a lease makes a late result inert before it can
 * reach the shared overview/dashboard state.
 */
export class SpendPublicationCoordinator<Input extends SpendPublicationInput> {
  private revision = 0;
  private generation = 0;
  private controller: AbortController | undefined;
  private publication: SpendPublication<Input> | undefined;

  begin(): SpendPublicationLease {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.generation += 1;
    return { generation: this.generation, signal: controller.signal };
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.generation += 1;
  }

  isCurrent(lease: SpendPublicationLease): boolean {
    return (
      this.controller?.signal === lease.signal &&
      !lease.signal.aborted &&
      this.generation === lease.generation
    );
  }

  publish(
    lease: SpendPublicationLease,
    request: Omit<CreateSpendPublicationRequest<Input>, "revision" | "generation">,
  ): SpendPublication<Input> | undefined {
    if (!this.isCurrent(lease)) return undefined;
    const next = createSpendPublication({
      ...request,
      revision: this.revision + 1,
      generation: lease.generation,
    });
    // A caller may synchronously abort while constructing a malicious or slow
    // request. Recheck immediately before committing the shared state.
    if (!this.isCurrent(lease)) return undefined;
    this.revision = next.revision;
    this.publication = next;
    return next;
  }

  current(): SpendPublication<Input> | undefined {
    return this.publication;
  }
}
