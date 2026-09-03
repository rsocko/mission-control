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

**Ratchet decrement.** `tests/architecture/web-persistence-baseline.json`'s
committed `taintedLibA`/`totalMigrationUnits` ceilings drop by exactly nine
(123 → 114 tainted `src/lib` modules; 350 → 341 total migration units),
removing exactly `github-backfill.ts`, `identity-exceptions.ts`,
`identity-mode.ts`, `identity-status.ts`, `index.ts`, `service.ts`,
`task-transfer-reconciliation.ts`, `write-cycle-reconciliation.ts`, and
`write-outcome-resolution.ts` from the `taintedLibA` allowlist; every other
ratchet set (`tierARoutes`, `tierBRoutes`, `cleanRoutes`,
`directTaintSourceRoutes`, `transitiveOnlyTaintSourceRoutes`,
`directDbNamespaceRoutes`, `taintedApiHelpers`, `staticSources`,
`dynamicSources`, `apiRoutes`) is unchanged, and `transfer-identity.ts` stays
tainted (deferred to L06b, above). `tests/architecture/
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

**Known limitation: no local validation was run for this layer**, for the
same approved-registry `qs@6.16.0` restore failure documented under Layer
L01 above; the ratchet's own numbers were independently verified the same
way, by executing `computeWebPersistenceGraph` directly against the current
worktree.

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
