---
title: "Routines Persistence"
status: implemented
created: 2026-09-05
category: architecture
related:
  - "[Portable Persistence Boundaries](./persistence-boundaries.md)"
  - "[Analytics Persistence](./analytics-persistence.md)"
---

# Routines Persistence

## Scope

The bounded routines domain consists of exactly three routes:

- `src/app/api/routines/route.ts`
- `src/app/api/routines/[id]/route.ts`
- `src/app/api/routines/completions/route.ts`

It owns only `routines` and `routine_completions`. Daily planning, My Day and
sync, mobile dashboard, navigation counts, resets, AI, task, notification,
webhook, and project workflows are separate domains and remain outside this
boundary.

## Contract and composition

`RoutinesRepository` is a Promise-based, driver-neutral contract composed as one
top-level `WorkerPersistenceRepositories.routines` capability. The route-facing
service resolves that selected capability and never evaluates a driver, schema,
backend selector, or fallback. SQLite and PostgreSQL construct the complete
capability at startup; PostgreSQL cannot load or borrow the SQLite adapter.

The contract preserves opaque IDs, local `YYYY-MM-DD` completion dates, ISO
timestamps, parsed cadence JSON, explicit nullability, and boolean values. It
also owns routine sort allocation, updates, soft archive, completion range
reads, cadence-sensitive completion creation, and both supported completion
deletion identities.

## Transactions and ordering

Routine reads retain `(sort_order, created_at)` ordering. Week completions remain
ascending by local date, streak inputs remain descending by local date, and the
general completion endpoint retains its previously unspecified row order.

SQLite allocates sort order and creates a completion in `BEGIN IMMEDIATE`
transactions. PostgreSQL uses READ COMMITTED transactions with transaction-scoped
advisory locks. The statement snapshot is taken after each waiting writer acquires
its lock, so concurrent sort allocation cannot exhaust stale-snapshot retries.
Sort allocation has one domain lock; completion creation locks the
`(routineId, local date)` namespace. The cadence lookup, duplicate check, and
insert therefore commit atomically: `daily` and `specific_days` return the
existing 409 conflict under concurrent duplicates, while over-completion
cadences continue to permit multiple entries on one day.

Deleting a routine remains a soft archive (`isArchived=true`,
`isActive=false`). Completion deletion remains idempotent and supports either
the completion ID or all completions for one routine/date pair.

## Proof

One shared contract runs against SQLite and live PostgreSQL. PostgreSQL adds
eight-writer concurrency proofs for sort allocation and completion idempotency;
a poisoned-SQLite suite imports and executes all three route modules through a
PostgreSQL-shaped composition. The graph ratchet moves exactly those routes from
Tier A to clean:

`266/88/5/173/58/30/59/51/0/139` to
`266/85/5/176/55/30/56/51/0/136`.

The canonical baseline and fail-closed PostgreSQL route sentinel are the sole
exact-current graph owners; the routines layer test keeps only bounded
ownership and monotonic cleanliness assertions.

No schema, migration, dependency, streak algorithm, or unrelated route changes
belong to this layer.
