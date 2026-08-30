---
title: "Portable Persistence Boundaries"
status: active
created: 2026-08-25
last_reviewed: 2026-08-30
category: architecture
related:
  - "[Database Scaling and Migration Strategy](../design/active/database-scaling-strategy.md)"
  - "[Ideation Workspace Persistence](./ideation-workspace-persistence.md)"
  - "[Issue #1159](https://github.com/rsocko/mission-control/issues/1159)"
---

# Portable Persistence Boundaries

## Decision

New application persistence must use a focused repository or application-service
port. Driver handles, ORM transaction objects, SQL fragments, PRAGMAs, and
backend error strings are adapter details. Existing direct SQLite access will be
migrated incrementally behind compatibility facades rather than rewritten all
at once.

These boundaries now support the core SQLite and PostgreSQL persistence
compositions. PostgreSQL is the approved production target and is selected
explicitly; SQLite remains the default compatibility backend. Existing direct
SQLite workflows are still being migrated incrementally and fail explicitly
under PostgreSQL instead of falling back or creating a split-backend workflow.

## Current dependency inventory

The August 2026 audit found:

- 26 production files importing `better-sqlite3` directly;
- 49 production files importing the raw `sqlite` handle from `@/db`;
- 51 production files issuing about 650 direct
  `prepare`/`exec`/`transaction`/`pragma` calls; and
- more than 100 production imports of either the raw handle or the
  SQLite-backed `runTransaction` helper.

The counts are a migration-risk baseline, not a rewrite checklist. An automated
dependency ratchet prevents the direct-driver and raw-handle inventories from
growing without an explicit exception.

| Capability | SQLite dependency | Primary locations | Risk and boundary |
|---|---|---|---|
| Connection | `better-sqlite3`, local file creation, WAL, foreign keys, busy timeout | `src/db/index.ts`, `src/db/bootstrap/connection.ts` | High. Connection creation and configuration belong to the SQLite runtime adapter. |
| Bootstrap and migrations | statement splitting, `sqlite_master`, `PRAGMA table_info`, SQLite error text, safety nets and repairs | `src/db/bootstrap/**` | High. Ordered bootstrap is a capability adapter; application code must not call it. |
| Transactions | synchronous callbacks, `BEGIN IMMEDIATE` behavior through `better-sqlite3`, raw transaction handles | `src/db/index.ts` and multi-table workflows | High. A focused operation owns commit/rollback; transaction handles do not escape. |
| Durable queue | raw claim/update SQL, SQLite time functions, immediate transactions, connector leases | `src/lib/sync/sqlite-job-repository.ts` and `src/lib/sync/sqlite-connector-operation-lease-repository.ts` | Critical. Queue mechanics live behind the sync-job and connector-operation lease repository facades. |
| Search | FTS5 virtual tables, `MATCH`, `bm25`, `sqlite_master` | `src/lib/search/fts.ts` | High. Keyword search/indexing uses a backend-specific repository. |
| Health and telemetry | `PRAGMA page_count`, page size, WAL checkpoints and SQLite observation | `src/lib/telemetry/**`, readiness route | High. Runtime health consumes a database-health probe result. |
| Graph workspace | raw row mapping, JSON text, compare-and-swap writes and checkpoints | `src/lib/graph-workspace/sqlite-repository.ts` | Medium. An existing repository seam is the representative portable workflow. |
| Tasks and projects | Drizzle queries plus shared `runTransaction` | task APIs and project services | Medium. Migrate by canonical workflow, not table-by-table. |
| Notifications and connectors | mixed Drizzle and raw SQLite write paths | notification writeback, connector stores and sync services | High. Move correctness-sensitive commands behind focused services first. |
| Finance, external identity, AI runs and agents | concentrated raw SQL and synchronous transactions | corresponding `src/lib` domains | High, but outside the representative migration. Preserve as documented legacy exceptions until each workflow moves. |

## Portable contract rules

### Values

- IDs are opaque application strings. Callers do not depend on row IDs,
  sequences, UUID database functions, or integer coercion.
- Timestamps cross repositories as canonical UTC ISO-8601 strings. Adapters own
  database timestamp conversion.
