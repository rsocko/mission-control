---
title: "Database Scaling and Migration Strategy"
status: active
created: 2026-08-03
last_reviewed: 2026-08-10
category: architecture
related:
  - "[Architecture Overview](../../architecture/overview.md)"
  - "[Sync Engine](../../architecture/sync-engine.md)"
  - "[Data Model](../../architecture/data-model.md)"
  - "[Structured Graph Workspace Architecture](../proposed/structured-graph-workspace/architecture.md)"
---

# Database Scaling and Migration Strategy

## Decision

Mission Control should continue using SQLite for its core relational store while
the product remains single-user, single-host, local-first, and deployable with a
reliable local persistent volume.

Feature count, database file size, task count, connector count, analytics, and
the structured graph workspace are not migration triggers by themselves.
Migration should be driven by deployment topology, concurrency, availability,
or measured service-level failures.

PostgreSQL is the preferred successor when the core workload requires a
multi-writer server database. Specialized analytical, search, vector, or graph
stores should be introduced only for workloads that require them; they should
not replace the core relational store by default.

## Current Architecture

Production runs:

- one Next.js web process;
- exactly one sequential durable sync worker; and
- one shared SQLite database on a local Docker volume.

SQLite uses WAL mode, foreign-key enforcement, and a five-second busy timeout.
The synchronous `better-sqlite3` driver gives low-overhead local access, but a
contended operation can block the owning Node.js event loop while waiting.

The worker's single-replica restriction is not solely a database limitation.
Connector calls can produce external side effects that cannot be fenced after a
lease takeover. PostgreSQL would improve queue coordination, but would not make
those remote operations idempotent or automatically make parallel connector
workers safe.

## Why SQLite Remains Appropriate

The current workload benefits from:

- simple local-first deployment and operation;
- transactional consistency across tasks, sync state, notifications, and jobs;
- inexpensive indexed reads and bounded transactions;
- straightforward local development; and
- no network database dependency.

The proposed structured graph workspace also remains suitable for SQLite while
queries are bounded to workspace loads, direct neighbors, one- or two-hop
traversals, ordered hierarchies, and selected subgraph serialization.

## Migration Triggers

### Architectural triggers

Plan and execute a PostgreSQL migration before introducing any of the following:

1. Multi-user accounts, collaborative editing, tenant isolation, or
   user-scoped authorization in the data model.
2. More than one web host or replica writing to the same core database.
3. Independently scalable services that require concurrent core-database
   writers.
4. A deployment where the database file would reside on NFS, SMB, or another
   multi-host/network filesystem whose locking and durability semantics are not
   explicitly safe for SQLite.
5. Managed cloud or serverless operation without a stable, single-host local
   persistent volume.
6. Availability requirements that need database replication, automated
   failover, or point-in-time recovery.

These are design gates, not thresholds to discover after launch.

### Measured operational triggers

Begin migration planning when tuned SQLite operation cannot meet agreed service
levels. Initial signals to calibrate through load testing are:

- recurring `SQLITE_BUSY` or `database is locked` failures;
- busy-wait or write-transaction latency above 100 ms at p95 or 500 ms at p99;
- database-attributable event-loop stalls or request latency;
- continuous WAL growth or checkpoint starvation caused by long-lived reads;
- failure to meet API and queue SLOs under a mixed workload at five times the
  forecast peak; or
- backup and restore performance that cannot satisfy the documented RPO and
  RTO.

Any five-second busy-timeout exhaustion is already critical. The application
must not wait for a nonzero error budget to accumulate before responding.
Thresholds above are initial engineering targets, not universal SQLite limits.

## Future Review Gates

Reassess this decision before:

- mobile offline-first synchronization introduces multi-device conflict
  resolution or sustained replay;
- external-agent and multi-agent workflows create materially concurrent inbound
  writes;
- IoT, NATS, or webhook ingestion becomes continuous or burst-heavy;
- analytics introduces long-running reads over the live transactional database;
- the graph workspace requires hundreds of thousands or millions of
  relationships, frequent unknown-depth traversal, graph-pattern queries,
  shortest-path or centrality analysis, or many concurrent graph users; or
- deployment moves from a single homelab host to a horizontally scaled service.

Reassessment does not imply automatic migration. Each gate should be evaluated
against measured concurrency, latency, WAL behavior, recovery requirements, and
operational complexity.

## Work Required Now

### Database observability

Runtime telemetry now records bounded query and transaction duration
percentiles by operation/category, successful lock waits separately from
terminal busy failures, timeout exhaustion, and value-safe slow-operation
metadata. Each web and worker heartbeat correlates that synchronous database
time with its event-loop p99 and timer drift. Passive-checkpoint results, WAL
bytes, allocation state, pending frames, checkpoint probe duration, checkpoint
age, and starvation are included in `GET /api/health`.

WAL allocation and checkpoint backlog are separate signals. An allocated WAL
with zero pending frames is `retained`: SQLite is reusing a fully checkpointed
file, so its size alone does not degrade health. `pending` or `busy` allocation
can degrade health after the byte threshold is crossed, and sustained pending
work past the starvation threshold is critical. Large retained allocation also
does not bypass the normal checkpoint probe interval, avoiding repeated passive
checkpoints solely because SQLite kept the file allocated.

