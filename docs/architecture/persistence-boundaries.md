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
| Graph workspace | raw row mapping, JSON text, compare-and-swap writes and checkpoints | `src/lib/graph-workspace/sqlite-repository.ts` | Migrated (L16). Both backends implement `IdeationWorkspaceRepository`; the SQLite adapter is one of two composed behind the `ideationWorkspaces` worker slot. |
| Tasks and projects | Drizzle queries plus shared `runTransaction` | task APIs and project services | Medium. Migrate by canonical workflow, not table-by-table. |
| Notifications and connectors | mixed Drizzle and raw SQLite write paths | notification writeback, connector stores and sync services | High. Move correctness-sensitive commands behind focused services first. L13 migrated seven notification web routes and the writeback dispatcher behind `NotificationWebPersistence` (attached as `notificationDelivery.web`). |
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
loading worker schedulers. That composition now carries five members —
`connectors`/`syncRuns`, `execution` (Layer 2), `github` (Layers 3A/3B),
`connectorState` (Layer 4), and `finance` (Layers 5A-5C) — and is registered
atomically.

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
`ConnectorExecutionRepositories`, so a backend either has all seven members or
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
  `bulkTransfer`, and `repoint` sub-ports; and
- `operator` — the five pre-existing, previously audited GitHub worker
  operator/recovery surfaces (identity backfill/status, manual
  terminal-inaccessible exception mutation, unknown write-outcome resolution,
  interrupted write-cycle recovery), exposed through
  `GitHubIdentityOperatorPersistence` (`src/db/persistence/
  github-identity-operator.ts`) so `scripts/github-identity-operator.ts` can
  reach them without importing `@/db` directly. See "Layer L06" below for why
  its PostgreSQL adapter is not a genuine implementation.

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
- Checkpoints are monotonic and fail closed. A replay carrying the same accepted
  instant is still applied idempotently and refreshes the checkpoint, but a
  strictly older envelope is rejected with `STALE_INGEST_ENVELOPE` (409)
  immediately after the bridge-state row is read (PostgreSQL: locked with
  `FOR UPDATE`) and *before* any task, list, tag, checklist, or removal
  mutation. A delayed delivery therefore cannot resurrect superseded data,
  re-apply a removal the newer envelope settled, or regress the stored
  `list_delta_link`, per-list task delta links, `last_ingest_at`, and
  `last_ingest_mode`. Instants are compared numerically, never by string
  ordering.
- Task removal reuses the canonical cleanup shared with the core task
  repository and connector execution
  (`src/db/persistence/task-deletion.ts` defines the association tables;
  `src/db/persistence/sqlite-task-deletion.ts` and
  `src/db/postgres/repositories/task-deletion.ts` are the two backend helpers).
  A removed Work To Do task and every descendant clear tags, projects,
  schedules, field states, My Day/exclusions, focus, weekly one-thing,
  priority/triage/quick-sort audit rows, linked sources, attachments, phase
  items, deletion candidates, and dependencies, and null
  `notifications.related_task_id` rather than deleting the notification. The
  descendant walk stays cycle-guarded and depth-first.
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

### Layers 5-8: complete PostgreSQL worker persistence

Layer 5A adds the atomic `FinanceWorkerPersistence` composition for Monarch
identity, transaction snapshots, reference datasets, and attribution. Layer 5B
extends that same composition rather than registering a second finance runtime:

- `insights` owns history projection attempts and proof promotion, transaction
  backfill plans, publication and delivery checkpoints, the occurrence cache,
  and finance notification ingestion/outbox writes; and
- `attention` owns the bounded attention projection, deterministic routing and
  promotion, plus dry-run/apply recovery with digest and delivery fences.

Both members expose asynchronous, driver-free operations. Their SQLite and
PostgreSQL adapters own every transaction, keep bulk work bounded, preserve
monotonic checkpoints and idempotency keys, and return identifiers or digests
instead of driver rows. The API and Monarch orchestration modules now use these
ports for the migrated operations; external connector traffic and dispatcher
wakeups remain outside adapter transactions.

Layer 5C activates the packaged finance worker on PostgreSQL. Its execution
graph uses portable snapshot, dataset, attribution, history, publication,
notification-ingestion, occurrence, and attention modules. Layer 6 ports the
notification delivery dispatcher and task reminders, Layer 7 ports scheduled
triage imports, and Layer 8 ports Monarch connection-outage recovery through a
`FinanceWorkerPersistence.recovery` member. The recovery adapters preserve the
existing episode fence, deterministic notification/task identities, bounded
verification, escalation thresholds, and restart settlement semantics.

The Layer 8 composition check is atomic: `core`, `syncRuns`, `execution`,
`github`, `finance` (including `recovery`), `notificationDelivery`, `reminders`,
and `triage` must all be registered before the PostgreSQL worker starts. Missing
registration fails closed and cannot construct the SQLite composition. SQLite
control state, maintenance locks, connector leases, FTS, database telemetry,
connector configuration, and Microsoft token persistence are selected lazily
or resolved through backend-neutral repositories.

Schema-parity result: **no migration was required**. The existing finance
history, projection, backfill, publication, occurrence, notification/action/
outbox, attribution-exception, mutation-audit, task, and My Day tables already
carry the required uniqueness, ordering, checkpoint, and fencing state on both
backends. SQLite text JSON/timestamps and PostgreSQL native JSON/timestamps are
adapter mapping differences.

The exact PostgreSQL worker support matrix after Layer 8 is:

| Surface | PostgreSQL worker status |
| --- | --- |
| Startup, graceful shutdown, repository registration, and queue polling | Supported; registration is atomic and fail closed |
| Connector execution, retries, stale claims/leases, cancellation, and restart recovery | Supported with durable claim-token and CAS fencing |
| GitHub dependency/project execution and deletion candidate recovery | Supported through the GitHub worker repositories |
| `finance`, `finance-manager`, or `monarch-money` with `syncDomainData` | Supported through the complete `FinanceWorkerPersistence` composition |
| Non-finance connector exposing `syncDomainData` | Rejected before remote dispatch |
| Non-GitHub dependency or project state | Rejected before remote dispatch |
| Finance notification/action/outbox persistence and delivery wake | Supported and durable |
| Notification delivery dispatcher and reminders (Layer 6) | Supported with durable claims, delivery attempts, and reminder leases |
| Scheduled triage importer (Layer 7) | Supported with revision-fenced source leases |
| Monarch connection-outage recovery (Layer 8) | Supported with episode fencing, bounded verification, escalation, and settlement |
| Health snapshots, runtime telemetry, Houston retention, and cron scheduling | Supported without loading the SQLite singleton |

The packaging guard starts at the real packaged entry, `src/sync-worker.ts`. It
walks the PostgreSQL source import graph, rejects eager Mission Control SQLite
modules and drivers, asserts the exact legacy entry gates, and verifies every
scheduler family is reachable. The bundle ratchet inspects
`dist/sync-worker.cjs`, while the live PostgreSQL composition smoke poisons
SQLite loading, executes representative queue/retry/recovery behavior, starts
all registered schedulers, gracefully stops, restarts, and rechecks durable
fences.

### Workflow-parity Layer 7 activation

Workflow-parity Layer 7 adds one immutable PostgreSQL support contract for six
families: planning signals, project automation, the event outbox, notification
enrichment, durable AI, and semantic indexing/search. The support set is
all-six-or-none. Web/API and sync execution producers consume backend-selected
repositories in their own processes; they do not depend on mutable worker
state. Planning and project automation run as sync post-processing and from
their existing web routes. Outbox, enrichment, durable-AI, and semantic
publication persist work through PostgreSQL adapters.

The packaged worker separately owns an instance-local processing latch.
Repositories, the exhaustive durable executor registry, all six semantic
entity types and both intent kinds, provider configuration, and lifecycle stop
handles are precomposed and validated while consumers are dormant. Startup then
starts the complete component list in dependency order and opens the latch
once, after which each consumer receives one wake. Failure stops the failing
component defensively, unwinds started components in strict reverse order, and
keeps readiness absent. Shutdown revokes new claims first, drains owned work,
removes readiness and instance artifacts, then closes the database.

This support contract is process-local immutable composition, not a
cross-process activation signal. A backend-neutral configured-off feature has
the same semantics on SQLite and PostgreSQL; missing PostgreSQL repositories,
routes, providers, or lifecycle members are miscomposition and fail startup.
PostgreSQL never imports or opens the SQLite compatibility runtime on these
paths.

Surfaces Layers 3A/3B deliberately do not migrate stay SQLite-only and fail
closed under PostgreSQL *before* any remote effect: identity backfill and
status, manual identity-exception mutation, unknown
write-outcome resolution, and interrupted write-cycle recovery.
Connector-owned Work To Do bridge
state and Microsoft To Do hidden-list state are no longer in that list —
Layer 4 migrates both. Historical task-transfer succession filtering is
portable: both hierarchy adapters recompute a JSON-order-independent proof
digest and revalidate the immutable record against current task bindings and
locators before excluding the superseded task. Legacy insertion-ordered SQLite
proof digests remain readable. GitHub restore and operator recovery of deletion
snapshots also remain unsupported on PostgreSQL; only identity-fenced deletion
candidate quarantine, retention, and archival are enabled, and only when every
frozen epoch/binding/locator/source and task fence still matches.

The PostgreSQL execution guard accepts only the registered finance aliases for
connector-owned domain state. It continues to reject other connector-owned
domain state and non-GitHub connector dependency or project state before remote
dispatch. SQLite continues to use its compatibility implementations for the
remaining legacy workflows.
Generic PostgreSQL runs use the backend-selected keyword search repository
after commit. Semantic enrichment, project-rule/planning post-processing,
outbound-event publication, and durable AI use their backend-selected
repositories and never fall back to SQLite.

The PostgreSQL implementation also supplies backend-specific migrations, sync
jobs and connector-operation leases, full-text search, database health
snapshots, and runtime telemetry. This is application capability, not evidence
that production selected PostgreSQL or that a deployment completed data import,
migration, or cutover. Production remains SQLite until the separate cutover
work is performed. See the
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

