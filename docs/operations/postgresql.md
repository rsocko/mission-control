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

The synthetic persisted-state fixtures validate SQLite forward upgrades only.
They do not copy rows into PostgreSQL. Mission Control currently has no
executable SQLite-to-PostgreSQL copy/import command; implementing and rehearsing
that maintenance-window path is a hard dependency of the production cutover in
[#1155](https://github.com/rsocko/mission-control/issues/1155).

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

Never point `MC_TEST_POSTGRES_URL` at production. The test harness creates and
removes isolated schemas and may apply destructive migrations within them.
