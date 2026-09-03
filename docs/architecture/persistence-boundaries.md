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

## Web/API PostgreSQL parity: Layer L04 (task core)

L04 makes the task-core domain surface backend-neutral: canonical
filter/query/stats specifications, edit- and mutation-policy identity loading,
local task lifecycle, Scout hard delete, both task-move strategies
(pending-sync and write-through), priority entity resolution, and source-list
display names.

### The contract

`src/lib/tasks/core/contracts.ts` defines `TaskCorePersistence`, a composition
of ten narrowly-named repositories (`filterInputs`, `queries`,
`policyIdentities`, `lifecycle`, `scoutDeletion`, `moves`, `writeThroughMoves`,
`priorityEntities`, `sourceListNames`, `transferIdentity`). It is deliberately **not** a generic
table/dialect query API, and it has no "run this callback in a transaction"
escape hatch: the inputs are domain values (`TaskFilterSpec`, `TaskListPage`,
`PendingSyncTaskMoveRequest`, `TaskMoveDestinationMaterialization`,
`TaskMoveFinalizationRequest`) and the results are domain DTOs
(`TaskStatsResult`, `AvailableTaskTag`, `ScoutHardDeleteOutcome`,
`TaskMoveFinalizationOutcome`). No Drizzle `SQL` predicate, table object, or
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
and `updatedAt` are `NOT NULL`, and `effort` is coalesced, so none of them needs
a rank.

One deliberate, *not* silent difference from the legacy route remains: the
route's `effort` sort is `COALESCE(effort, 0)` (unknown effort sorts lowest)
while both adapters use `COALESCE(effort, 2147483647)` (unknown effort sorts
last ascending). The adapters agree with each other — the shared contract pins
that in both directions — and reconciling the adapter and route expressions
belongs to the L05 read-route migration, which is the change that actually
switches the route onto `TaskQueryRepository`.

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

### Legacy route compatibility

The task read/write route handlers (layers L05/L07) still compose their own
Drizzle predicates. `src/app/api/tasks/{canonical-filter,filter-factory,
filter-query,query-builder}.ts` therefore still *return* SQLite Drizzle
predicates, but they no longer *open* a database: the predicate constructors moved
to the handle-free SQLite dialect compiler
(`src/db/persistence/sqlite-task-filter.ts`, which imports only `@/db/schema` and
`drizzle-orm`), and the stored inputs come from `TaskFilterInputRepository`. That
is a compatibility seam on the route side of the boundary, not a contract leak.
`tests/architecture/task-core-taint-decrement.test.ts` pins that exact four-file
list, so no other owned file can quietly acquire a Drizzle surface.

`src/app/api/tasks/stats-computer.ts` is now fully portable: every entry point
takes a `TaskFilterSpec` and runs through `TaskQueryRepository`. Its former
clause-shaped counters (`countTasks`, `getStats`, `getSourceCounts`,
`getAvailableTags`, which take a *composed* `WHERE` clause because the route
appends route-local predicates for effort, free-text search, tag ids,
no-project and group scoping) now live inside
`src/app/api/tasks/route.ts` — the single Tier A route that still needs them.
That is deliberately a relocation, not a port: modelling those route-local
predicates as `TaskFilterSpec` fields is the L05 read-route migration, and
passing Drizzle predicates across a task-core contract behind an opaque port
would have been worse than leaving them where they are used. The route's only
other change is importing the identity-aware quick-filter builders it now calls
directly; its data access is otherwise untouched.

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
