---
title: GitHub Bulk Issue Transfer
sidebar_label: GitHub Bulk Issue Transfer
---

# GitHub bulk issue transfer

Use this operation only for a reviewed repository cutover. Its safe default
transfers only the issue node IDs in a reviewed allowlist through Mission
Control's stable-node-ID path while preserving Mission Control task IDs and
local metadata. Pull requests are never included. Repository-wide transfer is
available only through the explicit `--all-issues` option.

## Preconditions

1. Put the selected GitHub connector in stable-primary mode and complete its
   zero-disagreement soak.
2. Drain queued/running syncs, pending or failed writes, deletion candidates,
   unresolved write cycles, and identity collisions.
3. Create and integrity-check a fresh backup outside the active database path.
   On SQLite the CLI's `--backup` flag runs the built-in file verifier. On
   PostgreSQL the operator verifies their own dump out of band and supplies the
   same bounded attestation value through `--backup-attestation` (SHA-256 digest,
   byte size, modified and verified timestamps, `integrityCheck: "ok"`,
   `source: "external-preverified"`); this repository ships no PostgreSQL dump,
   restore, or deployment tooling, and the persistence layer never opens a
   backup file.
4. Verify that source and target repositories are under the same GitHub owner
   and both have stable source-list bindings in the connector.
5. Freeze connector configuration and task metadata until reconciliation
   completes.

## Preview

Preview is the default and performs no database or GitHub mutation:

Create and archive a reviewed JSON manifest:

```json
{
  "version": 1,
  "sourceRepository": "owner/source",
  "issueNodeIds": ["I_kwDOExample1", "I_kwDOExample2"]
}
```

```bash
npm run github:bulk-transfer -- preview \
  --connector <connector-id> \
  --source owner/source \
  --target owner/target \
  --allowlist /reviewed/owl-issues.json \
  --backup /backups/mission-control.db \
  --actor <operator>
```

For PostgreSQL, replace `--backup /backups/mission-control.db` with
`--backup-attestation /reviewed/mission-control-backup-attestation.json`. The
attestation contains only the opaque backup locator, lowercase SHA-256 digest,
positive size, modification and verification timestamps, `integrityCheck:
"ok"`, and `source: "external-preverified"`. Extra fields are rejected so
credentials or backup contents cannot be persisted accidentally.

Archive the complete JSON output. Confirm that `go` is true, open plus closed
counts equal the selected issue count, every selected issue has one stable task
binding, and there are no reasons. Unknown IDs, pull request IDs, and IDs from
another source repository fail closed as `approved_issue_node_id_not_in_source`.
The `planHash` commits to repository identities, the exact manifest SHA-256,
the normalized approved node ID set, backup digest, task IDs, issue node IDs,
and before-state metadata digests.

For a deliberately reviewed whole-repository transfer, replace `--allowlist`
with `--all-issues`. Omitting both options is an error.

API callers must make the same explicit choice by sending either:

```json
{
  "scope": {
    "mode": "reviewed-allowlist",
    "sourceRepository": "owner/source",
    "manifestSha256": "<lowercase-sha256>",
    "issueNodeIds": ["I_kwDOExample1", "I_kwDOExample2"]
  }
}
```

or `{ "scope": { "mode": "all-issues" } }`. Duplicate IDs and incomplete
scope objects are rejected before preview.

## Execute and monitor

Execute only the reviewed plan:

```bash
npm run github:bulk-transfer -- execute \
  --connector <connector-id> \
  --source owner/source \
  --target owner/target \
  --allowlist /reviewed/owl-issues.json \
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

## Backend support

Bulk transfer, repository repoint, native issue transfer, and historical
task-transfer reconciliation run through the backend-neutral Layer 3B
`recovery` persistence composition, so they behave identically on SQLite and
PostgreSQL. The composition is registered atomically: if it is absent or
partial for the selected backend, every entry point fails closed *before* any
GitHub HTTP call. Documenting support is not the same as activating a backend —
see the database scaling and migration strategy for cutover.

Every GitHub call, verification retry, and rate-limit backoff happens outside
database transactions. Each durable step (lock, apply, verify, rollback,
dispatch, complete, reconcile, succession) is a single short transaction that
re-checks operation phase, maintenance-lock ownership, connector activity, the
identity-mode revision, item state, task route, stable binding, and locator
revision before committing. Resume and reconcile are therefore idempotent, and
a repeated apply on an operation that already left `locked` is a no-op.

## Resume, abort, and incidents

Repeat `execute` (or use `resume`) with the same arguments, idempotency key, and
plan hash after a pre-dispatch interruption. For allowlisted runs, use the
exact same manifest bytes. Verified items are skipped.

If any item remains `transferring`, its GitHub mutation outcome is ambiguous.
The operation fails closed, leaves the connector disabled, and refuses replay
or abort. Find the transferred issue number at the target, then have Mission
Control verify its repository and issue node IDs and repair local routing:

```bash
npm run github:bulk-transfer -- reconcile \
  --run <run-id> --task <task-id> --target-number <number> \
  --actor <operator> --confirm reconcile
```

If GitHub assigned a successor node ID during the native transfer, the first
reconcile attempt fails closed with `explicit successor authorization is
required`. Independently verify the source node ID from the archived preview
and the successor node ID from the target issue, SHA-256 hash both raw node ID
strings, and repeat reconciliation with the reviewed authorization:

```bash
npm run github:bulk-transfer -- reconcile \
  --run <run-id> --task <task-id> --target-number <number> \
  --actor <operator> --confirm reconcile \
  --source-node-digest <source-node-id-sha256> \
  --successor-node-digest <successor-node-id-sha256> \
  --successor-reason '<reviewed reason>' \
  --successor-key <unique-idempotency-key>
```

All four successor options are required together. Archive the evidence and
command output; do not put raw node IDs into logs when digests are sufficient.

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
