# Derived-analytics persistence (L17)

The derived-analytics surfaces are the read-only half of the product: dashboard
and reset KPIs, the `/insights` query layer, cumulative flow, and the tag and
word insight services. Layer L17 moved their persistence behind one
backend-neutral contract so they run unchanged on SQLite and PostgreSQL.

## Boundary

| Concern | Module |
| --- | --- |
| Neutral contract | `src/db/persistence/analytics.ts` |
| SQLite adapter | `src/db/persistence/sqlite-analytics-repositories.ts` |
| PostgreSQL adapter | `src/db/postgres/repositories/analytics-repositories.ts` |
| Composition slot | `analytics` on `WorkerPersistenceRepositories` |
| Shared contract suite | `tests/contracts/analytics-repositories.contract.ts` |

`AnalyticsPersistence` publishes five sub-repositories, one per consuming
module:

| Sub-repository | Consumer |
| --- | --- |
| `kpis` | `src/lib/stats/index.ts` |
| `insights` | `src/lib/stats/insights.ts` |
| `flow` | `src/lib/stats/flow-query.ts` |
| `tagInsights` | `src/lib/tag-insights/service.ts` |
| `wordInsights` | `src/lib/word-insights/service.ts` |

They are one slot rather than five because they are registered atomically: a
backend supports every analytics surface or none. The slot is top-level rather
than nested under an existing slot because these read models share no rows and
no serialization namespace with any other worker surface.

## Contract shape

The contract is **aggregate-shaped**, not row-dumping. Every `count(*)`,
`GROUP BY`, `DISTINCT`, window function, and `LIMIT` that ran in SQL before L17
still runs in SQL, and every reducer that ran in TypeScript still runs in
TypeScript. That split is what makes the migration behaviour-preserving: the
adapters own exactly the work the database already did, and the libraries own
exactly the work they already did.

Only opaque string IDs, ISO-8601 timestamp strings, local `YYYY-MM-DD` date
strings, numbers, booleans, and plain record types cross the boundary. No
driver, pool, transaction, SQL fragment, Drizzle table, or backend selector
does. Local-calendar boundaries are resolved by the caller and handed across as
instants, so neither adapter owns any timezone policy.

Consumers resolve their repository lazily:

```ts
async function kpiRepository(): Promise<KpiAnalyticsRepository> {
  return (await getWorkerPersistenceRepositories()).analytics.kpis;
}
```

## Transactions and concurrency

There are none, by design.

Every method is a single pooled statement that is acquired and released. The
surface is read-only, so there is no command, revision, compare-and-swap,
idempotency key, or lease to specify. The multi-query composites — `computeKpis`
and the eleven-way `computeInsightsSection('summary')` fan-out — were explicitly
non-atomic under SQLite and stay non-atomic under PostgreSQL. Wrapping them in a
transaction or a `REPEATABLE READ` snapshot would be a semantic change (callers
would start seeing a consistent snapshot where they see a torn one today) and
would pin a pooled connection across a wide fan-out.

The per-project loop in `getProjectActivity` (three queries per active project)
and the seven sequential day queries in `computeDailyAvg` are preserved
deliberately. They are the existing query profile; collapsing them would be an
optimization rather than backend parity.

## The four translations

Each is pinned by a case in the shared contract suite and asserted structurally
by `tests/architecture/analytics-taint-decrement.test.ts`.

### 1. Instant comparison

SQLite compares stored timestamps with `julianday(column) >= julianday(?)`.
Its parser validates each field independently against a fixed range and then
computes a Julian day *arithmetically*, which produces three behaviours a cast
cannot reproduce:

1. Anything outside the accepted domain yields `NULL`, so the row is *excluded*
   rather than the query failing.
2. Fields that are in range but past the end of their month or day are
   **normalized, not rejected**: `2026-02-31` is `2026-02-01` plus 30 days
   (`2026-03-03`), `2026-04-31` is `2026-05-01`, and `24:30` is the next day at
   `00:30`.
3. An offsetless timestamp is read as UTC.