That slice is now complete on both backends: see
[Layer L16](#webapi-postgresql-parity-layer-l16-ideation-workspace-persistence)
below.

## Web/API PostgreSQL parity: Layer L01 (composition seams, transactions, codecs, ratchet)

Layer L01 is the first of a 20-layer web/API application-parity plan
(companion to the worker-side Layers 1-8 above); it adds no route or domain
migration, only backend-neutral primitives and a machine-derived ratchet that
later layers must shrink.

**Composition seams.** No generic database/query facade, `select`/`where`/
`orderBy` DSL, or dialect-schema leakage was introduced. `src/lib/persistence/
runtime.ts`, `src/db/runtime.ts`, `CorePersistenceRepositories`, and
`WorkerPersistenceRepositories` remain the extension points later domain
repositories compose against, matching the pattern already established by the
worker-side layers above.

**Transactions: an honest sync/async capability split, not a portable
callback.** `better-sqlite3` cannot hold a transaction open across a real
`await`; PostgreSQL's queries are inherently network round trips and cannot be
driven from a genuinely synchronous callback. `tests/contracts/
transaction-runner.contract.ts` therefore exposes three separate, honestly
typed contracts instead of one seam that claims parity it cannot deliver:

- `describeSynchronousTransactionRunnerContract` - commit, rollback, and
  no-partial-effect, shared verbatim by both backends' `SynchronousTransactionRunner`
  (`SqliteTransactionRunner` and `PostgresPersistenceBackend.transactions`).
  `SynchronousTransactionResult<TResult>` resolves to `never` for a
  `PromiseLike`-returning candidate, so a genuinely async callback fails to
  compile against this contract by construction.
- `describeSynchronousRunnerRejectsAsyncWork` - SQLite-only. Proves the
  runtime guard rejects a callback that returns a `Promise` (using the same
  void-typed-variable escape hatch already established in
  `sqlite-transaction-runner.test.ts` to construct an intentionally
  mistyped candidate), rather than silently continuing outside the
  transaction.
- `describeAsyncTransactionRunnerContract` - PostgreSQL-only capability
  (`PostgresPersistenceBackend.asyncTransactions`, typed `TransactionRunner<
  PostgresTransaction>`). Proves real awaited work commits and rolls back
  while holding the transaction open across the wire.

No class or seam is exported that implements `TransactionRunner<TContext>`
for SQLite: an earlier draft of this layer did exactly that (an
`AsyncSqliteTransactionRunner` that type-checked identically to PostgreSQL's
genuinely-async runner but silently rejected any real async work at runtime)
and was reverted before landing, precisely because a generically-typed caller
could pass real async work, compile successfully, and fail only at runtime.
Later domain repositories that need atomicity across an `await` on SQLite own
that atomicity themselves (e.g. sequencing synchronous sub-steps inside one
`SynchronousTransactionRunner.run` call), rather than being handed a
portable-looking async transaction primitive that SQLite cannot honor.

**Canonical value codecs, extracted only where duplication was proven.**
`src/db/persistence/value-codecs.ts` centralizes `canonicalJson`,
`decodeLenientJsonObject`/`decodeLenientJsonArray`, `decodeStrictJsonObject`,
`CanonicalJsonSlot` (`decodeCanonicalJsonSlot`/`encodeCanonicalJsonSlot`, which
preserve SQL `NULL` versus JSON `null` as distinct states), and
`decodeSqliteBoolean`/`encodeSqliteBoolean`. Conversion happens only at
adapter/import boundaries; application code continues to see structured
`PersistenceJson` and real `boolean`. Existing call sites were rewired to
delegate to the shared codec only where two or more implementations were
first proven byte-identical or behavior-preserving:
`parseWorkTodoJsonObject`, `parseSavedAIProviderConfig` (`config-values.ts`),
`normalizeProjectJsonCollections`, the "robust" of five `canonicalJson`
variants (`execution-pipeline.ts` and `semantic-index/validation.ts`), and the
shared strict-decode prefix of `parseEventOutboxPayload`,
`parseNotificationDeliveryPayload`, and `parseNotificationEnrichmentPayload`
(each file's own downstream field validation and error messages are
untouched). Deliberately **not** touched in this layer, as documented
extraction candidates for a future PR once a second real duplicate is found:
the other four `canonicalJson` variants (looser or `undefined`-unsafe),
`asRecord`/`asStringArray` in `github-recovery-values.ts`, the
`sqlite-core-repositories.ts`/`sqlite-triage-repositories.ts` JSON helpers
(51+ call sites), and the ~35 scattered SQLite boolean coercions elsewhere.
Round-trip, SQL `NULL`, JSON `null`, malformed/legacy input, empty values,
booleans, and double-encoded legacy cases are covered in
`tests/db/value-codecs.test.ts`.

**Machine-derived web/API taint ratchet.** `tests/architecture/
web-persistence-graph.ts` is a pure Node-builtins static-import-graph census
(no test-runner dependency, so it also runs under plain `node` to regenerate
the baseline), ported from the approved plan's `tiers.mjs`. It classifies
every `src/app/api/**/route.ts(x)` file as Tier A (fails at PostgreSQL
*import* time - a static edge reaches `@/db` or a SQLite driver package),
Tier B (fails only at *call* time - the only path is a dynamic `import()`/
`require()`), or clean. `tests/architecture/web-persistence-baseline.json`
commits the exact current sets and counts (266 routes, Tier A 221, Tier B 39,
clean 6, tainted `src/lib` 123, tainted shared API helpers 6, total migration
units 350 = Tier A + tainted-lib + tainted-helpers), plus a `finalTarget` of
zero for every count. `tests/architecture/web-persistence-baseline.test.ts`
recomputes the census from current source on every run and fails on: any set
gaining an entry absent from the baseline, any count exceeding its baseline
ceiling (`cleanRoutes` uses the same check inverted, as a floor), or the
partition/total invariants no longer holding. Set-based (not count-only)
comparison is deliberate and is itself covered by synthetic meta-tests in the
same file: a later layer cannot pass the ratchet by swapping one allowed
tainted file for a different, unlisted one at an unchanged count, or by
"fixing" a Tier A route merely by turning its static import into a dynamic
one (which would shrink Tier A but must simultaneously add a new,
baseline-absent entry to Tier B, failing that tier's own independent
ceiling). `LEGACY_RAW_SQLITE_IMPORTS` and other legacy allowlist entries from
the ratchet in "Current dependency inventory" above are not grandfathered
here: if reachable from a route, they correctly still count as Tier A/B
taint. This ratchet is deliberately a separate file from
`persistence-boundaries.test.ts`'s narrower raw-handle/driver-import
allowlist ratchet (a different, adapter-boundary-scoped check carried over
from the worker layers); neither duplicates the other.

*Baseline provenance and a documented archived-generator defect.* The plan's
committed Tier A count (221) and the 144-route "direct `@/db` import" figure
both reproduce exactly against this layer's commit, using two different
archived planning-session scripts (`tiers.mjs` and `reach2.mjs`
respectively). The plan's companion "79 transitive-only" figure
(`223 - 144`, where 223 is `reach2.mjs`'s own "static-tainted" count) does
not equal `221 - 144`, because `reach2.mjs` has a genuine seed-gating defect:
its taint-seed detection does not distinguish static from dynamic driver
imports even in its nominally "static-only" reachability pass, so its
223-route universe incorrectly includes two routes
(`src/app/api/connectors/github-bulk-transfer/route.ts` and
`src/app/api/sync/retained/resolve/route.ts`) whose only real taint path is
via a dynamic-only source (`src/lib/connectors/github-issues/
backup-verifier.ts`) and are correctly Tier B, not Tier A. All three
historical figures (223/144/79) are preserved verbatim in the baseline JSON's
`knownArchivedGeneratorDefect` block with the exact affected routes and root
cause; only the corrected, self-consistent `directTaintSourceRoutes`/
`transitiveOnlyTaintSourceRoutes` split (143/78, which sums exactly to 221 by
construction) is used as a ratchet field.

**Known limitation: no local validation was run for this layer.** The
approved-registry npm restore failed on a `qs@6.16.0` 404 against
`https://packagefeedproxy.microsoft.io/npm/`; per this repository's
dependency restoration policy, the restore was not retried and no alternate
registry was used, so `node_modules` remained broken and no local
`tsc`/`eslint`/`vitest` run validated this layer's TypeScript. The ratchet's
own numbers were independently verified by executing
`computeWebPersistenceGraph` directly (Node 24's native TypeScript
execution, no test runner required) against the current worktree and
confirming an exact match with the committed baseline. CI is expected to run
the full suite with a working install.

## Web/API PostgreSQL parity: Layer L04 (task core)

L04 makes the task-core domain surface backend-neutral: canonical
filter/query/stats specifications, edit- and mutation-policy identity loading,
local task lifecycle, Scout hard delete, both task-move strategies
(pending-sync and write-through), priority entity resolution, and source-list
display names.

### The contract

`src/lib/tasks/core/contracts.ts` defines `TaskCorePersistence`, now a composition
of fifteen narrowly-named repositories (`collections`, `details`, `creates`,
`mutations`, `removals`, `filterInputs`, `queries`, `policyIdentities`,
`lifecycle`, `scoutDeletion`, `moves`, `writeThroughMoves`, `priorityEntities`,
`sourceListNames`, `transferIdentity`). It is deliberately **not** a generic
table/dialect query API, and it has no "run this callback in a transaction"
escape hatch: the inputs are domain values (`TaskFilterSpec`, `TaskListPage`,
`PendingSyncTaskMoveRequest`, `TaskMoveDestinationMaterialization`,
`TaskMoveFinalizationRequest`, `TaskMutationRequest`) and the results are domain
DTOs (`TaskCollectionResult`, `TaskDetailResult`, `TaskMutationOutcome`,
`TaskRemovalOutcome`, `TaskStatsResult`, `AvailableTaskTag`,
`ScoutHardDeleteOutcome`, `TaskMoveFinalizationOutcome`). No Drizzle `SQL`
predicate, table object, or
transaction handle crosses this boundary in either direction.

`src/lib/tasks/core/filter-spec.ts` is the single pure parser from
`URLSearchParams` to `TaskFilterSpec`. It performs no I/O — My Day membership,
GitHub identity evidence, and inbox-list configuration are *stored data* and are
read separately through `TaskFilterInputRepository`. Both the legacy SQLite route
assembly and both adapters consume the same spec, so they cannot disagree about
what the canonical filter means, only about how to express it in SQL.

#### Sort ordering, including NULLs

`listTaskIds` sorts by an explicit expression plus an `id` tie-break, so the two
backends cannot disagree about a page boundary. NULL placement is a genuine
dialect difference — SQLite treats NULL as the lowest value (NULLs first
ascending, last descending) while PostgreSQL defaults to NULLS LAST ascending —
so it is never left to the dialect default. Both adapters prepend a
`CASE WHEN <column> IS NULL THEN 0 ELSE 1 END` rank, sorted in the requested
direction, for the two nullable sort columns (`dueDate`, `sourceListName`). The
pinned behavior is "NULL sorts lowest", which is exactly what the legacy SQLite
`/api/tasks` route already returns. `priority`, `status`, `title`, `createdAt`
and `updatedAt` are `NOT NULL`. Both adapters preserve the route's exact
`COALESCE(effort, 0)` expression, so unknown effort also sorts lowest.

### The composition seam

`src/lib/tasks/core/runtime.ts` is intentionally **clean**: it imports neither
`@/db` nor a SQLite driver, statically or dynamically. That is what lets the
migrated consumers leave the taint census entirely rather than being reclassified
from import-time (Tier A) to call-time (Tier B) taint — a reclassification the
ratchet correctly rejects as non-progress.

Two registration shapes exist:

- `registerTaskCorePersistence` — eager. `initializeRuntimeDatabase` uses it for
  both backends; under PostgreSQL the composition is built atomically from the
  freshly initialized handle, so no request can observe a half-registered
  task-core surface.
- `registerTaskCorePersistenceProvider` — lazy. `src/db/index.ts` installs the
  SQLite default this way, so any process that genuinely reaches SQLite (dev
  server, scripts, tests) gets a working composition without a clean module ever
  naming a SQLite one. An explicit registration always wins, so this can never
  resurrect SQLite under PostgreSQL, and the provider resolves through the same
  `db` handle that already refuses to initialize under the PostgreSQL backend.

The provider slot lives on `globalThis` (surviving hot reload and
`vi.resetModules()`) while the resolved value is memoized per module instance and
invalidated by a registration revision counter, so a test that swaps its database
re-resolves instead of reusing a stale handle.

### Transaction honesty

`SqliteTaskCorePersistence` methods are `async` to satisfy the portable contract,
but never `await` inside a transaction body: `runTransaction` is better-sqlite3's
synchronous transaction. The PostgreSQL adapter uses genuine
`db.transaction(async tx => …)`. The contract does not pretend the two are the
same mechanism; it pins the same *observable* guarantees:

`createSqliteTaskCorePersistence(database, transactionRunner)` takes the
transaction runner as an explicit second argument rather than closing over the
module-level `runTransaction`, and every repository it builds — reader and
writer — is constructed from exactly that pair. There is no module-level
fallback, so an injected database can never be read while its writes land in
another one. The runner type is deliberately the narrow *synchronous* callback
shape better-sqlite3 actually supports (`<T>(fn: (tx) => T, options?) => T`), not
a `Promise`-returning stand-in; production passes `runTransaction` from `@/db`
verbatim, so transaction behavior (`immediate`/`deferred`) and the database
telemetry wrapper are preserved. `tests/db/sqlite-task-core-injection.test.ts`
proves an independently injected handle + runner reads and writes the same
database and leaves a second database untouched.

- a pending-sync move claims the source optimistically (source id, `updated_at`,
  and a null-safe attachment fingerprint), materializes the successor, repoints
  every durable reference, and deletes the source **in one transaction**, so a
  failure leaves the source completely intact;
- the durable `pending_push` sync intent that carries the deferred upstream write
  lands in that same transaction, while all connector/network I/O stays outside
  it (validation, budgets, and target-list resolution happen before the
  transaction opens);
- a Scout hard delete writes its ingest-suppression tombstones and deletes the
  task graph atomically — a partial application would either resurrect the task
  on the next sync or permanently suppress a task that still exists;
- a second hard delete of the same task reports `not-found` and writes no new
  tombstones (idempotent).

#### The write-through move's five atomic operations

The write-through move (`src/lib/tasks/task-move-write-through.ts`) creates the
destination remotely and only then rewrites the local graph, so it has five
state transitions that must not tear. Each is exactly one adapter-owned
transaction, expressed as a narrow domain operation on
`WriteThroughTaskMoveRepository`:

| operation | what it makes atomic |
| --- | --- |
| `claimTaskMove` | Flips the source to `move_in_progress` and stamps `metadata.taskMoveClaim.token`, guarded on the exact `(id, source_id, sync_status)` the caller observed. This is the exactly-once gate: a concurrent move loses the guarded update and is rejected with `TASK_MOVE_IN_PROGRESS`. |
| `releaseTaskMoveClaim` | Restores the pre-claim `sync_status`/`metadata`, guarded on the claim token, so a stale releaser can never clobber a re-claimed task. Idempotent: replaying it is a no-op. |
| `materializeDestination` | Writes the successor task, its tag links, the copied project links, the copied schedule, its attachments, and — for a copy — the whole subtask graph with each subtask's own tags, projects, schedules and attachments. A half-written destination is precisely the state the caller's remote compensation cannot repair. |
| `finalizeMove` | Re-checks the claim token *and* the attachment fingerprint, repoints every durable reference onto the successor, rehomes the subtasks, drops the source's schedules/attachments, and applies the source disposition (delete, or a retained tombstone carrying `pending_push` + `pendingCleanup`). Returns `source-changed` instead of throwing when a guard fails, which is what produces the `TASK_MOVE_SOURCE_CHANGED` 409. |
| `discardMaterializedDestination` | Compensating cleanup for a destination that was materialized but never finalized. Idempotent, because compensation runs on a best-effort path and may be retried. |

Two single-statement operations complete the picture:
`recordSourceSyncIntent` settles the retained source's durable intent
(`pending_push` → `synced`) *after* the remote source has been disposed of, and
`recordSourceCopyProvenance` stamps `copiedTo` on a copy's source. Both are
deliberately outside the finalization transaction: their value can only be
decided after external I/O, and both are idempotent — replaying either writes
the same terminal state.

#### External calls, inventoried

Everything below happens strictly *between* those transactions, never inside
one, which is what keeps each of them short and non-blocking:

- **Connector/network:** `connectorRegistry.getConnector` /
  `createConnector`, `createTask`, `createSubTask`, `deleteTask`,
  `completeTask`, `addComment`, `addTagToTask`, `uploadAttachment`,
  `listAttachments`, `getAttachmentContent`, `transferTask`,
  `canTransferTask`, `refreshTransferIdentity`.
- **Identity:** `executeFencedGitHubTaskMutation`,
  `executeFencedGitHubSourceMutation` (GitHub write fencing),
  `persistCreatedTaskIdentity` and `reconcileTransferIdentity` (L06-owned
  external-identity persistence, awaited so L06 can make them asynchronous
  without touching this file).
- **Semantic/derived:** `refreshGitHubIssueMetadata`.

The only thing that must be atomic with the task rows is the durable sync
intent the sync pipeline later acts on, and this move expresses that intent as
`sync_status` + `metadata` on the same rows — so it is written by the same
`finalizeMove`/`materializeDestination` transaction that writes the rows. No
separate outbox or queue was invented for it.

Genuine dialect differences are resolved inside the adapters, never leaked into
the contract: `jsonb` metadata needs an explicit `::text` cast for substring
matching, SQLite's `IS <value>` null-safe comparison is
`IS NOT DISTINCT FROM` on PostgreSQL, the claim-token guard is
`json_extract(metadata, '$.taskMoveClaim.token')` on SQLite and
`metadata #>> '{taskMoveClaim,token}'` on PostgreSQL, `INSERT OR IGNORE` is
`ON CONFLICT DO NOTHING`, and only SQLite has the `task_history_events`
append-only DELETE trigger that the hard delete must drop and recreate.

### Route compatibility

L07 removes the last route-local predicates from the collection/detail roots.
The pure parser in `filter-spec.ts` represents literal search, effort, tags,
projects/no-project, grouping, and list scope as domain values. The backend
adapters compile those values to SQLite `LIKE` or PostgreSQL `ILIKE`, with
escaping and ordering kept private to each adapter. The legacy predicate helpers
remain available to specialized routes that have not migrated; neither migrated
root imports or evaluates them.

Collection totals, stats, source counts, available tags, pagination, and row
enrichment now come from `collections.readTaskCollection`. Smart-score
calculation remains route-owned domain behavior: persistence returns only the
bounded deterministic candidate rows and ranking inputs, and the route scores
and slices them before serializing the existing response.

### Residual taint owned by another layer

`src/lib/tasks/task-move-write-through.ts` contains no `@/db`, `@/db/schema`,
`drizzle-orm` or `better-sqlite3` reference, and all nine of its original
transaction sites are adapter-owned task-core operations. The census still
counts it in `taintedLibA` for exactly one reason: it statically imports
`@/lib/connectors/transfer-identity`, whose own `@/db` usage and whose
`@/lib/external-identities` dependency are external-identity persistence owned
by **L06**. (The write-fence import was narrowed from the
`@/lib/external-identities` barrel to the already-clean
`@/lib/external-identities/github-write-fence` leaf, which removed the second
blocker without changing a single runtime value.)

This is residual taint attributable to another layer, not a deferral inside
L04, and it is machine-checked in both directions:
`tests/db/task-core-postgres-import-safety.test.ts` stubs exactly that one
module and then imports *and executes* the move under a poisoned `@/db`, and
`tests/architecture/task-core-taint-decrement.test.ts` asserts that
`transfer-identity` is the **only** tainted static edge the file has left. If
L06 migrates it, the write-through move leaves the census with no further work.

### `TaskTransferIdentityRepository`: a narrow seam for the L06 coordinator

`TaskTransferIdentityRepository` (on `TaskCorePersistence.transferIdentity`)
exists solely so that `src/lib/connectors/transfer-identity.ts` — still
entirely L06-owned and **not modified by this layer** — has a portable
task-core seam to migrate onto later, instead of continuing to open `@/db`
directly for the two task-row reads/writes it needs. It exposes exactly two
methods, both already implemented for SQLite and PostgreSQL and exercised by
the shared suite in `tests/contracts/task-core.contract.ts`:

```ts
interface TaskTransferIdentityRepository {
  resolveIdentityTargets(input: {
    taskId: string;
    connectorInstanceId: string;
    sourceListIds: readonly string[];
  }): Promise<{
    taskExists: boolean;
    taskMetadata: Record<string, unknown>;
    sourceLists: readonly { sourceId: string; localId: string }[];
  }>;
  reconcileTaskRefresh(input: {
    taskId: string;
    connectorInstanceId: string;
    task: {
      sourceId: string; sourceListId: string | null; sourceListName: string | null;
      title: string; description: string | null; status: string; statusReason: string | null;
      priority: string; effort: number | null; microStatus: string | null; assignee: string | null;
      updatedAt: string; completedAt: string | null; metadata: Record<string, unknown>;
    };
    observedAt: string;
  }): Promise<boolean>;
}
```

- `resolveIdentityTargets` resolves the local `source_lists.id` for each of
  `sourceListIds`, scoped to `connectorInstanceId` (a source id under a
  different connector never resolves), plus the task's current metadata.
  Unknown source ids are silently dropped, duplicates are deduplicated, and
  the returned order matches each id's first occurrence in the input — this
  is what replaces `persistIdentityWrites`'s per-list `db.select` loop in the
  legacy file with one deterministic read. When the task does not exist,
  `taskExists` is `false` and `taskMetadata` is `{}`, but source-list
  resolution is unaffected: it is a separate read against a separate table
  and stays fully deterministic regardless of the task's existence.
- `reconcileTaskRefresh` merges the task's existing metadata with the
  incoming `task.metadata` (incoming wins on key collisions — the same
  spread order `reconcileTransferIdentity` uses today) and updates exactly
  `sourceId`, `sourceListId`, `sourceListName`, `title`, `description`,
  `status`, `statusReason`, `priority`, `effort`, `microStatus`, `assignee`,
  `updatedAt`, `completedAt`, the merged `metadata`, `syncStatus` (set to
  `'synced'`) and `lastSyncedAt` (set to `observedAt`), guarded by `taskId`
  *and* `connectorInstanceId` matching. It resolves `true` iff exactly one
  row was updated, `false` when the task is absent or its
  `connectorInstanceId` doesn't match — no update happens in that case. The
  read-then-write is one adapter-owned transaction on both backends
  (`runTransaction` on SQLite, `db.transaction` on PostgreSQL): metadata is
  decoded through the shared L01 codecs (`decodeLenientJsonObject`) at the
  SQLite boundary and read as the `jsonb` object directly on PostgreSQL, so
  the merge always happens against a plain JS object regardless of dialect.

**This is not a cross-domain task+external-identity atomic bridge.** The
repository only ever touches the `tasks` and `source_lists` tables; it has no
knowledge of `external_identities`, evidence shaping, or GitHub identity-mode
snapshots, and it does not wrap the external-identity writes and the task
update in one transaction — those remain the two separate operations they are
today in `reconcileTransferIdentity`/`persistIdentityWrites`. Identity policy
(what evidence to persist, when, and under which mode) stays owned entirely by
L06; this layer adds only the narrow task-core reads/writes that a future L06
change can call instead of opening `@/db` itself. `transfer-identity.ts` is
untouched by this change and keeps its own `@/db` usage until L06 migrates it.

### Ratchet decrement

Recomputed by `computeWebPersistenceGraph` against the worktree (run with
`node --experimental-strip-types`):

| metric | L01 | L04 |
| --- | --- | --- |
| Tier A routes | 221 | 220 |
| Tier B routes | 39 | 39 |
| clean routes | 6 | 7 |
| direct taint-source routes | 143 | 143 |
| transitive-only taint-source routes | 78 | 77 |
| `@/db` namespace routes | 144 | 144 |
| tainted `src/lib` (Tier A) | 123 | 116 |
| tainted API helpers (Tier A) | 6 | 1 |
| **total migration units** | **350** | **337** |

Twelve of the thirteen owned files left the census (five API helpers, seven
`src/lib` modules) and `src/app/api/tasks/[id]/hard-delete/route.ts` became
genuinely clean — it moved to `cleanRoutes`, **not** to Tier B. The entry-set
diff shows zero additions to any taint set and Tier B unchanged at 39. The
per-file expectations are pinned by
`tests/architecture/task-core-taint-decrement.test.ts`, and the exact removals
are recorded in `decrementHistory` in
`tests/architecture/web-persistence-baseline.json`.

### Proof

- `tests/contracts/task-core.contract.ts` — one shared suite run against both
  backends (`tests/db/sqlite-task-core.contract.test.ts` in-process,
  `tests/db/postgres-task-core.integration.test.ts` guarded by
  `MC_TEST_POSTGRES_URL`): filter semantics including empty/null/boundary
  filters and unknown ids, deterministic ordering with an id tie-break and
  non-overlapping pagination, explicit NULL placement for the nullable sort
  columns (`dueDate`, `sourceListName`) in both directions and across a page
  boundary, JSON/boolean normalization, stats denominators,
  policy identity loading, delete/convert atomicity, hard-delete idempotency,
  move claim rejection with no partial effects, and — for each of the
  write-through move's atomic operations — concurrency (a second claim loses),
  idempotency (replayed release/discard/settle are no-ops), rollback with no
  partial state (a failed materialization or repoint leaves the source graph
  untouched), and the durable sync intent being written exactly once.
- `tests/api/task-move-orchestration-characterization.test.ts` — end-to-end
  against real SQLite: compensation after a failed local persist, compensation
  after a failed reference finalization, the attachment-race 409, replay
  protection for both local and remote sources, and concurrent moves
  serializing to `201`/`409`.
- `tests/api/task-move-execute.test.ts` — route behavior against the
  repository seam: what the move asks each atomic operation to do, in order.
- `tests/api/task-move-identity-compensation.test.ts` — the remote compensation
  closure is installed before the created task's external identity is
  persisted, so a failure in that durable write still deletes the remote issue
  and leaves no local destination behind.
- `tests/db/sqlite-task-core-injection.test.ts` — an independently injected
  handle + transaction runner reads and writes the same database, rolls a
  failed mutation back inside that runner, and leaves a second database
  untouched (no module-level write fallback).
- `tests/unit/task-filter-spec.test.ts` — pure parsing, including the preserved
  quirk that an *invalid* `status` parameter still suppresses the implicit
  open-only exclusion.
- `tests/db/task-core-runtime.test.ts` — seam semantics: explicit registration
  beats the lazy provider, resolution is memoized per registration, and a failed
  resolution is not cached.
- `tests/db/task-core-postgres-import-safety.test.ts` — `@/db` is replaced by a
  module that throws on import and the backend is switched to PostgreSQL; every
  migrated consumer must still import and execute, including both task-move
  strategies and the portable statistics path.

**Known limitation: no local validation was run for this layer either.** The
approved-registry restore remains broken (`qs@6.16.0` 404), so `node_modules`
contains only `next` and no local `tsc`/`eslint`/`vitest` run was possible. What
*was* verified locally, with Node 24's native TypeScript execution and no test
runner: every changed file parses (`module.stripTypeScriptTypes`), every
internal import resolves to a real module and every named binding it imports is
actually exported, and the ratchet decrement above was recomputed and matched
against the committed baseline. CI is expected to run the full suite with a
working install.

## Web/API PostgreSQL parity: Layer L07 (task collection/detail writes)

L07 migrates only the mixed collection/detail task routes:
`src/app/api/tasks/route.ts` (`GET`, `POST`) and
`src/app/api/tasks/[id]/route.ts` (`GET`, `PATCH`, `DELETE`). The unchanged
`src/app/api/mcp/tasks/[id]/route.ts` also becomes clean because its
authenticated forwarding import now reaches a clean detail route. Specialized
task routes remain outside this layer.

The routes obtain backend-neutral task route persistence through the task-core
runtime. Contracts are domain-shaped: collection queries and enrichment,
detail/write contexts, atomic create and patch commands, removal decisions, and
lease-fenced remote-delete finalization. They do not expose a database handle,
transaction callback, SQL expression, generic query builder, or dialect. The
SQLite adapter keeps better-sqlite3 callbacks synchronous; the PostgreSQL
adapter owns async transactions, deterministic locking, guarded `updated_at`
CAS, JSONB/text normalization, escaped literal search, null ordering, and
stable id tie-breakers.

### Atomic boundaries

- Creation commits the task, tags, projects, schedule, triage claim/item
  transition, and durable event intent as one local transaction.
- Patch commits the guarded task update, schedule, tags, field state, priority
  audit, planning history, Scout reopen suppression/suggestion supersession,
  completion-anchored successor and copied graph, and durable event intent as
  one local transaction. The recurrence source uniqueness key makes concurrent
  completion return one successor.
- Removal commits mirror dismissal, ingested cancellation, local graph
  deletion, or optimistic remote cancellation/pending intent atomically.
  Confirmed remote deletion removes the graph only when both the push lease and
  expected task version still match.

Those are existing task-route invariants, not ownership transfers for triage,
Scout, events, connectors, search, or notifications. Connector/network I/O,
identity writes, audit logging, keyword indexing, semantic publication, and
rule evaluation never run inside a task transaction.

### External effects and recovery

Connector effects preserve this order:

1. validate policy and read backend-neutral context;
2. commit authoritative local state plus durable pending intent;
3. claim the existing task push lease and capture the expected task version;
4. perform connector I/O outside the transaction, heartbeating slow creation;
5. finalize through the lease token and expected-version fence;
6. persist creation identity only after successful push finalization;
7. publish non-authoritative audit/search/rule effects in their existing
   response-relative order.

Unavailable/deferred connectors release the task as `pending_push`. Ordinary
write failures remain retryable; GitHub unknown outcomes remain
`push_failed` with retry count `5`. A stale lease cannot mark newer state
synced or delete it, and a crash after local commit leaves durable work for the
existing push worker. There is no fallback, dual-write, or second queue.

The routes import connector initialization, write-through audit, keyword
search, and semantic publication through their clean leaf modules. They do not
import the mixed connector, sync, or search barrels, the triage action service,
or the Scout reconciliation service.

### Ratchet decrement

The exact L07 graph is:

| metric | L05 | L07 |
| --- | ---: | ---: |
| API routes | 266 | 266 |
| Tier A routes | 208 | 205 |
| Tier B routes | 26 | 26 |
| clean routes | 32 | 35 |
| direct taint-source routes | 134 | 132 |
| transitive-only taint-source routes | 74 | 73 |
| direct `@/db` namespace routes | 135 | 133 |
| tainted `src/lib` | 95 | 95 |
| tainted API helpers | 1 | 1 |
| **total migration units** | **304** | **301** |

The two task roots leave the direct sets; the MCP forwarding route leaves the
transitive-only set. All three enter `cleanRoutes`. Tier B, tainted libraries,
tainted API helpers, and the static/dynamic taint-source sets are unchanged.
`tests/architecture/task-write-taint-decrement.test.ts` pins the exact paths and
counts.

### Proof and exclusions

The shared task-core suite runs identical collection/detail/mutation,
CAS/concurrency, recurrence-idempotency, rollback, and stale-finalization
assertions against real SQLite and guarded live PostgreSQL. A PostgreSQL route
integration test poisons `@/db` before importing and executing both route
modules, proving that PostgreSQL execution does not evaluate SQLite. Focused
route tests preserve HTTP status/body/header, policy, event, and asynchronous
write-through behavior.

L07 does not migrate connector management (L12), notifications (L13), triage or
native routes, Scout ingestion/reconciliation ownership, AI or semantic
retrieval, runtime/global-slot selection, schema/migrations/deployment, or any
specialized task route. It adds no taint exception and does not move static
taint into Tier B.

## Web/API PostgreSQL parity: Layer L02 (seed/demo fail-closed, entity-link parity, settings/mode route)

Layer L02 owns exactly four application files (`src/app/api/settings/mode/
route.ts`, `src/lib/seed-api.ts`, `src/lib/triage/lifecycle.ts`,
`src/lib/triage/shared.ts`) plus the tightly-scoped notification
entity-linking adapter/contract used by webhook/worker code migrated by
earlier layers. It does not migrate any other route or lib. Delivering the
`settings/mode/route.ts` decrement cleanly (see below) additionally requires
two small, additive edits outside this ownership list, called out
explicitly here rather than left implicit: a new pure registry module,
`src/lib/settings/mode-route-services.ts` (owned by this layer, new file,
zero pre-existing owner), and two new registration calls added to the
existing `initializeRuntimeDatabase()` composition root in `src/db/runtime.ts`
(a shared file owned by no single layer) — one per backend branch, wiring
the concrete SQLite/PostgreSQL implementations of the two services the
route depends on. No other behavior in `runtime.ts` changes.

**Goal 1: seed/demo fails closed before any SQLite driver import or file
creation, under `MC_DATABASE_BACKEND=postgres`.** `src/lib/seed-api.ts`'s
`better-sqlite3` import became `import type Database from 'better-sqlite3'`
(type-only, erased at build time — the file no longer references the driver
value at all), and its private `getDb()` helper now:

```ts
async function getDb(): Promise<Database.Database> {
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'Seed/demo database management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    );
  }
  const { sqlite } = await import('@/db');
  return sqlite;
}
```

The backend check runs strictly before the dynamic `import('@/db')`, so under
PostgreSQL neither `@/db` (and therefore neither `better-sqlite3` nor
`src/db/bootstrap/connection.ts`'s `new Database(databasePath)`) is ever
evaluated, and no `.db`/`-wal`/`-shm` file is ever created. In SQLite mode,
`getDb()` returns the *same shared singleton* `@/db` already owns (configured
once, in `configureDatabaseConnection`) rather than opening a private
connection of its own — `clearDatabase`, `resetDemoDatabase`, and
`clearTriageSampleData` (the only three seed/demo entry points, see below)
are unchanged in SQLite-mode behavior. This is a minimal, explicit,
documented exception to the L01 ratchet's "zero" final target, not a hidden
allowance: there is no PostgreSQL equivalent yet for demo/seed database
management, and every guarded function is proven, by test, to fail with this
exact message before touching `@/db` (`tests/db/
seed-api-postgres-fail-closed.test.ts`, covering poisoned-`@/db`-property
access, a real scratch-directory stray-file check, and that SQLite mode
still delegates to the shared singleton rather than opening a private
connection).

**The seed/demo exception is narrow: exactly three functions, not a whole
module.** `src/lib/triage/lifecycle.ts` and `src/lib/triage/shared.ts` gate
*all* normal triage web traffic (thumbnail cleanup, hard-delete, purge,
`ensureSeedData`'s read-through seeding for every triage list request) —
these are not seed/demo operations and must keep working identically on both
backends as later layers migrate them. Only `clearTriageSampleData` (in
`lifecycle.ts`) is a genuine SQLite-only seed/demo action (deletes only the
canonical sample rows inserted by `resetDemoDatabase`) and carries an inline
guard identical in spirit to `seed-api.ts`'s:

```ts
if (resolveDatabaseBackend() === 'postgres') {
  throw new Error(
    'Triage sample-data management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
  );
}
```

`updateTriageItemThumbnail`, `hardDeleteTriageItem`, `hardDeleteTriageItems`,
`purgeDismissedItems`, and every function in `shared.ts` (including
`ensureSeedData`) are **untouched** — same static `import db from '@/db'`,
same behavior, same Tier A membership as before this layer. They remain an
explicit target for a later layer's real migration, not narrowed L02 taint
and not silently guarded. An earlier draft of this layer incorrectly wrapped
all five `lifecycle.ts` functions in a fail-closed guard; that was reverted
because it would make ordinary web traffic (e.g. deleting a triage item)
throw under PostgreSQL for a reason unrelated to seed/demo, which is exactly
the failure mode Goal 1 exists to prevent, not reproduce for normal
operations.

**Goal 2: SQLite/PostgreSQL suffix-match and JSON-type parity for
notification entity linking.** `src/db/persistence/
notification-entity-linking.ts` defines `asciiFoldLower` — folds only the 26
ASCII letters `A`-`Z`, leaving every other character (including all
non-ASCII text) byte-for-byte unchanged, matching SQLite's own default
(non-ICU) `LIKE` behavior exactly. This is deliberately **not** PostgreSQL's
`ILIKE`, which is locale-aware and can fold non-ASCII case pairs (e.g.
Turkish dotted/dotless I, German ß) depending on the database's collation —
using `ILIKE` as a "case-insensitive" proxy would silently make suffix
matching behave differently per backend for non-ASCII input, reproducing
the exact parity bug this layer closes. The SQLite adapter
(`sqlite-notification-entity-linking-repository.ts`) is left unchanged
(its plain `LIKE` already has this behavior with no ICU extension loaded);
the PostgreSQL adapter (`postgres/repositories/
notification-entity-linking-repository.ts`) applies `asciiFoldLower` to its
query parameter and pairs it with a `translate(source_id, $ASCII_UPPER,
$ASCII_LOWER)` expression on the column, so both backends fold exactly the
same character set and no non-ASCII character is ever folded on either
side. Both adapters also now guard `metadata.repository` project lookups
against non-string JSON: SQLite's `json_extract` naturally never equals a
TEXT parameter for a non-TEXT JSON value, but an explicit `json_type(...) =
'text'` guard documents and pins that behavior; PostgreSQL's `->>` operator
stringifies *any* JSON scalar, so without the equivalent
`jsonb_typeof(metadata -> 'repository') = 'string'` guard a numeric-looking
search term could match a JSON number. `tests/contracts/
notification-entity-linking.contract.ts` runs identically against both
adapters (`tests/db/sqlite-notification-entity-linking-repository.contract.
test.ts`, always-on; `tests/db/postgres-notification-entity-linking-
repository.integration.test.ts`, guarded by `MC_TEST_POSTGRES_URL` and
`assertSafeIntegrationTestTarget`) and covers: exact match, unique suffix
match, zero matches, ambiguous suffix match (2 rows → `null`, never an
arbitrary pick), mixed-case ASCII suffix folding, a non-ASCII case pair
(`Ö`/`ö`) that must stay distinct, and `metadata.repository` missing, JSON
`null`, a non-string JSON number, and a non-string JSON boolean — each
resolving to zero project matches even when the search term equals the
scalar's stringified form.

**`settings/mode/route.ts`: PATCH genuinely migrated, POST's demo actions
kept SQLite-only, and the route module is fully clean under the
web-persistence-graph census (neither Tier A nor Tier B).** The PATCH
handler's timezone-change logic — recomputing every `relative_*` reminder
task's `reminder_at` for the new timezone and rejecting the change with 409
`RELATIVE_REMINDER_TIMEZONE_CONFLICT` if any recompute would land in the past
or fail validation — was real, non-demo, backend-dependent business logic
that an earlier draft of this layer left untouched. It is now migrated
through a new narrow contract, `src/db/persistence/
relative-reminder-timezone.ts` (`RelativeReminderTimezoneRepository.
applyTimezoneRecompute`), with SQLite (`sqlite-relative-reminder-timezone-
repository.ts`, a `drizzle` transaction) and PostgreSQL (`postgres/
repositories/relative-reminder-timezone-repository.ts`, an async `drizzle`
transaction) adapters. The route itself has **zero import edges — static or
dynamic — to `@/db`, `@/lib/seed-api`, or `@/lib/triage/lifecycle`**: no
backend branching, no generic query facade.

The route's three demo-only actions (`reset-demo`, `clear-data`,
`clear-triage-samples`) remain SQLite-only, correctly and unapologetically —
there is no PostgreSQL demo-reset equivalent yet. Both the demo commands and
the timezone repository are reached exclusively through
`@/lib/settings/mode-route-services`, a pure backend-neutral registry (a
plain register/get pair per service, no import edge of its own to any
backend-touching module — the one value-level type it needs,
`RelativeReminderTimezoneRepository`, is imported with `import type`, which
is erased at build time and therefore does not create a graph edge). The
concrete SQLite and PostgreSQL implementations are constructed and
registered once, at server startup, by `initializeRuntimeDatabase()` in
`src/db/runtime.ts` — the same, already-established composition root used
for `CorePersistenceRepositories` (it already calls
`registerCorePersistenceRepositories`) — which runs from
`src/instrumentation.ts` before the server accepts any request. For SQLite,
this wires the real `clearDatabase`/`resetDemoDatabase`/
`clearTriageSampleData` functions and the drizzle-backed timezone repository.
The demo-command trio is wired through one dynamically-imported seam file,
`src/db/persistence/sqlite-demo-seed-command-adapter.ts` (its name
deliberately contains "sqlite", following the same convention as
`sqlite-core-repositories.ts`/`sqlite-relative-reminder-timezone-repository.
ts`): `runtime.ts` itself never names `@/lib/seed-api` or
`@/lib/triage/lifecycle` — statically or dynamically — only the adapter file
does, so the sync-worker's PostgreSQL-startup-graph ratchet
(`tests/architecture/final-worker-persistence-boundary.test.ts`), which
follows *every* dynamic import out of `runtime.ts` (a permanent member of its
traversal) unless the resolved target's filename itself signals
SQLite-only, does not pull `@/db`/`@/db/schema`'s entire subtree into the
PostgreSQL startup graph through this wiring. An earlier draft imported
`@/lib/seed-api` and `@/lib/triage/lifecycle` directly from `runtime.ts`;
that passed the route-focused `web-persistence-graph` census (which only
traces from route entry points) but failed the separate sync-worker ratchet,
which starts from `src/sync-worker.ts` and reaches `runtime.ts` as one of its
guarded dynamic importers — a reminder that this layer's route-level
"clean" proof and the pre-existing worker-boundary proof are independent
gates that both must hold. For PostgreSQL, the timezone repository
gets the real PostgreSQL adapter, but the three demo commands are
constructed inline as immediate rejections using the exact same
"SQLite-only" error text `seed-api.ts`/`lifecycle.ts` already throw — the
PostgreSQL branch never imports either SQLite-only module at all, so the
rejection happens before any SQLite-side module is evaluated, by
construction.

An earlier draft of this layer used a call-site-scoped dynamic `import()` at
each of the three demo-action call sites, which moved the route from Tier A
to Tier B (fails at PostgreSQL *import* time, `GET`/`PATCH` unreachable →
fails only at *call* time for those three actions). That was a real
improvement but still left the route with deferred taint. The registry +
composition-root design above removes even that: the route is **fully
absent from both `tierARoutes` and `tierBRoutes`** and present in
`cleanRoutes` in `tests/architecture/web-persistence-baseline.json` (see its
`layerUpdates` entry): `tierARoutes` 221 → 220 (route removed, no other route
added), `tierBRoutes` unchanged at 39 (the route never lands here either),
`cleanRoutes` +1 (the route joins the floor set — floor increases are always
safe), `taintedLibA` 123 → 121 (`seed-api.ts`/`seed.ts` exit Tier A per Goal
1), `totalMigrationUnits` 350 → 347. A dedicated test,
`tests/architecture/settings-mode-route-clean.test.ts`, names this route
explicitly and asserts it is in neither tier and is in `cleanRoutes`, so a
future regression (e.g. reintroducing a static/dynamic import from the route
to any backend-touching module) fails immediately and legibly, independent
of the generic baseline-ratchet mechanism. `tests/lib/settings/
mode-route-services.test.ts` covers the registry's register/get/throw
semantics in isolation; `tests/db/
runtime-mode-route-services-registration.test.ts` proves
`initializeRuntimeDatabase`'s PostgreSQL branch registers a demo command
service that rejects all three commands (with poisoned `@/lib/seed-api`/
`@/lib/triage/lifecycle` mocks that throw on import, so any accidental import
attempt fails the test) and a working PostgreSQL timezone repository.
`tests/api/settings-mode-route.test.ts` covers exact GET/POST/PATCH auth
(403 public-demo), status, body, and error-code behavior — mocking only the
route's actual dependencies (`@/lib/mode`, `@/lib/public-demo`, and the
`mode-route-services` registry) — including the 409 conflict path and a test
that wires the mocked repository's recompute callback to the real, unmocked
`resolveRelativeReminderMutation` to prove correct end-to-end wiring without
a real database. `RelativeReminderTimezoneRepository`'s own query-filtering,
atomicity, and `invalidCount` semantics are additionally pinned identically
on both backends by `tests/contracts/relative-reminder-timezone-repository.
contract.ts` (`tests/db/sqlite-relative-reminder-timezone-repository.
contract.test.ts`, always-on; `tests/db/
postgres-relative-reminder-timezone-repository.integration.test.ts`, guarded
by `MC_TEST_POSTGRES_URL` and `assertSafeIntegrationTestTarget`), using a
deterministic stub `recompute` callback so this contract is independent of
the relative-reminder date-math already covered by the route-level test
above and by `resolveRelativeReminderMutation`'s own unit tests.
`initializeRuntimeDatabase`'s PostgreSQL branch is proven, in
`tests/db/runtime-mode-route-services-registration.test.ts`, to register a
demo command service that rejects all three commands and a working
timezone repository, with `@/lib/seed-api`/`@/lib/triage/lifecycle` mocked
to throw on import so any accidental import from that branch fails the
test immediately.

**Known limitation: no local validation was run for this layer.** Same
approved-registry `qs@6.16.0` 404 documented in the L01 section above;
`node_modules` remained unusable, so none of this layer's new tests were
executed by `vitest` and no `tsc`/`eslint` run validated its TypeScript. The
web-persistence-graph ratchet numbers were independently re-verified by
executing `computeWebPersistenceGraph` directly via Node's native TypeScript
execution (no test runner required) against the worktree after every change
in this layer, confirming the exact before/after transition described
above. CI is expected to run the full suite with a working install.
## Web/API PostgreSQL parity: Layer L06a (external-identities, excluding transfer-identity.ts)

Layer L06 was split into **L06a** (this layer) and a later **L06b** once it
became clear that `src/lib/connectors/transfer-identity.ts` mixes external-
identity operations with direct task/source-list row mutation that is
task-domain state outside this layer's ownership (see "Deferred to L06b"
below). L06a migrates the nine other owned `src/lib/external-identities/*`
files off direct SQLite/Drizzle handle access onto the backend-neutral
`GitHubIdentityPersistence`/`GitHubWriteFencePersistence`/
`GitHubIdentityOperatorPersistence` ports, preserving every prior public API,
canonicalization rule, mode/status/exception behavior, reconciliation
ordering, dedupe/idempotency key, error type/message, and durable write
outcome bit-for-bit. `transfer-identity.ts`, its task-transfer attribution
behavior, and the Layer 3B `recovery.transferReconciliation` sub-port it
uses are unchanged and untouched by L06a; production remains SQLite.

**Genuinely async normal APIs.** `identity-mode.ts`, `identity-exceptions.ts`,
`write-cycle-reconciliation.ts`, `identity-status.ts`, and
`write-outcome-resolution.ts` now expose real `async` domain functions backed
by PostgreSQL's genuinely async adapter methods (`FOR UPDATE` row locks,
`GREATEST()`-based epoch/lease advancement, and equivalent replay/idempotency
checks) and SQLite's synchronous adapter internals reached through a
Promise-returning wrapper. No SQLite public API was preserved by silently
allowing a PostgreSQL call-time failure: every normal caller was converted to
`await` its now-`Promise`-returning entry point.

