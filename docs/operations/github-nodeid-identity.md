---
title: "GitHub NodeID Identity Operations"
status: accepted
created: 2026-08-16
last_reviewed: 2026-08-16
category: operations
related:
  - "[Stable GitHub Entity Identity](../design/active/github-entity-identity.md)"
  - "[GitHub Bulk Issue Transfer](github-bulk-issue-transfer.md)"
---

# GitHub NodeID Identity Operations

GitHub identity in Mission Control is **permanently NodeID-first**. There is no
identity mode to select, no comparison mode, and no rollback to locator
identity.

## Identity vs. locator

| Value | Role | Mutable? |
| --- | --- | --- |
| `external_entities.stable_id` (GitHub NodeID) | The only identity | No |
| `external_entity_bindings` | NodeID ↔ local row | Rebound only by tooling |
| `external_entity_locators` | Current and historical `owner/repo[#number]` | Yes |
| `tasks.source_id` | API-addressing and display locator | **Yes** — changes on rename/transfer |
| `source_lists.source_id` | Repository addressing locator | **Yes** |
| `task_linked_sources.source_id` | Linked-issue addressing locator | **Yes** |

Never treat a `source_id` as identity, and never repair identity by editing one.
Sync repoints locator columns automatically when GitHub reports a new locator
for the same NodeID.

## Fail-closed behaviour

Every GitHub surface — task upsert, source lists, dependencies, sub-issues,
linked sources, deletion detection, project associations, and write routing —
resolves through the NodeID binding. When evidence is missing, unverified,
colliding, inaccessible, or partial, the surface is **blocked**:

- the sync leaves the affected rows untouched and logs a bounded reason code;
- writes raise `GitHubWriteFenceError` before any GitHub mutation is dispatched;
- a local row that matches by locator but has no active binding is reported as
  `unbound_local_row` — it is never adopted and never duplicated.

The fix is always to restore NodeID evidence (re-run the backfill, resolve the
collision, or repoint/transfer the entity), never to fall back to a locator.

## Routine commands

```bash
node --conditions=react-server dist/github-identity-operator.cjs status --connector <id>
node --conditions=react-server dist/github-identity-operator.cjs write-outcome-inspect --connector <id>
node --conditions=react-server dist/github-identity-operator.cjs write-cycle-reconcile --connector <id> --cycle <cycle-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> --confirm-pre-dispatch
node --conditions=react-server dist/github-identity-operator.cjs write-outcome-resolve --connector <id> --cycle <cycle-id> --lease <lease-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key>
node --conditions=react-server dist/github-identity-operator.cjs transfer-reconcile --connector <id> --source-local-id <task-id> --successor-local-id <task-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key>
node --conditions=react-server dist/github-identity-operator.cjs exception-accept --connector <id> --local-id <task-id> --actor <actor> --reason <reason> --idempotency-key <key> [--confirm-authoritative-deletion]
```

`status` reports NodeID binding coverage, backfill dispositions, open
collisions, write cycles needing reconciliation, active/unknown write leases,
accepted terminal exceptions, and the read-only history of the one-way cutover.

The mode, rollback, comparison-evidence, and comparison-cycle commands were
removed with the permanent cutover and are rejected as unsupported.

## Migration `0105_github_nodeid_permanent_cutover`

This migration removes the cutover evidence tables
(`github_identity_comparison_records` ≈1.28 GiB and
`github_identity_sub_issue_population_members` ≈822 MiB, plus their
`github_identity_comparison_runs` parent) and rebuilds
`task_source_write_leases`, `github_identity_write_cycles`,
`github_identity_exception_events`, `github_identity_controls`,
`github_identity_migrations`, and `dependency_reconciliation_snapshots` without
any `comparison_run_id` or identity-mode columns.

Actual task hierarchy is untouched: parent/child relationships live in
`tasks.parent_id`, `tasks.depth`, and `tasks.metadata`.

### Historical exception proofs

`github_identity_exception_events` rows recorded before the cutover were proven
by a comparison run rather than by a proof type. Rather than relabel them as a
proof they never had, the migration stores the archival marker
`legacy_comparison_evidence`. Current code never writes that value; it exists so
the audit trail stays truthful. New accepts still record `stage1_inaccessible`
or `post_backfill_authoritative_deletion`.

### Operator steps (requires short web/worker downtime)

1. Take a database backup.
2. Stop every connector-capable process (web and sync worker). The rebuild drops
   and recreates operational tables and must not race a writer.
3. Reconcile quarantined or interrupted write cycles first with
   `write-cycle-reconcile` / `write-outcome-resolve`. This is optional — active,
   dispatched, and unknown leases, their frozen targets, and their proven
   outcome events are preserved verbatim — but reconciling first keeps the
   post-migration status clean.
4. Start the web process. The migration applies on the first database
   connection. Then start the worker.
5. Verify with `status --connector <id>`: `operationalState.activeWriteLeases`
   and `writeCycleReconciliation.unresolvedCount` should match what you recorded
   before the downtime.
6. Reclaim the freed pages during a maintenance window with a manual `VACUUM`.
   The migration deliberately does **not** VACUUM, because a multi-gigabyte
   rewrite inside startup would block the app and needs free disk equal to the
   database size.

### Restart safety

Every statement is re-runnable. Table rebuilds copy only columns that exist in
both the old and new shape, each swap (`DROP` + `RENAME`) is a single statement,
and index creation uses `IF NOT EXISTS`. If a statement fails, the repo's
migration runner leaves the migration unmarked and retries it on the next
startup.
