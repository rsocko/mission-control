# Daily-planning and focus persistence

`DailyPlanningPersistence` (`src/db/persistence/daily-planning.ts`) is the
backend-neutral boundary for the daily-planning and focus web surface. It is
registered atomically as one `WorkerPersistenceRepositories.dailyPlanning` slot:
a backend supports the whole contract or none of it. There is no backend
registry, generic query API, transaction escape hatch, fallback, or dual write.

## Scope

Owned routes:

| Route | Verbs |
| --- | --- |
| `/api/energy` | GET, POST |
| `/api/focus-items` | GET, POST, DELETE, PATCH |
| `/api/mobile-dashboard` | GET |
| `/api/my-day` | GET, POST, PATCH, DELETE |
| `/api/my-day/sync` | POST |
| `/api/navigation/counts` | GET |
| `/api/one-thing` | GET, POST, DELETE |
| `/api/schedule` | GET, POST, DELETE |
| `/api/recent-wins` | GET |
| `/api/recent-wins/dismiss` | POST |
| `/api/recent-wins/settings` | GET, PUT |

Explicitly outside the capability, and unchanged by it:

- Request parsing and validation, scoring, rotation seeds, and response shaping.
- Microsoft To Do network calls and the route-level per-date single-flight map,
  which stays a pure optimization — database correctness never depends on it.
- Edit-policy resolution (`@/lib/tasks/edit-policy`) and source-list display-name
  resolution (`@/lib/utils/resolve-task-list-names`), both already neutral.
- Recent-win snooze and deprioritized-list values, which reuse the existing
  atomic `CorePersistenceRepositories.settings` key upsert and delete.
- Historical and finalizing planning-signal work, which stays on
  `WorkerPersistenceRepositories.planningSignals`.
- AI, graph/reporting, project-domain, notification, Alertmanager, push-trigger,
  Scout, triage, tag, task-move, and relationship domains. The navigation and
  mobile-dashboard projections read notification, triage, and Scout
  reconciliation counts so the existing single-request payloads are preserved,
  but they never export or change those domains' contracts.

## Contract

Nine members group the surface:

- `energy` — read and atomic date-keyed replace.
- `focus` — today/week board projection, capacity-aware add, remove by item or by
  task, and slot moves.
- `dashboard` — the mobile today/queue/recent-activity projection.
- `navigation` — the complete `NavigationCounts` persistence projection.
- `myDay` — the day view (items plus every bounded suggestion group),
  best-effort completed-task inclusion, guarded full-order replacement, atomic
  add and remove, and the remote write-back identity.
- `myDaySync` — connector reconciliation: the bounded local snapshot, batched
  source-identity lookups, conflict-safe task creation, atomic My Day
  insert/delete/order allocation with matching signals, due-today inclusion,
  and historical source-ID resolution.
- `oneThing` — the weekly selection read, bounded candidate projection, guarded
  auto/manual selection, idempotent completion stamp, and clear.
- `schedule` — list, primary-key upsert, and delete.
- `recentWins` — the bounded recent-completion projection.

Every operation is promise-based and carries only opaque IDs, local
`YYYY-MM-DD` dates, ISO instants, booleans, numeric counts, explicit nulls, and
JSON-safe metadata. No Drizzle table, SQL fragment, transaction handle, or
backend selector crosses the boundary.

## Composition

- SQLite: `createSqliteDailyPlanningPersistence(sqlite)` in
  `src/db/persistence/sqlite-daily-planning-repository.ts`, wired by
  `src/db/persistence/sqlite-worker-runtime.ts`.
- PostgreSQL: `createPostgresDailyPlanningPersistence(pool)` in
  `src/db/postgres/repositories/daily-planning-repository.ts`, wired by
  `src/db/postgres/repositories/index.ts`.

PostgreSQL never imports or borrows the SQLite adapter, and neither adapter
imports the other's driver. Routes resolve the capability through
`getWorkerPersistenceRepositories()` and never import `@/db`, `@/db/schema`,
`drizzle-orm`, `better-sqlite3`, or `pg`.

## Ordering and transactions