**Five pre-existing, previously audited operator/recovery exclusions are
unchanged, not newly introduced.** Identity backfill/status, manual
terminal-inaccessible exception mutation, unknown write-outcome resolution,
and interrupted write-cycle recovery (11 methods total, since 3 of them are
backfill-lifecycle helpers with no direct CLI command) were audited before
this layer and remain unsupported on PostgreSQL, preserving the existing
`UnsupportedGitHubWorkerOperationError` contract exactly. They are reached
only through `GitHubIdentityOperatorPersistence`
(`src/db/persistence/github-identity-operator.ts`): the SQLite adapter
(`sqlite-github-identity-operator-repositories.ts`) genuinely reuses the
exact prior query/mutation logic verbatim via injected-handle `*Sync`
functions; the PostgreSQL adapter
(`src/db/postgres/repositories/github-identity-operator-repositories.ts`) is
**not** a genuine async implementation — every member is `async` and
synchronously throws `UnsupportedGitHubWorkerOperationError` before any
SQLite import/evaluation, transaction acquisition, remote network effect, or
durable mutation, so it merely returns a Promise already rejected with that
error. Cross-backend behavioral parity is neither claimed nor required for
this port. `tests/db/postgres-github-identity-operator-repositories.test.ts`
proves, for all 11 methods, both direct-invocation and awaited rejection with
the exact established error class/code/message, that the adapter module has
no static import of `better-sqlite3`/`@/db`/any `@/lib/external-identities`
module, and that neither a mocked `better-sqlite3` constructor nor `fetch` is
ever reached. No normal HTTP/application route calls this port; only
`scripts/github-identity-operator.ts` does.

