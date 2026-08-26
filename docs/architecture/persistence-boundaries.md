---
title: "Portable Persistence Boundaries"
status: active
created: 2026-08-25
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

This boundary does not select or implement PostgreSQL. It keeps the current
SQLite runtime replaceable and gives another backend a stable application
contract to implement.

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
runtime backend selector may register another complete
`CorePersistenceRepositories` composition before request handling; consumers
must not select repositories individually because that can split one workflow
across backends. Registration is one-time and cannot replace a composition after
it has been registered or consumed.

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
