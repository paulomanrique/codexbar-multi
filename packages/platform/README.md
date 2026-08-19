# Platform persistence

`makeNodeSqlitePersistence` owns a Node-only usage database and returns the
structural adapters for `HistoryRepository` and `CostUsageRepository`. Opening
the database is an `Effect` because destructive migrations first create a
SQLite backup. `makeNodeSqliteWorkerPersistence` wraps the same implementation
in a dedicated `node:worker_threads` worker and is the desktop/CLI composition
default: it keeps synchronous SQLite calls off the Electron main thread and
CLI command loop.

- Connections enable WAL, foreign keys, a 5,000 ms busy timeout, `FULL`
  synchronous mode, and `quick_check` before and after migrations.
- All repository work passes through one FIFO in the SQLite-owning worker. Every append uses
  `BEGIN IMMEDIATE` and commits its provider row and complete record together.
- Migrations use `PRAGMA user_version`; migrations marked `destructive` write
  an owner-only `*.backup-v<version>-<timestamp>.sqlite` first.
- `makeNodeConfigRepository` implements the core configuration contract. It
  stores only schema-validated safe config
  JSON using same-directory staging, `0600`, file fsync, rename, and directory
  fsync where supported.

## Worker lifecycle

- Desktop main and CLI create one worker persistence instance at their
  composition root, pass its `history` and `costs` adapters to
  `makePlatformLayer`, and run `close` during graceful shutdown.
- In development the module-relative `node-persistence-worker.ts` runs through
  Node 24 native type stripping. Production composition emits the worker as a
  JavaScript asset and passes its `file:` URL as `workerUrl`; this deliberately
  keeps Vite from bundling SQLite/keyring native dependencies into the renderer
  or main entry. The desktop main and CLI build scripts own copying/emitting
  that asset beside their Node bundle.
- Effect interruption sends a cancellation message and terminates the worker.
  This prevents an in-flight synchronous query from becoming orphaned; SQLite
  recovers an interrupted `BEGIN IMMEDIATE` transaction atomically. Callers
  recreate the persistence instance after such cancellation.

## Deliberate gaps

- The repositories expose only append/list, so no retention, compaction,
  export, or backup-pruning policy is inferred here. Those need explicit core
  contracts and product ownership.
- SQLite's busy timeout coordinates with external processes, but an external
  process is not part of the in-process FIFO. Cross-process serialization is
  therefore provided by SQLite locking, not a custom broker.