**`github-backfill.ts` is rowid-free by construction, not by a lossy
rewrite.** The pre-existing implementation ordered cursor pagination by
`id COLLATE BINARY`, never SQLite `rowid`; this was verified directly against
`main` before the rewrite (not inferred from a prior audit's SQLite-only-site
count, which was not evidence of `rowid` use). The rewrite preserves that
exact ordering and every SQLite-only raw `json_*`/`json_extract` predicate
verbatim inside the SQLite adapter; the PostgreSQL adapter's 7 genuinely
async entity/locator methods use faithful (not mechanically translated)
PostgreSQL equivalents (`FOR UPDATE`, `jsonb` operators, `GREATEST()`).

**Operator CLI script is an explicit SQLite-only tool, not application
parity.** `scripts/github-identity-operator.ts` fails closed with
`assertSqliteOnlyCommandSupported` before any SQLite-specific import
evaluation or effect for its five audited SQLite-only commands (`status`,
`write-cycle-reconcile`, `write-outcome-inspect`, `write-outcome-resolve`,
`exception-accept`/`exception-revoke`) when
`resolveDatabaseBackend() === 'postgres'`; its already-portable
`transfer-reconcile` command is unaffected.
`tests/scripts/github-identity-operator-pg-guard.test.ts` and
`tests/scripts/github-identity-operator-artifact.test.ts` cover the guard
and the built-artifact process boundary respectively.