- Booleans cross repositories as `boolean`, even when SQLite stores `0`/`1`.
- JSON crosses repositories as parsed, validated values. Adapters own text or
  native JSON serialization.
- Nullability is explicit. Missing records return documented `null` or a domain
  result; they are not inferred from a driver error.
- Pagination has a bounded limit and stable ordering. A cursor is opaque to the
  caller and may not expose backend row identifiers.

### Transactions and errors

The application operation, not a route or low-level query helper, owns the
transaction boundary. A transaction-scoped collaborator:

1. is valid only inside the callback;
2. cannot expose raw SQL, Drizzle, or driver handles;
3. commits only after the operation returns successfully;
4. rolls back and rethrows the original error on failure; and
5. must not start fire-and-forget work.

Repository APIs are Promise-based so asynchronous adapters can implement them.
`PersistenceBackend` exposes the synchronous transaction-work capability common
to all backends; an asynchronous backend can additionally expose
`TransactionRunner` where a workflow explicitly supports yielding transaction
work.
The SQLite adapter still executes each atomic callback synchronously; it rejects
a callback that yields a Promise because keeping a synchronous shared
connection transaction open across an `await` could admit unrelated work.

Expected conflicts, constraints, and unavailable conditions use repository or
domain errors. Backend message matching is permitted only inside an adapter.

## Capability adapters and compatibility facades

Backend-specific behavior is named explicitly:

- `SqliteTransactionRunner` owns immediate/deferred transaction execution.
- SQLite keyword search owns FTS5 schema, ranking, query syntax, and rebuilds.
- SQLite database health owns file/page/WAL and PRAGMA interpretation.
- SQLite bootstrap owns migrations, schema safety nets, and repairs.
- SQLite sync-job persistence owns queue claim, retry, schedule, event, and
  metric SQL. Connector-operation persistence owns active-job checks,
  acquire/renew/release outcomes, and expired-job recovery.

Existing import paths remain compatibility facades while consumers migrate.
Facades expose domain values and operations, never the backend handle.

Core task, project, connector, notification, and settings CRUD is composed once
through `registerCorePersistenceRepositories(repositories)` and consumed through
`getCorePersistenceRepositories()`. SQLite is the compatibility default. A
runtime backend selector registers the complete PostgreSQL
`CorePersistenceRepositories` composition when explicitly configured before
request handling. Consumers must not select repositories individually because
that can split one workflow across backends. Registration is one-time and
cannot replace a composition after it has been registered or consumed.

Worker connector refresh, connector-settings updates, and sync-run journal
hydration/finalization are composed together through
`registerWorkerPersistenceRepositories(repositories)`. Both backends implement
the same atomic nested-settings patch and successful-pull baseline contract.
SQLite loads its worker adapters lazily on first access so importing a connector
does not initialize the database. PostgreSQL has no compatibility fallback: its
runtime must register the complete worker composition before access and before
loading worker schedulers.

Layer 2 adds the complete `ConnectorExecutionRepositories` composition to that
worker registration. Its phase-oriented ports own:

- source-list discovery, stale cleanup, display records, and folder assignment;
- task push selection and fenced claim/heartbeat/complete/fail/release outcomes;
- bounded pull task/tag batches, marker adoption, conditional remote updates,
  parent correction, recurrence cleanup, and stale-status correction;
- connector notification/action/delivery-occurrence ingestion plus
  reconciliation and metadata updates;
- two-observation deletion quarantine, snapshots/restores, and retention-detail
  claim/renew/finalize compare-and-swap operations; and
- atomic conflict application with its audit row.

The managers prepare immutable commands and never receive a driver, Drizzle
schema, or transaction handle. SQLite adapters use short immediate transactions;
PostgreSQL adapters use async transactions and row locks. A remote operation
always follows durable read/claim, remote side effect, then a conditional
persistence outcome. Task-page indexing, notification dispatcher wakeups, AI
enrichment, source reconciliation calls, and all connector traffic run outside
adapter transactions.

Successful durable jobs first write an unlinked, unsuccessful provisional
sync-log row. One repository transaction then verifies both running job
ownership and the active connector lease, publishes and links that exact
sync-log ID, marks the job succeeded, and releases the connector lease. Any
missing ownership, lease, or exact log rolls the operation back, so a stale
worker cannot advance either the persisted or in-memory incremental baseline.
Failure logs are linked by the same durable sync-run identity before the
existing retry or terminal transition.

