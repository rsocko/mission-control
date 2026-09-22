---
title: "Operational Utility Persistence"
status: active
created: 2026-09-06
last_reviewed: 2026-09-06
category: architecture
related:
  - "[Portable Persistence Boundaries](./persistence-boundaries.md)"
  - "[Scout Ingestion and Reconciliation Persistence](./scout-ingestion-reconciliation-persistence.md)"
---

# Operational Utility Persistence

## Boundary

`WorkerPersistenceRepositories.operationalUtility` is the single
startup-selected capability behind the operational utility surfaces: retained
source-list purge, maintenance cleanup, bounded data export, the feature-flag
connector snapshot, external bug-report intake, and public-demo initialization.

The contract in `src/db/persistence/operational-utility.ts` contains only plain
values and named operation results. It exposes **no** generic query, no
transaction handle, no Drizzle table, and no SQL fragment; driver handles,
transactions, and statements stay inside the SQLite adapter
(`src/db/persistence/sqlite-operational-utility-repository.ts`) and the
PostgreSQL adapter
(`src/db/postgres/repositories/operational-utility-repository.ts`). Both are
registered through the worker persistence composition, so every route resolves
the port with `getWorkerPersistenceRepositories()` and returns
`503 Operational utility persistence is not available in the selected backend`
when a backend does not provide it.

The named subports are:

- `retainedSourceLists`: the connector/source-list snapshot for one retained
  list, the retained task-id list, and the final source-list delete;
- `maintenance`: `runDuplicateCleanup()`, one atomic command returning exact
  counts;
- `exports`: seven deterministic keyset page readers (tasks, notifications,
  tags, task-tags, hub projects, connectors, sync log);
- `features`: the active (enabled, not soft-deleted) connector snapshot;
- `bugReports`: the atomic task + canonical/app tag creation; and
- `publicDemo`: `ensureReady()` and the typed `markSeeded(seededAt)` marker.

Identifier generation, timestamps, HTTP status selection, CSV/JSON framing,
export admission and telemetry, connector leasing, GitHub selection rules, AI
provider resolution, and demo seeding all remain application responsibilities.

## Retained source-list purge

`DELETE /api/connectors/[id]/retained-lists/[sourceListId]` runs entirely inside
the existing connector operation lease (`runWithConnectorOperationLease(id,
'retention', …)`), so it cannot interleave with a sync for the same connector.
Inside the lease the route:

1. loads the connector and source list through `loadSnapshot`, returning
   `404 Connector not found`, `400` for a non-`github-issues` connector, and
   `404 Source list not found` for a list that does not belong to the connector;
2. refuses with `409` when `isSourceListSelected` reports the list is still
   selected for sync;
3. deletes each retained task through the existing local task lifecycle
   (`deleteTaskLocally`), never through raw SQL; and
4. deletes the source-list row **only after every task delete succeeded**, so a
   partial failure leaves the list visible and the operation retryable.

The purge is local-only: `writeBack: 'none'` and no external API call is made.

## Maintenance cleanup

`POST /api/sync/cleanup` owns no SQL, no transaction, and no schema DDL. It
delegates to `maintenance.runDuplicateCleanup()`, which performs discovery *and*
every delete inside one backend transaction and returns counts only after that
transaction commits. Dependent rows (`task_tags`,
`project_auto_include_exclusions`, `task_projects`, `my_day_items`) are removed
before the `tasks` rows they reference.

Winner selection is deterministic and shared by both adapters through the pure
planners in the contract module:

| Phase | Grouping | Winner |
| --- | --- | --- |
| Duplicates | `(sourceId, connectorInstanceId)` | `lastSyncedAt DESC`, then `updatedAt DESC`, then `id` as a stable tie-break |
| Completed recurring | normalized `title` + `sourceListId` + `connectorInstanceId` | `completedAt ?? updatedAt DESC`, then `id` |
| Open recurring | same grouping | nearest non-null `dueDate ASC` (nulls last), then `updatedAt DESC`, then `id` |