**Deferred to L06b: the `tasks/route.ts` compatibility edit.**
`src/app/api/tasks/route.ts`'s `persistCreatedTaskIdentity` call site needs a
single surgical `await` addition to stay source-compatible with the now-async
`identity-mode.ts` API, but that edit is coupled to how `transfer-identity.ts`
is finally reshaped (see below) and is therefore out of scope for L06a. The
route file is completely untouched by this layer; it remains a documented
compatibility edit for L06b.

**Deferred to L06b: `transfer-identity.ts`.** `transfer-identity.ts` mixes
external-identity operations with direct task/source-list row mutation,
which is task-domain state outside this layer's ownership. Rather than
adding a SQLite-handle escape hatch (which would move a PostgreSQL failure to
call time) or splitting the file to dodge the ratchet on its filename, L06
was split so this file, its task-transfer attribution behavior, and the
`tasks/route.ts` caller above are owned together by a future L06b layer once
Layer L04 ships a narrow `TaskCorePersistence.transferIdentity`-shaped
capability (with `resolveIdentityTargets`/`reconcileTaskRefresh`) that this
file can call asynchronously; if atomicity across task and identity state is
required, L06b will define a single adapter-owned orchestration method
instead of splitting transactions across repositories. `transfer-identity.ts`
is unchanged in L06a and remains the one tainted `src/lib/external-identities`
sibling (`src/lib/connectors/transfer-identity.ts`) in the ratchet baseline;
L06a's ratchet decrement therefore covers exactly the other nine owned
files.

