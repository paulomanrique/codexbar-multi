import type {
  ExecuteLegacyImportRequestDTO,
  LegacyImportExecutionResultDTO,
  LegacyImportInspectionResultDTO,
  LegacyImportRollbackResultDTO,
  RollbackLegacyImportRequestDTO,
} from "@codexbar/contracts";
import type { LegacyImportInspection } from "@codexbar/core";
import type {
  NodeLegacyImportOptions,
  NodeLegacyImportResult,
  NodeLegacyRollbackResult,
} from "@codexbar/platform/node";

const INSPECTION_TTL_MILLISECONDS = 10 * 60 * 1_000;
const OPAQUE_ID_PATTERN = /^[a-z0-9-]{1,48}$/u;

export interface DesktopLegacyImportAdapter {
  readonly inspect: (options: NodeLegacyImportOptions) => Promise<LegacyImportInspection>;
  readonly execute: (options: NodeLegacyImportOptions) => Promise<NodeLegacyImportResult>;
  readonly rollback: (
    options: NodeLegacyImportOptions & { readonly importId: string },
  ) => Promise<NodeLegacyRollbackResult>;
}

export interface DesktopLegacyImportHost {
  /** Native directory picker. The selected path never crosses preload IPC. */
  readonly selectLegacyRoot: () => Promise<string | undefined>;
  /** Native confirmation owned by Electron main, not a renderer Boolean. */
  readonly confirm: (action: "execute" | "rollback", itemCount: number) => Promise<boolean>;
}

export interface DesktopLegacyImportPaths {
  readonly destinationRoot: string;
  readonly databasePath: string;
  readonly targetConfigPath: string;
  readonly targetPluginsPath: string;
}

interface PendingInspection {
  readonly ticket: string;
  readonly expiresAt: number;
  readonly options: NodeLegacyImportOptions & { readonly importId: string };
  readonly inspection: LegacyImportInspection;
}

const projectInspection = (
  ticket: string,
  inspection: LegacyImportInspection,
): LegacyImportInspectionResultDTO => ({
  status: "ready",
  ticket,
  candidates: inspection.candidates.slice(0, 4).map((candidate) => ({
    kind: candidate.kind,
    state: candidate.state,
    itemCount: candidate.itemCount,
    byteCount: candidate.byteCount,
  })),
  excludedFeatures: [...inspection.excludedFeatures],
  sqliteCompatibility: "not-attempted",
});

const readyItemCount = (inspection: LegacyImportInspection): number =>
  inspection.candidates
    .filter((candidate) => candidate.state === "ready")
    .reduce(
      (total, candidate) =>
        Math.min(
          Number.MAX_SAFE_INTEGER,
          total + Math.min(candidate.itemCount, Number.MAX_SAFE_INTEGER),
        ),
      0,
    );

/**
 * Host-only capability broker for the opt-in migration. Renderer requests use
 * short-lived opaque tickets; paths, filenames, parse reasons, source values,
 * journals and backups remain confined to Electron main/platform.
 */
export class DesktopLegacyImportController {
  readonly #adapter: DesktopLegacyImportAdapter;
  readonly #host: DesktopLegacyImportHost;
  readonly #paths: DesktopLegacyImportPaths;
  readonly #now: () => number;
  readonly #nextOpaqueId: () => string;
  #pending: PendingInspection | undefined;
  #active: AbortController | undefined;
  #busy = false;

  constructor(options: {
    readonly adapter: DesktopLegacyImportAdapter;
    readonly host: DesktopLegacyImportHost;
    readonly paths: DesktopLegacyImportPaths;
    readonly now?: () => number;
    readonly nextOpaqueId: () => string;
  }) {
    this.#adapter = options.adapter;
    this.#host = options.host;
    this.#paths = options.paths;
    this.#now = options.now ?? Date.now;
    this.#nextOpaqueId = options.nextOpaqueId;
  }

  inspect(): Promise<LegacyImportInspectionResultDTO> {
    return this.#exclusive(async (signal) => {
      // Starting a new native selection revokes the previous renderer ticket,
      // including when the new picker is cancelled.
      this.#pending = undefined;
      const legacyRoot = await this.#host.selectLegacyRoot();
      if (legacyRoot === undefined) return { status: "cancelled" };
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const ticket = this.#opaqueId("ticket");
      const importId = this.#opaqueId("legacy");
      const options = this.#options(legacyRoot, importId, signal);
      const inspection = await this.#adapter.inspect(options);
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      this.#pending = {
        ticket,
        expiresAt: this.#now() + INSPECTION_TTL_MILLISECONDS,
        options,
        inspection,
      };
      return projectInspection(ticket, inspection);
    });
  }

  execute(request: ExecuteLegacyImportRequestDTO): Promise<LegacyImportExecutionResultDTO> {
    return this.#exclusive(async (signal) => {
      const pending = this.#pending;
      if (
        pending === undefined ||
        pending.ticket !== request.ticket ||
        pending.expiresAt <= this.#now()
      ) {
        this.#pending = undefined;
        throw new Error("Legacy import inspection is missing or expired");
      }
      const confirmed = await this.#host.confirm("execute", readyItemCount(pending.inspection));
      if (!confirmed) return { status: "cancelled" };
      // Consume before mutation so concurrent/replayed renderer calls cannot
      // start the same import. The journal/importId remains host-owned.
      this.#pending = undefined;
      const result = await this.#adapter.execute({ ...pending.options, signal });
      return {
        status: result.status,
        importId: result.importId,
        imported: { ...result.imported },
        skippedCount: result.skipped.length,
      };
    });
  }

  rollback(request: RollbackLegacyImportRequestDTO): Promise<LegacyImportRollbackResultDTO> {
    return this.#exclusive(async (signal) => {
      const confirmed = await this.#host.confirm("rollback", 0);
      if (!confirmed) return { status: "cancelled" };
      const result = await this.#adapter.rollback({
        ...this.#options(this.#paths.destinationRoot, request.importId, signal),
        importId: request.importId,
      });
      return {
        status: "completed",
        importId: result.importId,
        removed: { ...result.removed },
        skippedCount: result.skipped.length,
      };
    });
  }

  cancel(): void {
    this.#pending = undefined;
    this.#active?.abort();
  }

  #options(
    legacyRoot: string,
    importId: string,
    signal: AbortSignal,
  ): NodeLegacyImportOptions & { readonly importId: string } {
    return {
      legacyRoot,
      destinationRoot: this.#paths.destinationRoot,
      databasePath: this.#paths.databasePath,
      targetConfigPath: this.#paths.targetConfigPath,
      targetPluginsPath: this.#paths.targetPluginsPath,
      importId,
      signal,
    };
  }

  #opaqueId(prefix: "ticket" | "legacy"): string {
    const value = this.#nextOpaqueId().toLowerCase();
    if (!OPAQUE_ID_PATTERN.test(value)) throw new Error("Legacy import capability ID is invalid");
    return `${prefix}-${value}`;
  }

  async #exclusive<Value>(operation: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
    if (this.#busy) throw new Error("Another legacy import operation is already active");
    this.#busy = true;
    const controller = new AbortController();
    this.#active = controller;
    try {
      return await operation(controller.signal);
    } finally {
      if (this.#active === controller) this.#active = undefined;
      this.#busy = false;
    }
  }
}