PostgreSQL now supports the generic list/task push/task pull/notification path.
Layer 3A additionally migrates *normal* GitHub queue execution behind a second
worker-registered composition, `GitHubWorkerRepositories`
(`src/db/persistence/github-worker.ts`). It is registered atomically alongside
`ConnectorExecutionRepositories`, so a backend either has all six members or
none:

- `identity` — the durable GitHub identity epoch, transactional primary
  task/source-list NodeID binding persistence, NodeID batch lookup,
  binding/locator revision currency checks, linked-source identity
  resolve/persist, and accepted terminal-inaccessible exception reads;
- `writeFence` — write-cycle begin/observe/finish, task and source write-lease
  authorization, dispatch confirmation, preflight verification, finalization,
  block, and unknown-outcome quarantine;
- `dependencies` — dependency snapshot/item/edge/candidate persistence, cursor
  compare-and-set batch apply, retry/backoff, terminal-partial abandonment on an
  identity-epoch change, bounded terminal snapshot history, idempotent edge
  writes, targeted reconciliation, and health/resume reads;
- `hierarchy` — GitHub task population reads, stable binding/locator
  resolution, accepted terminal-inaccessible read protection, and the fenced
  parent/depth/metadata apply; and
- `projects` — sync-managed hub-project upsert and authoritative `task_projects`
  association reconciliation; and
- `recovery` — the Layer 3B operator recovery composition
  (`src/db/persistence/github-recovery.ts`), split into `transfer`,
  `bulkTransfer`, and `repoint` sub-ports.

### Layer 3B: GitHub recovery persistence

`recovery` covers native GitHub issue transfer, historical task-transfer
succession reconciliation, bulk transfer runs, and repository repoint. Its
adapters are `createSqliteGitHubRecoveryRepositories`
(`src/db/persistence/sqlite-github-recovery-repositories.ts`) and
`createPostgresGitHubRecoveryRepositories`
(`src/db/postgres/repositories/github-recovery-repositories.ts`, with shared
locator/collision/binding helpers in `github-recovery-support.ts`).

Transaction and effect ordering:

- Every GitHub HTTP call, verification retry, and rate-limit sleep runs in
  `repoint-service.ts` / `bulk-transfer-service.ts` *outside* any adapter
  transaction. Adapter methods only accept synchronous pure callbacks
  (`refreshMetadata`), never a remote-I/O callback.
- Each adapter method owns at most one short transaction. Inside it the adapter
  re-reads and re-checks the operation phase, maintenance-lock ownership,
  connector activity (queued/running sync jobs and operation leases), the
  identity-mode revision, the bulk item state, the task route, the active
  stable binding, and the current locator revision before writing. PostgreSQL
  takes explicit `FOR UPDATE` locks on those rows.
- `applyOperation` returns `not-applicable` when the operation already left
  `locked`, so a resumed execute is idempotent rather than double-applying.
- `rollbackOperation` implements both the first rollback and the idempotent
  rolled-back source-list repair, and leaves the connector disabled.
- Locator collisions map to bounded domain outcomes (`{ outcome: 'collision' }`,
  `{ outcome: 'collision', scope }`) after recording a bounded
  `github_identity_collisions` row and disabling the connector; they are never
  surfaced as driver errors.
- Results carry SHA-256 digests instead of raw node IDs wherever a digest is
  sufficient, and the only credential-bearing method is
  `transfer.getConnectorCredentials`, which callers use solely to construct a
  GitHub client.

Backup evidence is a *value*, not a capability. `GitHubRecoveryBackupAttestation`
(digest, size, timestamps, integrity status, and evidence `source`) flows
through the backend-neutral service contract. The SQLite file verifier lives in
`src/lib/connectors/github-issues/backup-verifier.ts` as an allowlisted edge
helper — it is the only module that opens a database file, nothing in the ports
imports it, and this repository still ships no PostgreSQL dump, restore, or
deployment tooling. PostgreSQL operators supply an equivalent externally
verified attestation (`source: 'external-preverified'`). The shared validator
requires both the snapshot modification and verification timestamps to fall
within the same inclusive 24-hour window, with at most five minutes of future
clock skew; re-verifying an old snapshot cannot refresh it.