**Ratchet decrement.** Relative to this layer's own base (the state before
Layer L02 merged), `tests/architecture/web-persistence-baseline.json`'s
committed `taintedLibA`/`totalMigrationUnits` ceilings drop by exactly nine
(123 → 114 tainted `src/lib` modules; 350 → 341 total migration units),
removing exactly `github-backfill.ts`, `identity-exceptions.ts`,
`identity-mode.ts`, `identity-status.ts`, `index.ts`, `service.ts`,
`task-transfer-reconciliation.ts`, `write-cycle-reconciliation.ts`, and
`write-outcome-resolution.ts` from the `taintedLibA` allowlist; every other
ratchet set this layer itself touches (`tierARoutes`, `tierBRoutes`,
`cleanRoutes`, `directTaintSourceRoutes`, `transitiveOnlyTaintSourceRoutes`,
`directDbNamespaceRoutes`, `taintedApiHelpers`, `staticSources`,
`dynamicSources`, `apiRoutes`) is unchanged by L06a's own diff, and
`transfer-identity.ts` stays tainted (deferred to L06b, above). `tests/architecture/
persistence-boundaries.test.ts`'s separate, narrower raw-handle/driver-import
allowlist is likewise updated: `github-backfill.ts`, `identity-status.ts`,
`write-cycle-reconciliation.ts`, and `write-outcome-resolution.ts` are
removed from `LEGACY_RAW_SQLITE_IMPORTS` because they no longer import a raw
SQLite handle at all (only `import type` bindings for Group-2 adapter-internal
sync-helper handle types remain, which that file's `better-sqlite3` check was
tightened to exclude, matching the type-only exclusion already applied to
its `@/db` runtime-import checks). `LEGACY_GITHUB_OPERATOR_MODULES` in the
same file is unchanged: it still lists exactly the same five operator/
recovery surfaces as the pre-existing audited exclusion above, now reached
through the port instead of a raw import.

**Merge reconciliation with Layer L02.** L02 (above) merged to `main` first
and independently removed two different, disjoint files from `taintedLibA`
(`seed-api.ts`/`seed.ts`, 123 → 121) and one route from `directDbNamespaceRoutes`
(144 → 143), touching none of L06a's nine owned files. Because the two
layers' decrements are over disjoint sets, they compose additively: the
committed baseline after both merge is `taintedLibA` 123 → 112 (nine L06a
files plus the two L02 files), `directDbNamespaceRoutes` 144 → 143 (L02's
contribution only, unrelated to L06a), and `totalMigrationUnits` 350 → 338.
This combined figure — not either layer's own isolated delta above — is what
`tests/architecture/web-persistence-baseline.json` and
`tests/architecture/web-persistence-baseline.test.ts`'s exact-equality check
enforce on `main` after both merges.

**Known limitation: no local validation was run for this layer**, for the
same approved-registry `qs@6.16.0` restore failure documented under Layer
L01 above; the ratchet's own numbers were independently verified the same
way, by executing `computeWebPersistenceGraph` directly against the current
worktree.

## Web/API PostgreSQL parity: Layer L14 (external-agent control plane)

External-agent registration, payload snapshots, preview/confirmation, delivery
attempts, pull claims, result submission, review, retry, expiration, and cleanup
now resolve through one `ExternalAgentControlPersistence` member of the existing
worker composition. SQLite and PostgreSQL adapters own all SQL and every
multi-row transition. The application registry and state-machine modules return
pure domain records and never receive a driver handle.

The composition is atomic: `externalAgentControl` is constructed with the other
worker repositories for the selected backend. PostgreSQL selection has no
SQLite fallback, dual write, or compatibility import. Callback registration
validates the referenced inbound webhook's enabled state and non-empty HMAC
secret in the same transaction as the agent write.

Attempt begin/resume commits before HTTP, MCP, or manual transport work starts.
The result or failure is finalized in a second transaction fenced by dispatch
status and attempt number. Pull claims use row locking, persist only the token
hash, and return the plaintext token once. Lease recovery, deadline expiry,
review, cancellation, retry, event insertion, and retention deletion are also
adapter-owned transactions. Result retries are idempotent only when the
canonical digest matches; stale transport completions cannot overwrite newer
state.

No DDL changed in L14 because both schemas already contained the agent control
tables. The graph ratchet is exactly
`266/202/26/38/135/67/136/89/1/292`; eight routes and five libraries became
clean with no Tier B reclassification. The mixed inbound webhook receiver
awaits the portable result service but remains outside this layer because its
task/notification transaction boundary is not yet portable.

## Web/API PostgreSQL parity: Layer L16 (Ideation workspace persistence)

The Ideation workspace domain — named, versioned, server-persisted documents
with optimistic concurrency — now selects its backend through the composed
worker persistence facade. `IdeationWorkspaceRepository` (unchanged since it was
introduced) is published as the top-level `ideationWorkspaces` slot on
`WorkerPersistenceRepositories`, and both a SQLite and a PostgreSQL adapter
implement it. `src/lib/persistence/sqlite-runtime.ts`, a SQLite-only composition
root that existed solely for this domain and had exactly one consumer, is
deleted rather than relocated.

The slot is top-level rather than nested (L15 nested
`projectAutomation.hierarchy`) because `graph_workspaces` and
`graph_workspace_versions` share no rows and no serialization namespace with any
other worker surface. `IdeationWorkspaceService` now holds an async repository
resolver instead of a constructed repository, so it evaluates no driver at
import time. All five `/api/ideation/workspaces` route handlers and their shared
`route-errors.ts` helper are unchanged: none of them ever imported the `@/db`
namespace, so the whole decrement is transitive.

No DDL changed in L16. `graph_workspaces`, `graph_workspace_versions`, both
unique indexes, both plain indexes, and the cascade foreign key already ship in
`drizzle/postgres/0000`, and the PostgreSQL schema module was already
column-for-column identical to the SQLite one.

Concurrency and ordering parity:

- Compare-and-swap commands (`updateContent`, `restore`) and `deleteArchived`
  take a single `SELECT ... FOR UPDATE` row lock inside one `READ COMMITTED`
  transaction. Every command touches exactly one `graph_workspaces` row, so
  `SERIALIZABLE` and a retry loop would add no protection.
- SQLite's `deleteArchived` reads and then deletes without a transaction.
  Single-threaded behaviour is identical in both backends; PostgreSQL is
  intentionally stronger under concurrency, and SQLite's transaction behaviour
  was deliberately not expanded.
