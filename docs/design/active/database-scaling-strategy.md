---
title: "Database Scaling and Migration Strategy"
status: active
created: 2026-08-03
last_reviewed: 2026-08-29
category: architecture
related:
  - "[Architecture Overview](../../architecture/overview.md)"
  - "[Sync Engine](../../architecture/sync-engine.md)"
  - "[Data Model](../../architecture/data-model.md)"
  - "[Portable Persistence Boundaries](../../architecture/persistence-boundaries.md)"
  - "[PostgreSQL Deployment](../../operations/postgresql.md)"
---

# Database Scaling and Migration Strategy

## Decision

PostgreSQL is the approved production target for Mission Control's core
relational store. Portable persistence boundaries landed in
[#1623](https://github.com/rsocko/mission-control/pull/1623), and the selectable
PostgreSQL runtime, schema, migrations, core repositories, durable sync queue,
search, health, and telemetry implementations landed in
[#1624](https://github.com/rsocko/mission-control/pull/1624).

Approval and implementation do not mean that every deployment has cut over.
SQLite remains the default compatibility backend when
`MC_DATABASE_BACKEND` is unset. Treat the homelab deployment as SQLite-backed
until its maintenance-window migration is completed and recorded through
[#1155](https://github.com/rsocko/mission-control/issues/1155) and
[homelab-config#574](https://github.com/rsocko/homelab-config/issues/574).

## Why the Decision Changed

SQLite was appropriate for Mission Control's original single-user, single-host,
local-first topology. It still offers simple operation, low-overhead local
access, transactional consistency, and straightforward development.

Production evidence later showed repeated five-second `SQLITE_BUSY` timeout
exhaustion and database-attributable worker contention even after startup and
transaction-duration improvements. Those incidents met the strategy's measured
migration trigger. PostgreSQL removes the single-file writer boundary, provides
asynchronous database I/O and stronger operational visibility, and better fits
the web-plus-worker production topology.

PostgreSQL does not make connector side effects safe to parallelize. Mission
Control still supports exactly one sequential sync worker because a database
lease cannot fence an external API call still running in a stalled predecessor.
Parallel connector execution requires connector-specific idempotency, fencing,
compensation, or equivalent safeguards.

## Backend and Deployment Status

| Concern | PostgreSQL | SQLite |
|---|---|---|
| Architectural role | Approved production target | Default compatibility and local-development backend |
| Application status | Implemented and selected with `MC_DATABASE_BACKEND=postgres` | Implemented and selected by default |
| Homelab deployment | Pending the tracked infrastructure change and cutover | Current assumed backend until cutover is recorded |
| Connection model | Asynchronous pooled server connection | In-process `better-sqlite3` connection |
| Schema and migrations | PostgreSQL-specific clean baseline and migration stream | Historical SQLite migration stream |
| Queue, search, and health | PostgreSQL-specific repository and telemetry adapters | SQLite WAL, FTS5, queue, and telemetry adapters |

The runtime fails instead of silently falling back to SQLite when PostgreSQL is
selected but cannot initialize. Workflows that still depend on the raw SQLite
compatibility API also fail explicitly under PostgreSQL; they must move behind a
portable repository or a named backend adapter before they can run there.

## Cutover Strategy

The application does not dual-write, copy data automatically, or provide a
zero-downtime backend switch. The production migration therefore requires an
explicit maintenance window:

1. Provision PostgreSQL, storage, health checks, monitoring, backups, and
   least-privilege credentials through the homelab configuration.
2. Stop web and worker writers and retain an integrity-checked final SQLite file
   as the rollback artifact.
3. Copy the required data with the SQLite-to-PostgreSQL import procedure tracked
   in #1681 and validated through the #1155 cutover-readiness checklist.
4. Configure both web and worker with the same PostgreSQL backend, URL, TLS,
   pool, and timeout settings.
5. Start the services and verify representative CRUD, connector sync, queue and
   lease, notification, settings, search, health, and metrics behavior.
6. Monitor PostgreSQL-backed operation and roll back to the preserved SQLite
   database if a material correctness failure appears.

Detailed application migration and validation work belongs to
[#1155](https://github.com/rsocko/mission-control/issues/1155). PostgreSQL
provisioning, secrets, storage, backup, monitoring, deployment configuration,
and the homelab maintenance window belong to
[homelab-config#574](https://github.com/rsocko/homelab-config/issues/574).
Operator settings and failure behavior are documented in the
[PostgreSQL deployment guide](../../operations/postgresql.md). The
[cutover-readiness checklist](../../operations/postgresql-cutover-readiness.md)
defines the import rehearsal evidence required before planning activation.

## Compatibility and Portability Rules

New persistence work must use a focused repository or application-service port.
Driver handles, ORM transaction objects, SQL fragments, PRAGMAs, and backend
error strings remain adapter details. IDs, timestamps, booleans, JSON,
pagination, errors, and transaction outcomes cross those boundaries in
backend-neutral forms.

Backend-specific behavior remains explicitly named:

- PostgreSQL owns its pool, TLS policy, advisory migration lock, SQL dialect,
  queue locking, full-text search, and database health probe.
- SQLite owns local-file bootstrap, WAL and PRAGMA behavior, `BEGIN IMMEDIATE`
  transaction semantics, FTS5, and busy/checkpoint telemetry.
- A workflow must select one complete persistence composition. It must never
  mix repositories from different backends.

Specialized analytical, vector, search, or graph stores should be introduced
only when a measured workload requires a separate engine. They do not replace
the core PostgreSQL relational target by default.

## SQLite Compatibility Operations

SQLite observability remains relevant for local development, compatible
self-hosted deployments, and the homelab before cutover. Runtime telemetry
records bounded query and transaction latency, lock waits, terminal busy
failures, WAL allocation and pending frames, checkpoint results, and correlated
event-loop delay.

Mission Control does not run automatic `wal_checkpoint(TRUNCATE)`. Truncation is
an explicit operator maintenance action during a confirmed idle window.
Recurring latency threshold breaches, timeout exhaustion, checkpoint starvation,
or abnormal pending WAL growth remain critical operational signals even though
PostgreSQL is now the production target.

## Tracking

- Production data migration, validation, cutover, and rollback:
  [#1155](https://github.com/rsocko/mission-control/issues/1155).
- Homelab PostgreSQL provisioning and deployment cutover:
  [homelab-config#574](https://github.com/rsocko/homelab-config/issues/574).
- Portable core persistence boundaries:
  [#1623](https://github.com/rsocko/mission-control/pull/1623).
- PostgreSQL application support:
  [#1624](https://github.com/rsocko/mission-control/pull/1624).
- Architecture documentation alignment:
  [#1157](https://github.com/rsocko/mission-control/issues/1157).
