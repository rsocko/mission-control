---
title: PostgreSQL deployment
sidebar_label: PostgreSQL
---

# PostgreSQL deployment

Mission Control can use PostgreSQL as its production relational backend while
SQLite remains the default for local development and a temporary import source.
PostgreSQL is selected explicitly:

```env
MC_DATABASE_BACKEND=postgres
MC_POSTGRES_URL=postgres://mission_control:REDACTED@database.example/mission_control
MC_POSTGRES_SSL_MODE=verify-full
```

PostgreSQL is the approved production target and the application backend is
implemented. This guide does not imply that a particular deployment has already
cut over. Treat the homelab as SQLite-backed until the maintenance-window
migration is completed through
[#1155](https://github.com/rsocko/mission-control/issues/1155) and
[homelab-config#574](https://github.com/rsocko/homelab-config/issues/574).
The architectural status and compatibility posture are recorded in the
[database scaling and migration strategy](../design/active/database-scaling-strategy.md).

`MC_POSTGRES_URL` is a server-only secret. Store it in the deployment secret
manager or the uncommitted `.env.local` used by the container deployment. Never
put it in a `NEXT_PUBLIC_` variable, image layer, Compose command line, log
message, or committed environment file. The web and sync-worker processes must
receive the same backend selection and point to the same database.

## Packaged worker persistence parity

Issue [#1680](https://github.com/rsocko/mission-control/issues/1680) completes
PostgreSQL persistence for the packaged `src/sync-worker.ts` runtime. The
PostgreSQL composition includes queue execution and retry/recovery, all
registered connector repositories, GitHub and finance workers, Monarch
connection recovery, notification delivery, reminders, scheduled triage,
health/telemetry, cron polling, and retention maintenance. Repository
registration is atomic and fails closed; a PostgreSQL configuration or
registration error never falls back to SQLite.

Architecture tests walk the source graph from the real worker entry and inspect
the built artifact. The live PostgreSQL worker gate poisons Mission Control
SQLite modules, starts the packaged worker and every scheduler family, exercises
representative durable execution/retry/recovery behavior, stops cleanly, and
restarts to verify lease recovery and idempotency.

This is worker persistence parity only. It does **not** import existing SQLite
data (tracked by [#1681](https://github.com/rsocko/mission-control/issues/1681)),
select PostgreSQL in production, change deployment configuration, establish
complete web/API persistence parity, or perform the production cutover tracked
by [#1155](https://github.com/rsocko/mission-control/issues/1155).

Keep SQLite databases and rollback artifacts until those separate activation
and cutover steps are complete.

## Database role

Use a dedicated, non-superuser login. It needs `CONNECT` on the Mission Control
database and ownership of the Mission Control schema and tables because the
designated initializer applies migrations during startup. It does not need
cluster administration, replication, role management, or access to other
databases.

Create the role and database through the deployment's administrative channel,
then set its password interactively or through the platform secret manager. Do
not place a real password in shell history or repository files.

```sql
CREATE ROLE mission_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE mission_control OWNER mission_control;
```

## TLS

`verify-full` is the default and verifies both the certificate chain and server
name. For a private CA, mount its PEM file into the container and set
`NODE_EXTRA_CA_CERTS` to that path; Node.js does not automatically use the
Alpine host certificate store. `verify-ca` validates the chain without matching
the database hostname. `require` encrypts traffic without authenticating the
server certificate and should be limited to a separately authenticated private
network.

Use `disable` only for a trusted local PostgreSQL process or a disposable CI
database:

```env
MC_POSTGRES_SSL_MODE=disable
```

## Pool and timeout settings

Each Mission Control process owns a pool. Size the database for the sum of the
web and worker pool maxima plus operational connections.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MC_POSTGRES_MIN_CONNECTIONS` | `0` | Minimum retained pool clients |
| `MC_POSTGRES_MAX_CONNECTIONS` | `10` | Maximum clients per process |
| `MC_POSTGRES_IDLE_TIMEOUT_MS` | `30000` | Idle client retirement |
| `MC_POSTGRES_CONNECTION_TIMEOUT_MS` | `10000` | Connection acquisition timeout |
| `MC_POSTGRES_STATEMENT_TIMEOUT_MS` | `30000` | Server statement timeout |
| `MC_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS` | `30000` | Idle transaction timeout |
| `MC_POSTGRES_APPLICATION_NAME` | `mission-control-{role}` | PostgreSQL activity label |

Do not raise pool or timeout limits merely to clear health warnings. Investigate
waiting clients, slow statements, lock waits, and database capacity first.

## Startup and migrations

The configured database initializer acquires an advisory lock before applying
the PostgreSQL migration stream. Other processes wait for the initializer and
then use the migrated schema. Startup fails instead of falling back to SQLite
when PostgreSQL configuration, connectivity, authentication, or migration
fails.

PostgreSQL starts from a clean baseline migration matching the current
application schema. The historical SQLite migration chain is not replayed
against PostgreSQL.

## pgvector indexed retrieval

The 100,000-entity semantic retrieval path requires PostgreSQL 17 and pgvector
0.8.6. The approved image is pinned by digest:

```text
pgvector/pgvector:0.8.6-pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f
```

Creating an extension is a database-administrator operation. Run it through the
deployment's administrative channel before starting Mission Control, then verify
the exact installed version:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

The second statement must return `0.8.6`. Do not grant the application role
superuser or database-creation rights just to create the extension. Optional
semantic mode can remain keyword-only when the extension or compatible index is
unavailable. Required mode must fail readiness rather than fall back to an
unbounded scan.

HNSW index builds at the validated 100,000-entity, 1,536-dimension profile require
at least 2 GiB of container shared memory. The opt-in Compose environment and CI
service set this explicitly. The coordinated production deployment must carry the
same `shm_size` contract, or an independently revalidated equivalent, before
activation.

Identity-specific HNSW provisioning runs outside a transaction because PostgreSQL
requires that for `CREATE INDEX CONCURRENTLY`. The repository raises
`statement_timeout` to 15 minutes only on the checked-out provisioning session,
matching the validated build-time gate, and resets it before returning the client
to the production pool. Normal application statements retain the default 30-second
timeout.

The repository's local environment is opt-in and does not alter the SQLite-default
`docker-compose.yml` deployment:

```text
docker compose -f docker-compose.pgvector.yml \
  --profile postgres-vector up -d postgres-vector
```

It listens on port 5433 by default, bootstraps the extension in a new data volume
as the container administrator, and becomes healthy only when PostgreSQL responds
and reports pgvector 0.8.6. For a reused volume without the extension, perform the
admin bootstrap manually. Point an explicitly PostgreSQL-configured development
instance or the benchmark at it; merely starting the profile does not switch
Mission Control:

```env
MC_BENCHMARK_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5433/mission_control_vector_dev?sslmode=disable
```

The example password is disposable local-only configuration. Override
`MC_PGVECTOR_ADMIN_USER`, `MC_PGVECTOR_ADMIN_PASSWORD`,
`MC_PGVECTOR_DATABASE`, and `MC_PGVECTOR_PORT` as needed. Never reuse these
defaults outside the opt-in local environment.
The benchmark refuses database names that are not explicitly marked `test`, `ci`,
`dev`, `sandbox`, `local`, or `benchmark`, and rejects production-looking hosts
or database names.

The backup gate needs PostgreSQL 17 `pg_dump` and `pg_restore`. If compatible
tools are not installed on the host, direct the benchmark to the pinned container
without putting credentials on its command line:

```text
MC_BENCHMARK_POSTGRES_CONTAINER="$(docker compose \
  -f docker-compose.pgvector.yml ps -q postgres-vector)"
```

Run the production-representative 1536-dimension gate with:

```text
npm run --silent benchmark:postgres-vector
```

CI uses the production-representative 1536 dimensions and gates both 10,000 and
100,000 rows through the production repository against actual identity-specific
HNSW plans and exact-reference recall.
See the [retrieval benchmark](../design/proposed/semantic-index-platform/retrieval-benchmark.md)
for methodology and thresholds.

The synthetic persisted-state fixtures validate SQLite forward upgrades and feed
the SQLite-to-PostgreSQL import rehearsal workflow below. They are synthetic only
and must never be replaced with production data.

## SQLite-to-PostgreSQL import rehearsal

Mission Control ships a narrow, operator-driven import command for the future
[#1155](https://github.com/rsocko/mission-control/issues/1155) maintenance
window. It never changes `MC_DATABASE_BACKEND`, deployment configuration,
Compose files, production data location, or activation state.

Dry-run a retained SQLite artifact without touching PostgreSQL:

```text
npm run db:import:postgres -- \
  --sqlite-source ./protected/mission-control.sqlite3 \
  --confirm-writers-stopped \
  --dry-run
```

Rehearse against a synthetic persisted-state fixture and a disposable,
clearly-named PostgreSQL database:

```text
MC_POSTGRES_SSL_MODE=disable npm run db:import:postgres -- \
  --fixture v1-0047-durable-sync-queue \
  --postgres-url ******localhost/mission_control_import_rehearsal \
  --rehearsal \
  --reset-disposable-rehearsal-target
```

Run the future maintenance-window import only after the web and sync-worker
writers are stopped, a protected SQLite backup exists, and the PostgreSQL target
is empty:

```text
npm run db:import:postgres -- \
  --sqlite-source /protected/mission-control.sqlite3 \
  --postgres-url ******database.example/mission_control \
  --confirm-writers-stopped
```

The command opens the SQLite source read-only with `query_only`, verifies the
current migrated schema hash set, rejects WAL/rollback-journal sidecars, runs
`PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and rejects active
`sync_jobs` for real sources. Synthetic fixture rehearsals may contain queued
worker rows so queue copy behavior can be exercised.

The target guard initializes an empty PostgreSQL schema from the baseline
migration or validates that every Mission Control table exists and is empty. It
rejects non-empty or unexpected targets. `--reset-disposable-rehearsal-target`
drops and recreates only a rehearsal target whose database name is explicitly
marked test/dev/local/sandbox/rehearsal/fixture and never a production-looking
host or database.

Rows are copied in PostgreSQL foreign-key order. The importer maps SQLite integer
booleans to PostgreSQL booleans, JSON text to `jsonb`, preserves text
timestamps/nulls, omits generated PostgreSQL columns, inserts explicit keys, and
repairs serial/identity sequences afterwards. SQLite FTS virtual tables and
PostgreSQL generated search-vector columns are classified as derived state and
not copied. `task_search_documents` and `notification_search_documents` are
rebuilt from authoritative `tasks` and `notifications` rows after import.

Output is line-oriented and secret-safe. Logs contain stage names and coarse
counts only. The final `summary` line is machine-readable JSON with command
metadata, redacted source/target identities, SQLite checksum/integrity/WAL
attestation, schema counts, copied domain counts, referential/domain invariants,
derived-state classifications, search rebuild counts, worker smoke hooks,
rollback criteria, observability hints, and
`verdict.ready_for_cutover_planning`. A successful import still reports
`activationChanged: false`; activation remains a separate gated step.

If the import fails, leave SQLite as the active backend, keep the retained SQLite
artifact and backup, and discard or drop the failed PostgreSQL target before
retrying. Rollback after a future activation is not automatic or dual-written;
it requires a write freeze and the preserved SQLite artifact from before the
activation gate.

## Cutover readiness evidence

PostgreSQL worker persistence parity is complete, but that does not activate
PostgreSQL in production or prove that existing SQLite data can be moved safely.
The production deployment remains SQLite-backed until the SQLite-to-PostgreSQL
import tooling tracked by
[#1681](https://github.com/rsocko/mission-control/issues/1681), the homelab
deployment work, and the explicit #1155 maintenance-window gate all complete.

The #1681 import rehearsal must leave a durable, redacted evidence package before
operators plan cutover. The exact command names and output paths are intentionally
left to #1681, but the package must cover:

| Evidence area | Required signal |
| --- | --- |
| Writer stop and quiescence | Web/API writers, sync worker, scheduled triage, reminders, notification writeback, finance workers, and durable queue consumers are stopped or fenced; there are no unexpected active sync jobs, connector operation leases, maintenance locks, or WAL/checkpoint risks. |
| Source backup | The final SQLite database, WAL/SHM handling, size, checksum, creation time, integrity check result, and protected retention location are recorded. |
| Target readiness | PostgreSQL target identity is redacted but environment-classified; the target is freshly provisioned or backed up before import; backup/restore tool versions are recorded when used. |
| Schema and migrations | SQLite source schema/migration markers are known; PostgreSQL has the expected `drizzle.__drizzle_migrations` baseline including `0000_handy_orphan`; optional vector state has `drizzle.__drizzle_vector_migrations`, pgvector `0.8.6`, and required indexes when semantic vector retrieval is enabled. |
| Counts and invariants | Coarse counts and referential checks cover tasks, projects, task associations, connector state, sync queues/logs/events/leases, notifications/actions/delivery/writebacks, triage state, AI/durable runs, GitHub identity/external identities, finance/Monarch/insight state, search/semantic tables, settings, runtime telemetry, and health snapshots. |
| Search rebuild | Task and notification search projections are rebuilt or verified, representative task/notification queries succeed through the PostgreSQL search adapter, and any required semantic/vector indexes are verified. |
| Queue and worker smoke | PostgreSQL web and worker start fail-closed with matching backend configuration; a queue claim/lease/finalize path succeeds; representative connector pull/push, dependency/list/project reconciliation, notification finalization, search warm-up, triage, reminders, and finance/Monarch scheduled flows are smoked as applicable. |
| Observability | Health endpoints, Prometheus metrics, Loki logs, PostgreSQL pool state, lock/slow-statement checks, migration state, backup freshness, and worker heartbeat/runtime telemetry show healthy PostgreSQL-backed operation without leaking secrets. |
| Rollback criteria | The evidence distinguishes pre-activation rollback, early post-activation rollback before meaningful PostgreSQL writes, and the blocked state after PostgreSQL-only writes unless a tested reverse-copy path exists. |
| Activation gate | The rehearsal ends with an explicit non-activating verdict, for example `ready_for_cutover_planning: true|false`; it never flips production configuration. |

Use the
[cutover readiness runbook input](./postgresql-cutover-readiness.md) as the
checklist for #1681 evidence review and later maintenance-window planning. Do
not run it against production until the importer shape, homelab change, backup
procedure, rollback window, and operator approval are all finalized.

## Backup, restore, and rollback

The PostgreSQL operator owns scheduled backups, retention, integrity checks, and
restore drills. Record the expected recovery point and recovery time objectives
for the deployment. Test a restore before treating PostgreSQL as the production
system of record.

Rollback requires a write freeze and a validated data-copy procedure. Changing
`MC_DATABASE_BACKEND` alone does not copy PostgreSQL changes back to SQLite.
Mission Control does not dual-write, and this feature does not provide a
zero-downtime cutover or automatic SQLite-to-PostgreSQL migration.

For the opt-in local profile, a reproducible logical restore rehearsal can use the
tools from the pinned database image. Supply credentials through the environment,
not command arguments, and write the dump only to an approved protected location:

```text
docker compose -f docker-compose.pgvector.yml \
  exec -T postgres-vector pg_dump -U postgres -d mission_control_vector_dev -Fc \
  > mission-control-vector.dump
docker compose -f docker-compose.pgvector.yml \
  exec -T postgres-vector createdb -U postgres mission_control_vector_restore_dev
docker compose -f docker-compose.pgvector.yml \
  exec -T postgres-vector pg_restore -U postgres \
  -d mission_control_vector_restore_dev --exit-on-error < mission-control-vector.dump
```

Verify the restored extension version, row counts, HNSW indexes, and a benchmark
query before deleting the rehearsal database and dump. The benchmark performs a full custom-format dump and fresh-database restore in CI,
installs pgvector before restore, and reruns required vector initialization to prove
the restored isolated migration stream is idempotent. Deployment operators must
still rehearse their own storage, encryption, retention, and recovery automation.

The homelab draft PR
[homelab-config#576](https://github.com/rsocko/homelab-config/pull/576)
remains on stock PostgreSQL and is intentionally unchanged. A separate follow-up
must adopt the pinned pgvector image, perform admin `CREATE EXTENSION`, add
health/version enforcement, and record a successful restore rehearsal before
indexed semantic retrieval is enabled there.

## Integration tests

Focused PostgreSQL tests use a dedicated disposable database:

```env
MC_TEST_POSTGRES_URL=postgres://mission_control_test:REDACTED@localhost/mission_control_test?sslmode=disable
```

Importer integration coverage is opt-in and uses a separately dedicated
disposable database because it may reset the `public` schema:

```env
MC_TEST_POSTGRES_IMPORT_URL=******localhost/mission_control_import_test?sslmode=disable
```

Never point `MC_TEST_POSTGRES_URL` or `MC_TEST_POSTGRES_IMPORT_URL` at
production. The test harness creates and removes isolated schemas and may apply
destructive migrations within them.