- `duplicate` deliberately remains a non-atomic read-then-create in both
  backends, preserving current behaviour rather than opportunistically
  hardening it.
- `create` inserts the workspace and its revision-1 version row in one
  transaction. A duplicate `migration_source` aborts that transaction; the
  adapter rolls back and releases its pooled client before the service's
  `findByMigrationSource` recovery runs, so a concurrent tab that lost the
  unique insert still resolves the winner.
- The checkpoint cadence lives in `shouldCheckpointIdeationRevision` in the
  neutral contract module and is called by both adapters, so it cannot drift.
- SQLite orders the library by `name COLLATE NOCASE`, which folds only ASCII
  `A-Z` and then compares bytes. PostgreSQL reproduces this with
  `translate(name, 'A-Z', 'a-z') COLLATE "C"`; a locale-aware `lower(name)`
  would silently reorder non-ASCII names, digits, and punctuation. Both
  backends append an `id` tiebreaker, which defines an order that SQLite
  previously left unspecified for rows sharing an archived flag, timestamp, and
  folded name.
- Documents are JSON text in SQLite and `jsonb` in PostgreSQL. `jsonb`
  normalises key order and numeric literals, but every read path ends in
  `ideationWorkspaceDocumentSchema.parse(...)`, so parsed documents compare
  equal structurally.

The graph ratchet is exactly `266/181/26/59/124/57/125/83/0/264`: five routes,
two libraries, and one shared API helper became clean with no Tier B
reclassification. `taintedApiHelpers` reaches its declared `finalTarget` of 0
and is the first ratchet field in the programme to be fully retired.
`directTaintSourceRoutes` and `directDbNamespaceRoutes` are unchanged.

`/api/ideation/convert` and `/api/ideation/expand` share the URL prefix but
remain Tier A: they are tainted through `src/lib/ai/ideation-expand.ts` and
`src/lib/ai/config-resolver.ts`, which belong to the AI provider layer.

## Web/API PostgreSQL parity: Layer L08a (triage web persistence)

Layer L08a routes non-action triage web persistence through the existing
atomic `TriagePersistenceRepositories` composition. The backend-neutral
contract owns queue filters and facets, captures and enrichment, content-type
overrides, digest and health snapshots, and lifecycle/storage maintenance.
SQLite and PostgreSQL adapters preserve the observable ordering, null,
pagination, malformed-JSON, compare-and-set, and deletion-result semantics.
Feature modules receive domain records and outcomes only; no raw driver,
Drizzle transaction, generic query facade, fallback, or dual write crosses
the boundary.

Filesystem cleanup, image and thumbnail storage, remote embed resolution,
webhook delivery, logging, and semantic publication remain service-owned and
occur outside repository transactions. Semantic updates use the composed
publication service established by the runtime-publication prerequisite;
this layer does not own or modify registry, global-slot, instrumentation, or
runtime-lifecycle infrastructure.

The two AI-linked action routes (`/api/triage/[id]` and
`/api/triage/[id]/extract-actions`) and `/api/notifications/triage` remain
explicit Tier A exclusions. Their call graphs still reach SQLite-backed AI or
notification behavior, so hiding those edges behind deferred imports would
only relocate taint. Native Share Sheet persistence is likewise deferred to
stacked Layer L08b; `/api/triage/capture` therefore remains Tier A in L08a.

Composed on the merged L09, L05, L07, L13, L14, L15, L16, L17, L11, and
L12a baselines, the committed L08a graph is exactly 266 API routes, 143 Tier A,
19 Tier B, 104 clean, 101 direct taint-source routes, 42 transitive-only Tier A
routes, 102 direct `@/db` namespace routes, 71 tainted libraries, zero tainted
API helpers, and 214 total migration units. The layer adds no Tier B route.
`triage-native-web-persistence-boundary.test.ts` pins the exact route and
library removals plus the explicit exclusions. The shared persistence
contract runs against SQLite and live PostgreSQL, and representative
live-PostgreSQL route tests poison `@/db` before route import to prove that
the web surface consumes only the registered post-publication composition.

## Web/API PostgreSQL parity: Layer L17 (derived analytics: stats and insights)

The read-only derived-analytics surfaces — dashboard and reset KPIs, the
`/insights` query layer, cumulative flow, and the tag and word insight services
— now select their backend through the composed worker persistence facade. See
[analytics-persistence.md](./analytics-persistence.md) for the full contract,
method inventory, and translation rules.

`WorkerPersistenceRepositories` gains a top-level `analytics` slot holding five
sub-repositories (`kpis`, `insights`, `flow`, `tagInsights`, `wordInsights`).
The slot is top-level because these read models share no rows and no
serialization namespace with any other worker surface; the five members live
under one slot rather than as five top-level slots because they are registered
atomically, so a backend supports every analytics surface or none.

`src/lib/stats/index.ts`, `src/lib/stats/insights.ts`,
`src/lib/stats/flow-query.ts`, `src/lib/tag-insights/service.ts`, and
`src/lib/word-insights/service.ts` each hold an async repository resolver
instead of a database handle, so none evaluates a driver at import time. Every
exported signature, JavaScript reducer, date and timezone computation, clamp,
and error string is unchanged. All six owned route handlers are unchanged:
none of them ever imported the `@/db` namespace, so the whole decrement is
transitive and `directTaintSourceRoutes` and `directDbNamespaceRoutes` are
unchanged at 124 and 125.

No DDL changed in L17, and none could: the layer is entirely read-only. No
column, table, constraint, default, or index was added, and every table it
reads — `tasks`, `task_projects`, `task_tags`, `tags`, `hub_projects`,
`project_phases`, `project_phase_items`, `task_history_events`, `routines`,
`routine_completions`, `notifications`, `triage_items`, `my_day_items`,
`focus_items`, `connector_configs` — already ships in `drizzle/postgres`.

Concurrency and ordering parity:

- Neither backend opens a transaction, takes a row lock, or raises the
  isolation level. The multi-query composites (`computeKpis` and the eleven-way
  insights summary fan-out) were non-atomic under SQLite and stay non-atomic
  under PostgreSQL. Wrapping them in a snapshot would hand callers a
  consistency guarantee they do not have today and would pin a pooled
  connection across a wide fan-out.
- The per-project and per-day query loops in `getProjectActivity` and
  `computeDailyAvg` are preserved deliberately. Collapsing them would be an
  optimization, not backend parity.
- SQLite validates each date and time field against a fixed range and then
  computes a Julian day arithmetically. That yields three behaviours a cast
  cannot reproduce: out-of-domain text becomes `NULL` (excluding the row rather
  than raising); in-range fields past the end of their month or day are
  *normalized* rather than rejected, so `2026-02-31` is `2026-03-03` and `24:30`
  is the next day at `00:30`; and offsetless text is read as UTC. SQLite also
  requires the colon inside a numeric zone offset, which PostgreSQL does not,
  and caps that offset at 14 hours. PostgreSQL therefore *constructs* the
  instant from regex-validated fields with `make_date` plus `make_interval`
  rather than casting the text; `col::timestamptz` and `pg_input_is_valid` both
  reject the overflow values SQLite accepts, and the latter additionally accepts
  the colon-less offsets SQLite refuses. See
  [analytics-persistence.md](./analytics-persistence.md) for the exact accepted
  domain and the four behaviours deliberately left outside it.
- SQLite's default `BINARY` collation orders text by bytes, so every text
  `ORDER BY`, window `ORDER BY`, and `row_number()` partition order in the
  PostgreSQL adapter is pinned with `COLLATE "C"`. The database's locale-aware
  default collation would silently reorder hyphenated IDs and punctuated names.
- SQLite's `lower()` folds ASCII only, so the synthetic-tag prefix scan uses
  `translate(btrim(name), 'A-Z', 'a-z')` rather than a locale-aware `lower()`,
  the same technique L16 used for `COLLATE NOCASE`.
- Both adapters add explicit tiebreakers for the source breakdown
  (`count DESC, connector_type`), active and visible projects (`name, id`),
  delivery filter options (`name, id`), delivery records (`completed_at, id`),
  active routines (`id`), and the unbounded routine-completion reads
  (`routine_id, date`). These define an order SQLite previously left
  unspecified; every already-explicit order is reproduced unchanged.
- The PostgreSQL adapter reproduces the Drizzle `notificationNeedsAttention()`
  predicate, **not** the sibling `NOTIFICATION_NEEDS_ATTENTION_SQL` text
  constant. The two differ on a `NULL` `level`: the constant's
  digest exclusion drops such rows, the function keeps them.
  `notifications.level` is `NOT NULL DEFAULT 'fyi'` in both schemas so no live
  row diverges, but the shared contract pins the distinction so a later
  refactor cannot silently swap them.
- `routines.cadence_config` is JSON text in SQLite and `jsonb` in PostgreSQL.
  `jsonb` normalises key order, but every consumer reads only `days` and
  `target`, so parsed cadence configs compare equal structurally.
- `count(*)` returns `bigint` over `pg`; every count method casts to `int` in
  SQL and coerces at the boundary, so callers always receive a `number`.

`src/db/task-history.ts` is unchanged and keeps both of its consumers. The
SQLite adapter calls `getTaskTransitionsInRange` directly — an adapter is
allowed to be Tier A — so the `task_history_events` read model is not split
across two owners and a later burn-report layer inherits it as is.

The graph ratchet is exactly `266/175/27/64/124/51/125/78/0/253`: six routes and
five libraries left Tier A, five routes became clean, and exactly one route
reclassified to Tier B. `taintedApiHelpers` stays at its retired target of 0.

`/api/insights/observations` is that reclassification. Its only residual reach
is a deferred `import()` of `@/lib/ai/config-resolver` inside
`src/lib/stats/observations.ts`, which belongs to the AI provider layer and was
deliberately not touched. `/api/resets/stats`, `/api/mobile-dashboard`, and
`/api/tasks/quick-sort-stats` share the analytics vocabulary but remain Tier A:
they hold inline Drizzle queries in the route file itself and belong to the
route-extraction work, not to this layer. `/api/projects/[id]/reports/burn`
likewise remains Tier A; it is a history-replay report rather than a derived
read model.
## Web/API PostgreSQL parity: Layer L08b (triage native persistence)

Layer L08b extends the same atomic `TriagePersistenceRepositories` value with
a focused `native` sub-contract. It owns bounded installation and Share Sheet
credential reads, fenced Share Sheet request claims, APNs registration request
replay and lifecycle mutations, and logout revocation. SQLite uses immediate
transactions; PostgreSQL uses transactional advisory locks for the two
contention domains. Neither adapter exposes a driver, transaction handle,
fallback, dual write, or generic query facade.

Share Sheet claims prune requests older than 24 hours before enforcing an exact
30-per-credential rolling-minute limit. Request identity is bound to the
canonical payload hash. Completion requires the original reservation and
payload, release deletes only an owned pending reservation, and concurrent
claims resolve to one owner plus pending/replay/duplicate outcomes.

APNs request records store domain response payloads rather than HTTP envelopes.
Exact retries replay the stored status and payload; request-ID reuse with a
different operation or payload returns a conflict. Registration atomically
retires a device token reassigned to another installation, retires an
installation's prior active target, rotates changed tokens in place, and keeps
encrypted token material only. Unregister requires installation ownership and
is idempotent. Logout atomically revokes active installation and Share Sheet
credentials and retires active registrations, returning exact changed-row
counts.

