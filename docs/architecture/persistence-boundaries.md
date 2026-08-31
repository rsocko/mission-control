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
  - "[Issue #1680](https://github.com/rsocko/mission-control/issues/1680)"
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
loading worker schedulers. That composition now carries four members —
`connectors`/`syncRuns`, `execution` (Layer 2), `github` (Layers 3A/3B), and
`connectorState` (Layer 4) — and is registered atomically.

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

### Layer 4: non-finance connector-owned state

Layer 4 adds a third worker-registered composition,
`NonFinanceConnectorStateRepositories` (`src/db/persistence/work-todo.ts`),
exposed as `WorkerPersistenceRepositories.connectorState`. It is constructed in
the same atomic step as `ConnectorExecutionRepositories` and
`GitHubWorkerRepositories`, so a backend either has every migrated connector
surface or none.

Its single member today is `workTodo`, the Microsoft To Do - Work Power Automate
bridge. Its adapters are `createSqliteWorkTodoRepositories`
(`src/db/persistence/sqlite-work-todo-repositories.ts`) and
`createPostgresWorkTodoRepositories`
(`src/db/postgres/repositories/work-todo-repositories.ts`). Both share the pure
value derivations in `src/db/persistence/work-todo-values.ts`, so the two
backends compute byte-identical persisted values.

Six whole-operation commands replace the previous direct SQLite transaction
workflow:

- `ingest` — snapshot/delta acceptance, source-list upsert, source-ID dedupe,
  source tags, checklist reconciliation, deletion cleanup, and the bridge
  checkpoint;
- `lease` — expired-lease reclaim, active-lease reuse, supersede-on-newer-edit,
  bounded outbound-change enqueue, and the fenced lease claim;
- `readPullState` — the backend-neutral pull state the service formats into the
  unchanged standard/extended envelope;
- `acknowledge` — fenced per-item settlement;
- `readStatus` — the operator status projection; and
- `resetDelta` — checkpoint reset.

Transaction and effect ordering:

- Each command owns exactly one transaction. SQLite uses a short immediate
  (or deferred, for reads) transaction; PostgreSQL uses an explicit transaction
  and locks the connector row, the bridge-state row, the touched task rows, and
  the targeted outbound-change rows with `FOR UPDATE` before read-checking and
  writing them.
- Leases are taken in a deterministic bounded order (`created_at`, then
  `idempotency_key`) and are capped by `WORK_TODO_MAX_CHANGE_BATCH`. Only an
  expired lease is reclaimed; an active lease is returned unchanged so a retry
  is idempotent.
- Acknowledgement is fenced by connector, change status, lease ID, and the
  frozen task version. A stale lease/ack epoch cannot settle, and a delayed
  outcome can never regress a newer local edit — it is recorded as `stale` and
  the change becomes `superseded`.
- Checkpoints are conditionally monotonic. A replay carrying the same accepted
  instant still refreshes the checkpoint, but a strictly older delayed envelope
  keeps its idempotent task upserts while leaving the newer stored
  `list_delta_link`, per-list task delta links, `last_ingest_at`, and
  `last_ingest_mode` untouched. Instants are compared numerically, never by
  string ordering.
- No side effect runs inside a transaction. `ingest`/`acknowledge` return the
  bounded committed searchable projections and removed task IDs, and
  `src/lib/connectors/work-todo/service.ts` performs keyword/semantic index
  maintenance through the backend-aware `@/lib/sync/search-indexer` helpers
  *after* commit.
- Errors are the typed `WorkTodoBridgeError` (`code` + `status`), so routes and
  MCP tools keep their existing contract. Opaque delta links are returned only in
  the pull envelope; status never exposes them and nothing logs a payload body,
  delta link, credential, or SQL parameter.

`microsoft-todo` is now fully portable too: hidden-list discovery reads through
`execution.lists.list()` and the authenticated-user write uses the Layer 1
connector-settings merge patch (`@/lib/connectors/shared/connector-config-store`).

Reachability findings for the remaining non-finance connectors:

- **Rymessage** is notification-only and owns no Mission Control table. Its
  durable state is generic connector settings plus Layer 2 notification
  dedupe/reconciliation, so Layer 4 enables and proves that existing portable
  path instead of inventing a table. Its optional source-side SQLite reader in
  `rymessage-client.ts` opens *RyMessage's own* database file: that is external
  connector transport, not a Mission Control backend fallback, and no port
  imports it.
- **OWL** (`document-intelligence`) also owns no worker persistence table. Its
  normal task, source-list, source-tag, and notification writes already use the
  Layer 2 ports. Its scheduled triage importer is Layer 7 and its interactive
  task-action service is not worker-reachable; both stay out of scope.
- **Scout** is push-only (`capabilities.sync === false`), so production sync
  workers never poll it. Its ingest, status sync, and reconciliation are
  route/MCP workflows and its scheduled triage imports are Layer 7. No Scout
  persistence rewrite is justified in Layer 4; the existing PostgreSQL Scout
  schema is preserved and unassigned Scout workflows continue to fail closed.

Schema-parity result: **no migration was required**. SQLite and PostgreSQL
already define equivalent `work_todo_bridge_state`, `work_todo_list_delta_state`,
and `work_todo_outbound_changes` tables — including the composite delta-state
primary key, the `(connector_id, task_id, task_version)` uniqueness, the
ready/lease index, and the task index — plus the task/list/tag/association tables
the ingest and acknowledgement commands touch. SQLite JSON text versus
PostgreSQL `jsonb`, and integer versus native booleans, are adapter mapping
differences rather than schema gaps.

The PostgreSQL execution guard therefore now allows `microsoft-todo`,
`microsoft-todo-work`, Rymessage, and OWL. It still rejects `finance-manager`
connector-owned state, non-GitHub connector dependency state, non-GitHub
connector project state, and any connector exposing `syncDomainData`.

Layers 5-8 remain excluded: Monarch/finance, reminders, recovery beyond Layer
3B, the scheduled triage importer (#1681), deployment, and backend activation.

Surfaces Layers 3A/3B deliberately do not migrate stay SQLite-only and fail
closed under PostgreSQL *before* any remote effect: identity backfill and
status, manual identity-exception mutation, unknown
write-outcome resolution, interrupted write-cycle recovery, Monarch, reminders,
triage, and semantic/project automation. Connector-owned Work To Do bridge
state and Microsoft To Do hidden-list state are no longer in that list —
Layer 4 migrates both. Historical task-transfer succession filtering is
portable: both hierarchy adapters recompute a JSON-order-independent proof
digest and revalidate the immutable record against current task bindings and
locators before excluding the superseded task. Legacy insertion-ordered SQLite
proof digests remain readable. GitHub restore and operator recovery of deletion
snapshots also remain unsupported on PostgreSQL; only identity-fenced deletion
candidate quarantine, retention, and archival are enabled, and only when every
frozen epoch/binding/locator/source and task fence still matches.

The PostgreSQL execution guard continues to reject connector-owned finance
state and non-GitHub connector dependency or project state before connector
construction or remote dispatch. SQLite continues to use its compatibility
implementations for the remaining legacy workflows.
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