No PostgreSQL schema migration was required: `drizzle/postgres/0000_handy_orphan.sql`
already creates `github_repository_repoints`, `github_repository_repoint_events`,
`github_bulk_transfer_runs`, `github_bulk_transfer_items`,
`github_bulk_transfer_successions`, `github_bulk_transfer_events`, and
`github_identity_task_transfer_reconciliations` with matching phase/state checks,
idempotency uniqueness, and succession/audit constraints.

Every fence is frozen as a value and re-checked with SQL *inside* the final
write transaction: the identity epoch, the write-cycle state, the lease token
and state, the task push-lease claim (`sync_status='pushing'` plus the
`last_synced_at` token), the lease-target binding and locator revisions, the
dependency snapshot cursor, and the hierarchy population digest and identity
fingerprint. No remote effect happens inside a transaction, and callers pass
only synchronous pure derivation callbacks into a port method when a value must
be computed from a row read within that transaction.

Because the composition is atomic, `src/sync-worker.ts` starts dependency
reconciliation resume and relationship polling only when the whole GitHub
composition is present and the execution support reports the
`dependency-reconciliation` workflow as allowed.

Surfaces Layers 3A/3B deliberately do not migrate stay SQLite-only and fail
closed under PostgreSQL *before* any remote effect: identity backfill and
status, manual identity-exception mutation, unknown
write-outcome resolution, interrupted write-cycle recovery, connector-owned
state, Microsoft To Do hidden-list state, Monarch, reminders, triage, and
semantic/project automation. Historical task-transfer succession filtering is
portable: both hierarchy adapters recompute a JSON-order-independent proof
digest and revalidate the immutable record against current task bindings and
locators before excluding the superseded task. Legacy insertion-ordered SQLite
proof digests remain readable. GitHub restore and operator recovery of deletion
snapshots also remain unsupported on PostgreSQL; only identity-fenced deletion
candidate quarantine, retention, and archival are enabled, and only when every
frozen epoch/binding/locator/source and task fence still matches.

The PostgreSQL execution guard continues to reject Microsoft To Do hidden-list
state, connector-owned finance or Work To Do bridge state, and non-GitHub
connector dependency or project state before connector construction or remote
dispatch. SQLite continues to use its compatibility implementations for the
remaining legacy workflows.
Generic PostgreSQL runs use the backend-selected keyword search repository
after commit. SQLite-only semantic enrichment, project-rule/planning
post-processing, the legacy outbound-event outbox, and the legacy notification
dispatcher are not invoked from that path; their durable rows remain available
for later backend-specific workers rather than falling back to SQLite.

The PostgreSQL implementation also supplies backend-specific migrations, sync
jobs and connector-operation leases, full-text search, database health
snapshots, and runtime telemetry. This is application capability, not evidence
that a deployment has completed its data migration or cutover. See the
[database scaling and migration strategy](../design/active/database-scaling-strategy.md).

## Domain migration sequence

Migrate one correctness-sensitive workflow at a time:

1. define the command/query port and domain outcomes;
2. move SQL, mapping, serialization, and backend errors into an adapter;
3. compose the adapter at the runtime boundary;
4. run the shared contract suite against the adapter;
5. migrate the application service and its routes/workers; and
6. remove that path from the legacy raw-access allowlist.

Ideation workspaces are the first representative vertical slice. The same
pattern should later be applied to canonical task moves, project hierarchy,
notification writeback, connector configuration, and durable queue workflows.
It is not a mandate to create repositories for every table.

## Backend-specific exceptions

Direct backend access is justified only for a capability that cannot be
expressed portably without losing required behavior, such as SQLite FTS5,
PRAGMA/WAL telemetry, migration introspection, or atomic queue claiming.

An exception must:

- live in an explicitly backend-named adapter or an existing allowlisted legacy
  module;
- be listed in this inventory with its migration risk;
- expose a backend-neutral result or compatibility facade;
- include adapter or contract coverage; and
- avoid leaking driver types or backend errors to application callers.

Adding a new allowlist entry requires the same documentation and test update.
Feature code must not import `better-sqlite3` or the raw `sqlite` handle merely
because an adjacent module already does.