Token parsing and hashing, constant-time comparison, scope/expiry/installation
binding, APNs token encryption, canonical request hashing, schema validation,
APNs configuration, HTTP envelopes, and triage item creation remain
service-owned and outside repository transactions. Contract tests run against
SQLite and live PostgreSQL; live-PostgreSQL route tests poison `@/db` while
exercising Share Sheet capture, APNs register/replay/unregister, and logout.

Composed on current main, the committed L08b graph is exactly 266 API routes,
139 Tier A, 19 Tier B, 108 clean, 101 direct taint-source routes,
38 transitive-only Tier A routes, 102 direct `@/db` namespace routes,
67 tainted libraries, zero tainted API helpers, and 206 total migration units.
No route moved into Tier B. The exact
newly clean routes are `/api/triage/capture`, native logout, native APNs
registration, and native APNs unregistration; the exact newly portable
libraries are the four native service/authentication modules.
## Web/API PostgreSQL parity: Layer L12b (finance connector/operator)

Layer L12b extends the existing atomic `FinanceWorkerPersistence` composition
with a driver-free `finance.operator` sub-port. The port owns the bounded
connector health snapshot, connection-test result persistence, cutover
readiness, atomic cutover enable, and atomic rollback operations. It is
registered with the rest of the finance composition; it is not a runtime slot,
generic query facade, or raw database handle.

The existing `FinanceAttributionPersistence` port also owns bounded cursor
pagination and the manual attribution/exception commands used by the Finance
web APIs. SQLite and PostgreSQL adapters preserve the same compare-and-swap,
generation fence, action legality, retryability, and idempotent replay rules.
PostgreSQL locks the affected rows; SQLite uses its serialized write
transaction. Provider calls, retry scheduling, bounded recovery sync, and
notification-dispatcher wakes remain outside adapter transactions and run only
after the required durable commit.

The seven Finance connector/operator routes consume the backend-selected core
and finance compositions without importing `@/db`. Dataset health reuses
`FinanceDatasetPersistence.listState()`, recovery reuses
`FinanceConnectionRecoveryPersistence`, and scheduler controls continue to use
`SyncOperatorControlRepository`. The generic connector test route has one
narrow core seam, `ConnectorRepository.recordTestResult`, so connector badge
state remains owned by the selected core backend. Composition is fail closed:
PostgreSQL never falls back to SQLite, and no schema or deployment change is
part of this layer.

## Web/API PostgreSQL parity: runtime observability and health

Runtime health snapshots, readiness probes, current telemetry, history,
instance history, and telemetry maintenance now consume process-wide,
startup-selected contracts. `initializeRuntimeDatabase()` publishes exactly one
health and telemetry composition after its selected backend is initialized and
clears both during failed startup or shutdown. Callers fail closed before
publication or after fencing; they never select a driver or fall back to
SQLite.

The SQLite adapters retain the existing `PRAGMA page_count`, page-size,
observation, JSON text, retention, and downsampling behavior. PostgreSQL uses
`PostgresDatabaseHealthProbe`, `PostgresHealthSnapshotStore`, and the native
`runtime_telemetry*` tables, including `pg_database_size(current_database())`
and pool saturation metadata. SQLite-only PRAGMAs and `better-sqlite3` remain
confined to explicitly named SQLite adapters.

Five owned route files remain byte-for-byte unchanged. Only
`src/app/api/health/route.ts` changes its import to the driver-neutral snapshot
read seam so route evaluation no longer reaches worker snapshot generation.
The exact graph transition is 266 routes, A130/B19/clean117 to
A130/B13/clean123. All six owned health, metrics, and runtime telemetry routes
move from Tier B to clean; every Tier A, direct-taint, direct-`@/db`,
tainted-library, helper, and total-migration-unit count is unchanged.

## Web/API PostgreSQL parity: Layer L12c (finance end-user surfaces)

Layer L12c adds the driver-free `finance.web` sub-port to the existing atomic
`FinanceWorkerPersistence` composition. It owns the seven end-user Finance
routes for kids, finance notifications and dismissal, overview, summary,
transaction listing, and transaction category updates. The SQLite and
PostgreSQL adapters preserve the existing projections, filters, ordering,
summary calculations, Finance-only dismissal, and demo mutation behavior.

Live category changes still claim and validate durable state before Monarch
I/O. Successful provider calls are finalized in a transaction only while the
claim token remains current; failed calls record the sanitized bridge error
under the same fence. SQLite serializes claims with an immediate transaction,
while PostgreSQL combines a connector-scoped advisory transaction lock with
row locking. Idempotent replay, stale-claim recovery, competing mutation
rejection, and transaction/category compare-and-swap checks remain equivalent.

`src/lib/finance/operations.ts` and the active category-write path in
`snapshot-sync.ts` now resolve the selected finance composition asynchronously.
The obsolete raw-SQLite snapshot page helper was removed; snapshot ingestion
already uses the earlier `finance.snapshots` port. PostgreSQL selection does not
import, evaluate, or fall back to SQLite. The two Finance alert routes become
clean transitively through the shared Monarch module but are not otherwise
changed by this layer.

## Web/API PostgreSQL parity: task quick-sort workflow persistence

The quick-sort activity, operation-apply, and operation-undo routes now use a
bounded `TaskCorePersistence.quickSort` port. The existing task-core composition
remains the sole owner: startup constructs the SQLite or PostgreSQL adapter
atomically, and route or helper evaluation cannot import, initialize, or fall
back to SQLite in PostgreSQL mode.

The port owns task snapshot reads, conflict-safe operation reservation,
operation/log finalization, undo claim/release/finalization, and activity
statistics. Applying and undoing task fields still delegate to the existing task
`PATCH` handler with `x-expected-task-updated-at`; this preserves the landed task
revision CAS, field policy, and external write ordering rather than duplicating
that behavior in the quick-sort adapter. Operation finalization and log creation
share one transaction, as do undo state and log reversal. Concurrent reservation
returns the existing operation, concurrent undo has one claimant, and completed
undo remains replay-safe.

The exact graph transition from base
`6205bb0ece832ed0225b8ee31e1cbf6996308d93` is
`266/A121/B13/clean132/direct91/transitive30/directDB92/lib61/helpers0/units182`
to
`266/A118/B13/clean135/direct88/transitive30/directDB89/lib60/helpers0/units178`.
All three owned routes become clean, `src/lib/quick-sort/operations.ts` leaves
the tainted-library set, and no route moves to Tier B.
## Web/API PostgreSQL parity: Layer L18 (AI execution and memory control plane)

Layer L18 removes the deferred SQLite reach from document intake, retained
Houston memory, and durable AI run control without changing any of their eight
route files. Durable runs and semantic source reads now resolve process-wide,
backend-neutral contracts populated only by `initializeRuntimeDatabase()`.
SQLite constructs its adapters inside the SQLite startup branch; PostgreSQL
constructs its existing durable-run and semantic-source adapters from the live
pool. Access before composition is registered fails closed, and shutdown clears
only the exact registered generation.

Provider construction is split into a pure `provider-client` capability that
accepts already-resolved configuration and an asynchronous `provider-runtime`
that reads configuration through the composed settings repository. The legacy
synchronous provider facade delegates to the same client, preserving route
selection, sensitivity policy, admission control, telemetry, error propagation,
and request ordering. Document intake and Houston summary generation use the
asynchronous facade, so PostgreSQL never evaluates `config-resolver.ts` or
`@/db`.

Houston memory continues to persist through `CorePersistenceRepositories`.
After an authoritative write commits, semantic publication uses the registered
publication service; entity-link validation uses the registered semantic source
port. The ordering remains inspect, provider call, memory write, then semantic
publication. Exclusion remains sticky across recapture, deleted memory stays
redacted, and expired-memory deletion remains bounded.

The exact graph transition is 266 routes, A121/B13/clean132 to
A121/B5/clean140. The eight owned routes leave Tier B, while
`ai-parser.ts`, `intake/index.ts`, and `ai/tools/intake-tools.ts` leave
`taintedLibA`; total migration units decrease from 182 to 179. Direct-taint,
transitive-only Tier A, direct-`@/db`, and helper counts are unchanged. No
suggestion, search, planning, task-ancillary, schema, migration, dependency,
Next.js, or build path is part of this layer.

The CI-proven cap is 43 paths: 9 production, 32 tests/helpers, and 2
architecture/documentation paths. The expansion from the original 24-path
inventory is limited to the 17 established graph readers and two SQLite
durable-run suites that now register their selected repository explicitly.

## Web/API PostgreSQL parity: Layer L19 (project organization)

Project administration, phase lifecycle, rule-match previews, and list-group
organization now resolve two backend-neutral capabilities atomically nested
under the existing `projectAutomation` worker slot. They sit beside, rather
than replace, L15 `projectAutomation.hierarchy`; no parallel runtime registry,
backend probe, fallback, or dual write was introduced. See
[project-organization-persistence.md](./project-organization-persistence.md)
for the complete route inventory and behavioral contract.

SQLite owns its driver and uses immediate mutations plus deferred composite
reads. PostgreSQL uses SERIALIZABLE mutations, REPEATABLE READ snapshots,
bounded serialization/deadlock retry, byte-stable `COLLATE "C"` ordering, a
dedicated list-organization lock, and the existing per-project advisory
namespace for project and phase mutations. Phase administration therefore
continues to participate in L15 revision triggers and optimistic CAS fencing.

All eight owned routes move directly from Tier A to clean. Composed after the
landed task quick-sort and L18 decrements, the graph moves from
`266/118/5/143/88/30/89/57/0/175` to
`266/110/5/151/80/30/81/57/0/167`. The CI-exposed exact-current ratchet
expansion adds 19 test-only paths to the approved 28-path maximum, for a
47-path maximum and 46 actual changed paths.

## Web/API PostgreSQL parity: connector transfer/sync control plane

This bounded layer owns only the legacy
`connectors/[id]/cross-account` transfer endpoint and
`sync/tasks/resolve` identity lookup. Cross-account execution is selected by a
process-wide, backend-neutral route service registered from the database
composition root for both SQLite and PostgreSQL. The implementation verifies
source-connector ownership, resolves an omitted destination through the
task-core list repository, and delegates to the canonical write-through task
move. It therefore inherits the existing optimistic claim fence, transfer
identity, compensation, durable cleanup intent, replay handling, and remote-I/O
ordering rather than recreating them in the route.

Task identity resolution now uses the canonical connector/source identity
lookup from task-core persistence. The shared SQLite and live-PostgreSQL
contract also pins deterministic destination-list selection: prefer
`defaultList`, then lowest `sortOrder`, then stable `id`. PostgreSQL startup and
both routes have poisoned-SQLite proofs; there is no SQLite load, fallback,
dual write, or backend probe in either request path.

The cap is 42 changed paths: 9 production paths, 11 direct
contract/route/runtime tests, 19 inherited exact-current graph expectation
updates, 2 graph artifacts, and this architecture document. Retained-list
purge, GitHub bulk transfer, sync cleanup, retained-resolution claims,
Scout/triage, and webhook integration are explicitly excluded. Bulk transfer
and retained resolution already use portable persistence and retain their
existing Tier B classification.

The exact graph moves from `266/110/5/151/80/30/81/57/0/167` to
`266/108/5/153/78/30/79/57/0/165`, ordered as API routes / Tier A / Tier B /
clean / direct taint / transitive-only taint / direct `@/db` / tainted
libraries / tainted helpers / total migration units. Both owned routes move
from Tier A directly to clean; Tier B and every library/helper set remain
unchanged.

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
