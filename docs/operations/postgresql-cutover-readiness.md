---
title: PostgreSQL cutover readiness
sidebar_label: PostgreSQL cutover readiness
---

# PostgreSQL cutover readiness

This is a runbook-input checklist for
[#1155](https://github.com/rsocko/mission-control/issues/1155), not a production
cutover runbook. It defines the evidence required after PostgreSQL parity has
landed and before a later maintenance-window activation can be planned. Do not
change production backend selection, deployment configuration, secrets, data, or
homelab Compose from this checklist.

The SQLite-to-PostgreSQL importer and rehearsal tooling tracked by
[#1681](https://github.com/rsocko/mission-control/issues/1681) is available as
`npm run db:import:postgres`. Its line-oriented, secret-safe `summary` output is
the machine-readable rehearsal artifact; retain that output with the application
revision and operator attestations described below. Import success is only an
input to later cutover planning and never changes activation state.

## Deliverables before cutover planning

1. A redacted importer/rehearsal evidence package with machine-readable summary
   output and enough human-readable context for operator review.
2. A final SQLite backup attestation and a PostgreSQL target backup or empty-target
   attestation.
3. Schema, migration, count, invariant, search, worker, queue, and observability
   results tied to the same application revision.
4. A rollback decision record that states whether rollback is still possible and
   what data would be lost after PostgreSQL accepts writes.
5. An explicit activation hold: evidence may say cutover planning is ready, but it
   must not activate PostgreSQL or edit deployment configuration.

## Preflight checklist

- Confirm the deployed code includes PostgreSQL worker parity from PR #1716 /
  merge commit `9478c0643e2f7bc05e0e09ee6e8258a40ae19ac0`.
- Confirm production is still SQLite-backed before rehearsal and that both web and
  worker would receive the same backend selection only during a later activation.
- Confirm #1681 importer/rehearsal tooling is being run against approved rehearsal
  targets unless this is the separately approved final maintenance window.
- Confirm source and target identifiers are recorded without printing database
  credentials, secret values, or full production connection strings.
- Confirm the app revision, importer revision, source SQLite schema marker, and
  target PostgreSQL migration marker are captured together.

## Writer stop and quiescence evidence

The final import must be taken from a stable SQLite source. The evidence package
must record:

- The timestamp when write freeze began and the timestamp of the final SQLite
  source read.
- Web/API writers, sync worker, scheduled triage, task reminders, notification
  writeback, finance/Monarch worker flows, and durable queue consumers are stopped
  or fenced.
- No unexpected active `sync_jobs`, connector operation leases, connector
  maintenance locks, or long-running retrying work exists.
- Any queued/retrying/cancelled work intentionally carried into PostgreSQL is
  listed with its expected post-cutover behavior.
- SQLite integrity and WAL/checkpoint state do not invalidate the backup. If a WAL
  or SHM file is required for consistency, its handling is recorded.

## Backup and restore evidence

The source SQLite rollback artifact must include:

- File identity or protected storage location, size, checksum, creation time, and
  integrity check result.
- WAL/SHM handling and whether the backup was produced from an idle window.
- Retention owner and deletion condition.

The PostgreSQL target evidence must include:

- Redacted target identity, environment classification, PostgreSQL version, and
  role used by the application.
- A pre-import logical dump, restore rehearsal, or explicit fresh-empty-target
  attestation.
- Backup/restore tool versions when `pg_dump` or `pg_restore` are part of the
  evidence.

Rollback is not just changing `MC_DATABASE_BACKEND`. Mission Control does not
dual-write, and PostgreSQL changes are not copied back to SQLite automatically.

## Schema and migration evidence

Fail rehearsal if source or target schema state is unknown. The minimum evidence
is:

- SQLite source application/schema migration marker, SQLite version, foreign-key
  and integrity-check results, and application revision.
- PostgreSQL initialization success with `MC_DATABASE_BACKEND=postgres`, plus the
  `drizzle.__drizzle_migrations` state containing the expected `0000_handy_orphan`
  baseline.
- Optional vector state, when enabled: pgvector extension version `0.8.6`,
  `drizzle.__drizzle_vector_migrations` containing `0000_semantic_vector_ann`, and
  required vector indexes.
- Confirmation that the target did not contain unexpected application rows before
  import unless the rehearsal intentionally validates an idempotent re-run.

## Count and invariant evidence

Counts should be coarse and domain-oriented; full proof-grade reconciliation is
not required for #1155, but unexplained losses are blockers. Capture source and
target counts for:

- Tasks, task dependencies, task tags, task projects, schedules, field state,
  focus/My Day/weekly planning state, attachments, linked sources, and deletion
  candidates.
- Hub projects, phases, project items, tags, source lists, connector configs,
  connector sync controls, connector maintenance locks, operation leases, sync
  jobs, sync events, sync logs, and sync runs.
- Notifications, notification actions, delivery events, push rules, writeback
  jobs, and notification search documents.
- Triage items, triage sync state, document intelligence import state, GitHub
  stars, Reddit, YouTube, and other enabled source-specific state.
- External identities, GitHub identity controls, write fences, dependency
  reconciliation snapshots/items/edges/candidates, project reconciliation state,
  repository transfer/repoint state, and recovery tables.
- Finance, Monarch, insight generation/evaluation/projection, attention,
  notification lifecycle, and recovery state.
- AI/durable run state, agent dispatch state, settings, runtime telemetry, health
  snapshots, semantic documents/vectors/intents/runs, and vector ANN tables when
  enabled.

Referential checks must cover orphan task associations, task dependencies,
project phase items, task and notification search documents, notification delivery
events, linked source/entity bindings, sync job events, semantic
document/vector/intent rows, and connector-owned child rows. Any omitted table or
derived/cache state must be classified as accepted loss or a blocker.

## Search rebuild evidence

The import path must either rebuild or explicitly verify PostgreSQL search
projections:

- `task_search_documents` aligns with imported searchable tasks.
- `notification_search_documents` aligns with imported searchable notifications.
- Representative searches find imported task title/body/source-list tokens and
  notification title/body tokens through the PostgreSQL search adapter.
- Post-sync search warm-up succeeds without touching SQLite.
- If semantic/vector retrieval is required, semantic identity, document, vector,
  pgvector migration, HNSW/index readiness, and representative recall/exact-match
  checks pass.

## Queue, worker, and scheduled-flow smoke evidence

Use disposable PostgreSQL environments for rehearsal smoke checks. The evidence
must show:

- Web and worker start with PostgreSQL selected, fail closed on PostgreSQL
  initialization errors, and use matching backend URL/TLS/pool settings.
- A sync job can be enqueued, claimed, leased, finalized, and observed in
  PostgreSQL `sync_jobs` and `sync_job_events`.
- A representative connector pull/read path and push/write-through path succeed
  when the connector is enabled for those operations.
- Dependency, list, project, GitHub identity, and notification finalization paths
  run through PostgreSQL repositories.
- Scheduled triage import, reminder dispatch, finance/Monarch recovery, and
  finance worker flows are smoked when those workflows are enabled in production.
- Search indexing and warm-up execute through PostgreSQL after representative
  worker activity.

Existing PostgreSQL tests that map to these areas include:

| Area | Existing coverage |
| --- | --- |
| Backend selection and no SQLite fallback | `tests/sync/postgres-backend-selection.test.ts` |
| Generic connector support | `tests/sync/postgres-execution-support.test.ts` |
| Core repositories | `tests/db/postgres-core-repositories.integration.test.ts` |
| Schema and transactions | `tests/db/postgres-schema.integration.test.ts` |
| Search projections | `tests/db/postgres-search-repository.integration.test.ts` |
| GitHub worker execution | `tests/db/postgres-github-worker-execution.integration.test.ts` |
| Finance worker execution | `tests/db/postgres-finance-worker-execution.integration.test.ts` |
| Triage scheduler | `tests/db/postgres-triage-scheduler-smoke.integration.test.ts` |
| Health snapshots | `tests/db/postgres-health-snapshot-data.integration.test.ts` |
| Runtime telemetry | `tests/telemetry/postgres-runtime-telemetry-selection.test.ts` |

These tests support parity confidence, but #1681 still needs production-data
rehearsal evidence. Synthetic tests alone are not cutover evidence.

## Observability evidence

Before activation planning, record the operator checks that will be used during
the maintenance window:

- Health endpoints report PostgreSQL readiness and do not expose driver secrets in
  error output.
- Prometheus metrics and Loki logs show web and worker started against PostgreSQL,
  pool saturation is not degraded, worker heartbeat/runtime telemetry is fresh,
  and there are no repeated migration, lease, queue, search, or connector errors.
- PostgreSQL-side checks cover active connection count, waiting clients, slow
  statements, lock waits, database size, migration table state, and backup
  freshness.
- SQLite-specific busy-timeout and WAL signals remain relevant only to the
  preserved source/rollback artifact after activation; they are not proof of
  healthy PostgreSQL operation.

## Rollback criteria

- **Before activation:** keep SQLite selected, preserve the SQLite artifact and
  evidence, and discard or rebuild the PostgreSQL target.
- **After activation but before meaningful PostgreSQL writes:** stop services,
  reselect the preserved SQLite file, restart, and smoke app/worker health.
- **After meaningful PostgreSQL writes:** rollback is blocked unless a tested
  reverse-copy or compensation path exists. Document the accepted data loss or do
  not activate.

Rollback must be selected if backup attestation, schema/migration checks,
row-count/invariant checks, search rebuild, worker/queue smoke, observability, or
operator approval fails.

## Activation gate

Importer/rehearsal tooling should end with an explicit non-activating verdict such
as:

```json
{
  "ready_for_cutover_planning": false,
  "blockers": ["example-placeholder-until-1681-lands"]
}
```

Only a later operator-approved maintenance-window runbook may switch production to
PostgreSQL. That runbook should require final backup retention, accepted
invariant/search/worker evidence, known rollback status, homelab configuration
readiness, and explicit human activation approval.

## Rehearsal command reference

Use the synthetic fixture command in
[`postgresql.md`](./postgresql.md#sqlite-to-postgresql-import-rehearsal) for
disposable rehearsals. Use `--dry-run` for source-only validation, and reserve a
non-rehearsal `--sqlite-source` import for a separately approved maintenance
window with confirmed writer shutdown. The importer prints the redacted evidence
package as its final `summary` line; capture it through the operator's approved
logging or artifact mechanism rather than adding environment-specific output
paths to the repository.