Synchronization is added only where a single user's overlapping workers can
produce an observable race:

| Operation | SQLite | PostgreSQL |
| --- | --- | --- |
| Energy replace | immediate transaction | transaction with a table write lock, without an advisory namespace |
| Focus add / remove / slot move | immediate transaction | `daily-planning:focus:<scope>:<date>` advisory lock |
| My Day add / remove / order / auto-include / sync reconciliation | immediate transaction | `daily-planning:my-day:<date>` advisory lock |
| Weekly one-thing auto/manual selection | immediate transaction | `daily-planning:one-thing:<weekMonday>` advisory lock |
| Schedule upsert, schedule delete, recent-win settings | single statement | single statement |

PostgreSQL transactions are explicit `READ COMMITTED` with transaction-scoped
advisory locks; there is no serializable isolation, distributed lock, queue,
lease, or speculative retry framework. Because PostgreSQL has no unique
`(task_id, date)` My Day index, conflict-safe inserts are expressed as
`NOT EXISTS` guards under the date lock rather than `ON CONFLICT`; SQLite uses
`INSERT OR IGNORE` against its existing unique index. Both resolve the same
inserted-row counts.

Ordering parity is pinned explicitly: PostgreSQL uses `NULLS FIRST` for
ascending schedule times and due dates and `NULLS LAST` for descending
completion timestamps, matching SQLite, and every projection carries a
deterministic ID tiebreaker.

Behavioral invariants preserved end to end:

- Focus 3 stays capped at three slots; a duplicate task is a 409 and a full
  board is a 409. Slot moves swap through the reserved sentinel slot so no slot
  is ever occupied twice mid-swap.
- Commitment and withdrawal planning signals are written in the same
  transaction as their `today`-scope focus row and their My Day row.
- My Day removal deletes the row, records the date exclusion idempotently, and
  appends the withdrawal signal atomically, and still resolves the requested
  task ID so Microsoft To Do write-back behavior is unchanged.
- A stale or partial My Day order set still returns 409 and changes nothing.
- Auto-inclusion re-reads after acquiring the writer lock and resolves
  `skipped-write-contention` rather than failing the read.
- Weekly one-thing auto selection never overwrites or duplicates a selection
  another writer already made for the week; completion stamping is idempotent.

## Proofs

- `tests/contracts/daily-planning-persistence.contract.ts` — the shared
  behavior contract, executed against both adapters.
- `tests/db/sqlite-daily-planning-persistence.contract.test.ts` — SQLite.
- `tests/db/postgres-daily-planning-persistence.contract.integration.test.ts` —
  PostgreSQL, plus overlapping-writer proofs for focus capacity and slot
  allocation, My Day duplicate/order allocation and stale reorder,
  auto-inclusion, and weekly one-thing selection. Runs when
  `MC_TEST_POSTGRES_URL` is set.
- `tests/api/postgres-daily-planning-poisoned.test.ts` — imports and executes
  every owned route against a PostgreSQL-shaped composition while `@/db`,
  `@/db/schema`, `@/db/contention`, `@/db/task-history`, and
  `@/lib/utils/sqlite-date` throw on evaluation.
- `tests/api/daily-planning-routes.test.ts` and the existing My Day, navigation,
  mobile-dashboard, one-thing, and recent-win route suites — HTTP behavior.
- `tests/architecture/daily-planning-web-taint-decrement.test.ts` — route
  ownership, cleanliness, excluded-domain non-ownership, adapter confinement,
  and a monotonic migration-unit ceiling of 116. It deliberately does not read
  the canonical baseline.

## Graph decrement

All eleven owned routes were direct Tier A, direct-`@/db` routes and all eleven
become clean:

```
266/A76/B5/clean185/direct46/transitive30/directDB48/lib51/helpers0/units127
266/A65/B5/clean196/direct35/transitive30/directDB37/lib51/helpers0/units116
```

No Tier B reclassification and no newly tainted library. The canonical
`tests/architecture/web-persistence-baseline.json` and
`scripts/postgres-route-sentinel.mjs` remain the only owners of the exact
current graph.