Recurring phases only consider tasks whose stored metadata parses to an object
carrying a `recurrence` value; metadata that is missing, `null`, a JSON scalar,
or (on SQLite) not valid JSON is treated as non-recurring rather than throwing.
Both shipped schemas already declare the unique
`idx_tasks_source_connector` index, so duplicates only exist as legacy data —
the route never creates that index at runtime.

## Export

`GET /api/export` reads exclusively through `exports`. Every source is a keyset
page: text sources page on `id` and task-tags page on the declared
`(taskId, tagId)` order, so the emitted cursor and the parsed cursor always
agree. Each page checks the abort signal before and after the read, so runtime
drain and client disconnect stop the stream promptly. The sync log is capped at
100 records regardless of the configured batch size. Admission control,
concurrency limits, byte/record/duration limits, telemetry, and the
authorization rules are unchanged.

## Features

`GET /api/features` builds its snapshot from
`features.listActiveConnectors()` — enabled, not soft-deleted connector configs
in a stable order — and resolves AI status with the existing asynchronous
`loadAIProviderConfiguration()`. Notification-only connectors are still excluded
from task destinations. Stored `capabilities`/`settings` are parsed
defensively, so a legacy row holding a JSON string behaves the same as a
structured document.

## Bug report

`POST /api/bug-report` builds one `BugReportCommand` — the task plus the
canonical `bug` tag and, when the reporter identified itself, an `app-*` tag —
and `bugReports.create()` writes the task, any missing tags, and all task-tag
associations in a single transaction. A partially tagged report is therefore
never observable; a failure rolls the whole unit back and the route answers
`500`.

## Public demo

`initializePublicDemoData()` keeps its dependency-injection seam, but the
default dependencies are `publicDemo.ensureReady()`, the existing
`resetDemoDatabase()` seed helper, and `publicDemo.markSeeded(seededAt)`
followed by the existing `updateSettings` write. The runtime never touches
SQLite directly. The marker is upserted, so repeated initialization converges on
the latest `seededAt`.

## Tests

- `tests/contracts/operational-utility-persistence.contract.ts` is executed by
  both backends. SQLite runs it from
  `tests/api/sync-cleanup-route.test.ts` against an initialized in-memory
  database; PostgreSQL runs it from
  `tests/db/postgres-operational-utility-repository.integration.test.ts`, which
  skips unless `MC_TEST_POSTGRES_URL` names a disposable database.
- Harness capability flags describe real schema differences rather than
  weakening assertions: `supportsDuplicateSourceRows` (only reproducible on
  SQLite after dropping the unique index) and `supportsCorruptMetadataText`
  (impossible in a `jsonb` column).
- `tests/api/operational-utility-postgres-poisoned.test.ts` makes `@/db` and
  `@/db/schema` throw on evaluation and then imports and calls all five routes
  plus `initializePublicDemoData`, proving none of them reach back into SQLite.

## Canonical graph transition

Recomputed against merged Scout main
`17763b5bb3aa397cd714c6fe3b85b5fe6b3a00ae`, this layer moves all five owned
routes from direct Tier A to clean and removes
`src/lib/connectors/monarch-money/identity-sqlite.ts` and
`src/lib/public-demo-runtime.ts` from `taintedLibA`. Tier B and transitive-only
Tier A remain unchanged.

| Metric | Before | After |
| --- | ---: | ---: |
| API routes | 266 | 266 |
| Tier A | 30 | 25 |
| Tier B | 9 | 9 |
| Clean | 227 | 232 |
| Direct Tier A | 20 | 15 |
| Transitive-only Tier A | 10 | 10 |
| Direct `@/db` | 22 | 17 |
| Tainted libraries | 30 | 28 |
| Tainted API helpers | 0 | 0 |
| Migration units | 60 | 53 |

`tests/architecture/web-persistence-baseline.json` and the fail-closed
PostgreSQL route sentinel remain the sole exact-current graph owners.
