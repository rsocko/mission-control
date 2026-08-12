---
title: GitHub Bulk Issue Transfer
sidebar_label: GitHub Bulk Issue Transfer
---

# GitHub bulk issue transfer

Use this operation only for a reviewed repository cutover. It transfers every
open and closed issue through Mission Control's stable-node-ID path while
preserving Mission Control task IDs and local metadata. Pull requests are never
included.

## Preconditions

1. Put the selected GitHub connector in stable-primary mode and complete its
   zero-disagreement soak.
2. Drain queued/running syncs, pending or failed writes, deletion candidates,
   unresolved write cycles, and identity collisions.
3. Create and integrity-check a fresh SQLite backup outside the active database
   path.
4. Verify that source and target repositories are under the same GitHub owner
   and both have stable source-list bindings in the connector.
5. Freeze connector configuration and task metadata until reconciliation
   completes.

## Preview

Preview is the default and performs no database or GitHub mutation:

```bash
npm run github:bulk-transfer -- preview \
  --connector <connector-id> \
  --source owner/source \
  --target owner/target \
  --backup /backups/mission-control.db \
  --actor <operator>
```

Archive the complete JSON output. Confirm that `go` is true, open plus closed
counts equal the source issue count, every issue has one stable task binding,
and there are no reasons. The `planHash` commits to repository identities,
backup digest, task IDs, issue node IDs, and before-state metadata digests.

## Execute and monitor

Execute only the reviewed plan:

```bash
npm run github:bulk-transfer -- execute \
  --connector <connector-id> \
  --source owner/source \
  --target owner/target \
  --backup /backups/mission-control.db \
  --actor <operator> \
  --idempotency-key <unique-key> \
  --plan-hash <preview-plan-hash> \
  --confirm 'owner/source=>owner/target'
```

The operation disables the connector before dispatch. Each issue is marked
`transferring`, transferred by stable node ID, verified at the target, then
checkpointed as `transferred`. On complete reconciliation, Mission Control
restores the connector's previous enabled state.

```bash
npm run github:bulk-transfer -- status --run <run-id>
```

Use `--concurrency 1` for production unless rehearsal evidence supports a
higher value. The maximum is eight.

## Resume, abort, and incidents

Repeat `execute` (or use `resume`) with the same arguments, idempotency key, and
plan hash after a pre-dispatch interruption. Verified items are skipped.

If any item remains `transferring`, its GitHub mutation outcome is ambiguous.
The operation fails closed, leaves the connector disabled, and refuses replay
or abort. Find the transferred issue number at the target, then have Mission
Control verify its repository and issue node IDs and repair local routing:

```bash
npm run github:bulk-transfer -- reconcile \
  --run <run-id> --task <task-id> --target-number <number> \
  --actor <operator> --confirm reconcile
```

Never retry or repair an ambiguous item directly through GitHub or SQL. After
all ambiguous items are reconciled, resume the original run.

Abort is allowed only when there is no ambiguous item:

```bash
npm run github:bulk-transfer -- abort \
  --run <run-id> --actor <operator> --confirm abort
```

Abort deliberately leaves the connector disabled. If a partial transfer must
be reversed, transfer verified items back through Mission Control in a separate
reviewed run, then restore the database backup only under the cutover rollback
procedure. Preserve the run, item, and event records for incident review.
