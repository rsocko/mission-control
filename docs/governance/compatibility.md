# Compatibility Policy

Mission Control is pre-1.0. Until a 1.0 release establishes stable contracts,
minor releases may contain breaking changes.

## Supported versions

- The latest release and the default branch receive bug and security fixes.
- Older releases are not guaranteed to receive backports.
- Node.js 22 LTS is the supported development and runtime baseline.
- SQLite data must be backed up before an upgrade. Database migrations are
  forward-only unless a release note explicitly documents rollback support.

## Persisted SQLite origins

CI exercises frozen synthetic databases from three named migration origins:

- `0000_sweet_chameleon`, the oldest supported baseline;
- `0047_isolate_sync_worker`, the first durable sync-queue checkpoint; and
- `0104_quick_sort_undo`, immediately before the permanent GitHub NodeID
  cutover.

These checkpoints are supported upgrade origins, not a guarantee for arbitrary
hand-edited databases. Each fixture must reach every current migration hash and
preserve representative task, project, connector, sync, notification, setting,
and search behavior. A checkpoint may be retired only through an explicit
change to this policy and the release notes so operators can upgrade through a
supported intermediate release first.

## Database support contract

Mission Control supports two relational backends with different operational
tiers:

| Contract area | PostgreSQL | SQLite |
| --- | --- | --- |
| Supported role | Production and durable self-hosted deployments | Local development, the ephemeral public demo, and bounded single-host self-hosting |
| Core product behavior | Required | Required |
| Authoritative relational data | Required | Required |
| Production concurrency and scale | Supported | Not guaranteed |
| Keyword search | PostgreSQL full-text projections | FTS5 |
| Semantic retrieval | pgvector/HNSW when configured; bounded fallback otherwise | Bounded in-process scan |
| Demo reset/sample-data commands | Not supported | Supported |
| Database operations | Pool, TLS, locks, backups, and PostgreSQL telemetry | File backup, WAL/PRAGMA maintenance, busy handling, and SQLite telemetry |

### Required parity

A feature that persists authoritative product state must either:

1. work through a backend-neutral repository or application-service contract on
   both supported backends; or
2. be declared backend-specific in this policy before it ships.

Required parity covers:

- authoritative tables, columns, relationships, constraints, defaults, and
  lifecycle outcomes;
- user-visible CRUD, connector, sync, notification, planning, settings, AI,
  finance, triage, and recovery behavior;
- stable ordering, pagination, idempotency, transaction outcomes, and error
  semantics where callers can observe them;
- schema migration from each supported persisted SQLite origin and from the
  current PostgreSQL migration baseline; and
- tests for the shared contract plus backend-specific correctness where SQL
  dialects or concurrency mechanisms differ.

New schema changes must update both schema definitions and migration streams in
the same change. New persistence workflows must not silently fall back from one
backend to the other or mix repositories from both backends in one process
composition. PostgreSQL selection fails closed when its composition is
incomplete.

### Allowed divergence

The following differences are intentional when they preserve the required
product behavior and remain explicit in code and documentation:

- SQL dialect, connection management, transaction and locking mechanisms;
- SQLite FTS5 versus PostgreSQL full-text search projections;
- SQLite WAL/PRAGMA/busy telemetry versus PostgreSQL pool/lock/query telemetry;
- bounded SQLite semantic scans versus optional PostgreSQL pgvector/HNSW
  acceleration and its higher scale guarantee;
- backend-specific migration/bootstrap and backup/restore procedures; and
- SQLite-only reset and sample-data operations used by the ephemeral demo.

Performance parity is not promised. SQLite is a bounded compatibility backend:
keyword search remains supported, but full semantic recall above its configured
candidate ceiling, multi-writer throughput, and web/worker production
concurrency are not guaranteed.

### Change and release gates

- CI must keep the PostgreSQL route sentinel at zero Tier A routes. Tier B
  entries require a named, reviewed backend-selection boundary and an exact
  allowlist; they cannot conceal a workflow that opens SQLite under PostgreSQL.
- Shared repository contracts must run against SQLite and PostgreSQL. A missing
  PostgreSQL service may skip integration execution locally, but CI remains the
  authoritative PostgreSQL integration gate.
- Derived state may use backend-specific storage, but it must be rebuildable
  from authoritative rows and excluded explicitly from cross-backend copy
  invariants.
- A backend-specific feature must document its unavailable behavior and fail
  explicitly; it must not return a success-shaped fallback.

### Lifecycle

SQLite support may be narrowed only through the deprecation policy below. A
proposal to retire durable SQLite deployments must include usage evidence,
replacement plans for the public demo and local development, migration
instructions, and at least one minor release of notice. Removing SQLite
entirely additionally requires PostgreSQL production history across at least
two releases and a supported path for every persisted SQLite origin listed
above.

PostgreSQL production activation is independent of SQLite retirement. The
one-way `npm run db:import:postgres` command exists only for an operator-approved
SQLite-to-PostgreSQL rehearsal or cutover. It is not dual-write, replication,
routine maintenance, or a recurring parity test. Its synthetic CI coverage
protects the migration utility; operators run the full data rehearsal only when
planning or performing a cutover.

## Public contracts

Breaking changes to documented APIs, MCP tools, connector contracts,
configuration variables, or deployment inputs must be called out in release
notes with migration instructions. Experimental and proposed documents do not
create compatibility guarantees.

Connector compatibility depends on supported upstream APIs. A connector may be
disabled when an upstream service removes a required API or when safe
authentication is no longer available.

## Deprecation

When practical, a public contract is deprecated for at least one minor release
before removal. Security fixes may require immediate removal or restriction of
unsafe behavior.