A representative local run of 30,000 autocommit writes produced a 134 MiB WAL.
A passive checkpoint completed 34,072 frames in 196 ms, left the 134 MiB file
allocated, and reduced write p95 from 0.099 ms to 0.017 ms for the next 1,000
writes. A held reader left 202 frames pending and a concurrent truncating
checkpoint made the passive probe report busy immediately. These measurements
show that retained allocation did not impair this workload, while truncation can
contend with readers and occupy the checkpoint lock.

Mission Control therefore does not run automatic `wal_checkpoint(TRUNCATE)`.
Truncation is an explicit operator maintenance action during a confirmed idle
window, not a request-path or connector-worker task. Reconsider bounded
idle-time truncation only if retained allocation causes a measured disk-capacity
problem and the scheduler can prove there are no active requests, connector
writes, or other database maintenance operations. Passive probes remain the
runtime policy because they do not wait for readers or writers.

Use recurring p95/p99 threshold breaches, any busy-timeout exhaustion,
checkpoint starvation, or sustained abnormal WAL growth to open the migration
review gate. Confirm the signal in both process records and correlate database
time with event-loop delay before attributing a stall to SQLite. Calibrate the
defaults with the mixed-workload capacity test; do not raise thresholds merely
to clear health. Track this work in
[#2104](https://github.com/rsocko/mission-control/issues/2104).

### Event-loop isolation

Complete [#990](https://github.com/rsocko/mission-control/issues/990), or an
equivalent dedicated-writer design, before connector and agent expansion makes
synchronous write contention materially larger. Preserve transactional
boundaries and explicit error propagation.

### Tested backup and recovery

Implement a SQLite-safe online backup procedure, documented retention, integrity
verification, and a repeatable restore drill. Define and measure the intended
RPO and RTO. Track this work in
[#2106](https://github.com/rsocko/mission-control/issues/2106).

### Portable data-access boundaries

Prevent further migration-cost growth by placing new persistence behind
repository or service interfaces, reducing direct `better-sqlite3` access, and
keeping identifiers, timestamps, JSON handling, and transaction contracts
portable. Existing raw SQLite access can be migrated incrementally rather than
rewritten speculatively. Track this work in
[#2107](https://github.com/rsocko/mission-control/issues/2107).

### Documentation consistency

Correct architecture documents that currently describe PostgreSQL as the active
store without a corresponding decision or migration plan. Future documents
must distinguish the current SQLite architecture from a conditional PostgreSQL
target. Track this work in
[#2105](https://github.com/rsocko/mission-control/issues/2105).

## Capacity Test

Maintain a repeatable mixed-workload test representing:

- interactive task and notification mutations;
- connector enqueue, claim, upsert, reconciliation, and event writes;
- webhook and external-agent ingestion;
- dashboard, search, analytics, and graph reads; and
- backup/checkpoint activity.

The baseline and forecast peak must be recorded in operations per second and
concurrency, rather than expressed only as a multiplier. Run the test at the
forecast peak and at five times that peak. Record request latency, transaction
latency, busy waits, event-loop delay, queue age, WAL behavior, CPU, memory, and
disk utilization.

Track the capacity-test implementation in
[#2108](https://github.com/rsocko/mission-control/issues/2108).

## Recommended Sequence

1. Implement tested backup and recovery first because it addresses current data
   durability and makes later performance or migration work safer.
2. Add database observability, then use those metrics in the mixed-workload
   capacity test.
3. Establish portable data-access boundaries in parallel with new feature work
   so migration cost does not continue to grow.
4. Complete event-loop isolation before materially increasing connector,
   webhook, or agent write volume. Use observability and capacity results to
   validate the chosen design.
5. Correct architecture documentation immediately as a small, independent task.
6. Keep migration readiness open as a review-gate tracker; do not schedule the
   migration until an architectural or measured trigger is met.

## Migration Direction

When an architectural or measured trigger is met:

1. Freeze new direct SQLite-specific access.
2. Validate repository contracts against both SQLite and PostgreSQL.
3. Introduce PostgreSQL schema and migrations with equivalent constraints.
4. Build and rehearse an idempotent data-copy and validation process.
5. Run a representative load test and restore drill on PostgreSQL.
6. Cut over with an explicit write freeze, validation gate, and rollback plan.
7. Retain specialized stores only where their workload justifies the added
   operational boundary.

PostgreSQL queue primitives such as row locking and `SKIP LOCKED` can support
parallel work distribution. Parallel connector execution still requires
connector-specific idempotency, fencing, or compensation for external side
effects.

## Tracking

- Future migration readiness and reassessment:
  [#2103](https://github.com/rsocko/mission-control/issues/2103).
- Database observability:
  [#2104](https://github.com/rsocko/mission-control/issues/2104).
- Event-loop isolation: [#990](https://github.com/rsocko/mission-control/issues/990).
- Tested backup and recovery:
  [#2106](https://github.com/rsocko/mission-control/issues/2106).
- Portable data-access boundaries:
  [#2107](https://github.com/rsocko/mission-control/issues/2107).
- Architecture documentation consistency:
  [#2105](https://github.com/rsocko/mission-control/issues/2105).
- Mixed-workload capacity test:
  [#2108](https://github.com/rsocko/mission-control/issues/2108).