The accepted domain, field by field, exactly as SQLite bounds it: year 4 digits,
month `01-12`, day `01-31` (never checked against the month's real length),
hour `00-24`, minute and second `00-59`, optional fractional seconds of any
length, and a zone that is either `Z`/`z` or a signed offset of `00-14` hours
and `00-59` minutes. **SQLite requires the colon inside that offset**, so
`+0500` is rejected even though PostgreSQL accepts it. The date/time separator
is `T` or whitespace — lowercase `t` is not a separator, though `z` is a valid
zone — and leading whitespace before the zone and trailing whitespace are both
allowed.

PostgreSQL therefore *constructs* the instant from validated fields instead of
casting the text:

```sql
CASE
  WHEN col ~ '<domain pattern>'
  THEN (
    (
      make_date(CASE WHEN <year> = 0 THEN -1 ELSE <year> END, <month>, 1)::timestamp
      + make_interval(days => <day> - 1, hours => <h>, mins => <m>, secs => <s>)
    ) AT TIME ZONE 'UTC'
  ) - COALESCE(make_interval(mins => <offset>), INTERVAL '0')
  ELSE NULL
END
```

Because SQLite's Julian-day formula adds the day, hour, minute, and second
fields linearly, `make_date(Y, M, 1)` plus `make_interval` reproduces its
normalization exactly. `col::timestamptz` and `pg_input_is_valid` both reject
the overflow values SQLite accepts, and `pg_input_is_valid` additionally accepts
the colon-less offsets SQLite refuses, so neither can express this boundary.
Year 0 exists in SQLite's proleptic calendar and is 1 BC in PostgreSQL's, which
`make_date` spells as `-1`.

Deliberately **not** reproduced, and outside the domain above: SQLite's `'now'`
keyword, bare Julian-day numbers, time-only strings, and negative years. No
writer in this codebase stores any of them in a timestamp column, and honouring
`'now'` would make a read nondeterministic.

Like `julianday(column)` before it, this expression is a function of the column
and so does not use an index. That matches the SQLite scan behaviour it
replaces; no read in this layer previously benefited from an index on a
timestamp column.

### 2. Byte ordering

SQLite's default `BINARY` collation orders text by bytes. PostgreSQL's default
collation is locale-aware and, for example, ignores hyphens when comparing —
which reorders UUID-shaped IDs and punctuated names. Every text `ORDER BY`,
window `ORDER BY`, and `row_number()` partition order in the PostgreSQL adapter
is therefore pinned with `COLLATE "C"`.

### 3. ASCII-only case folding

SQLite's `lower()` folds only ASCII `A-Z`. The synthetic-tag prefix scan uses
`translate(btrim(name), 'ABC…Z', 'abc…z')` so a non-ASCII uppercase tag name
classifies identically on both backends, the same technique L16 used for
`COLLATE NOCASE`.

### 4. The notification attention predicate

`src/lib/stats/index.ts` uses the Drizzle `notificationNeedsAttention()`
helper, which is **not** equivalent to the sibling
`NOTIFICATION_NEEDS_ATTENTION_SQL` text constant in the same module: the
constant's digest exclusion drops rows with a `NULL` `level`, the function
keeps them. `notifications.level` is `NOT NULL DEFAULT 'fyi'` in both schemas,
so no live row diverges, but the PostgreSQL adapter reproduces the *function*
and the contract pins the distinction so a later refactor cannot silently swap
in the constant.

## Ordering tiebreakers

L17 defines a total order where SQLite previously left ties unspecified. Both
adapters apply the same tiebreakers:

| Read | Order |
| --- | --- |
| `sourceBreakdownIn` | `count DESC, connector_type` |
| `listActiveProjects` | `name, id` |
| `listVisibleProjects` | `name` (unchanged) |
| `deliveryFilterOptions` (projects) | `name, id` |
| `listDeliveryRecords` | `completed_at, id` |
| `listActiveRoutines` | `id` |
| `listRoutineCompletions*` | `routine_id, date` |

Every already-explicit order — `asc(tasks.id)` in the bounded tag and word
reads, `desc(usageCount), asc(tags.name), asc(tags.id)` in `listTopTags`, the
three `row_number() OVER` window orders, and `occurred_at, id` in
`listTaskTransitions` — is reproduced unchanged.

## Schema

L17 required no migration. It adds no column, table, constraint, default, or
index, and every table it reads already ships in `drizzle/postgres`:
`tasks`, `task_projects`, `task_tags`, `tags`, `hub_projects`,
`project_phases`, `project_phase_items`, `task_history_events`, `routines`,
`routine_completions`, `notifications`, `triage_items`, `my_day_items`,
`focus_items`, `connector_configs`.

## What L17 deliberately did not take

- **`src/db/task-history.ts`** is unchanged and keeps both of its consumers. The
  SQLite adapter calls `getTaskTransitionsInRange` directly, which an adapter is
  allowed to do, so the `task_history_events` read model has a single owner and
  a later burn-report layer inherits it as is.
- **`src/lib/reports/burn.ts`** and `/api/projects/[id]/reports/burn` are a
  history-replay report, not a derived read model, and their SQLite
  `json_valid`/`json_extract`/`json_each` membership predicates need a
  materially different PostgreSQL translation.
- **`/api/resets/stats`, `/api/mobile-dashboard`, `/api/tasks/quick-sort-stats`**
  hold inline Drizzle queries in the route file itself. Migrating them means
  extracting new services from route files, which is a different work shape.
- **`src/lib/stats/observations.ts`** and its deferred AI provider import belong
  to the AI provider layer. That import is why
  `/api/insights/observations` reclassifies to Tier B rather than becoming
  clean.

## Tests

| Suite | Purpose |
| --- | --- |
| `tests/contracts/analytics-repositories.contract.ts` | One behaviour suite run against both backends, including all four translations, every tiebreaker, and the numeric type of every count |
| `tests/db/sqlite-analytics-repositories.test.ts` | SQLite driver over a real temporary database |
| `tests/db/postgres-analytics-repositories.integration.test.ts` | PostgreSQL driver plus no-transaction and pooled-client-release proofs |
| `tests/db/postgres-analytics-poisoned.test.ts` | All six route handlers and five services run with `@/db` throwing |
| `tests/architecture/analytics-taint-decrement.test.ts` | Owned route/library cleanliness, adapter confinement, and the monotonic L17 migration-unit ceiling; the PostgreSQL route sentinel owns the exact current graph |
