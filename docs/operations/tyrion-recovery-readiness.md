---
title: "Tyrion Recovery and Finance Insight Readiness"
status: accepted
created: 2026-08-22
last_reviewed: 2026-08-22
category: operations
related:
  - "[Finance Attention Projection Repair](./finance-attention-repair.md)"
  - "[Connectors](../architecture/connectors.md)"
  - "[Connector Data and Privacy](../governance/connector-privacy.md)"
---

# Tyrion Recovery and Finance Insight Readiness

This runbook composes the repair delivered by PR #1563 with the scheduler and
Finance Insight controls delivered by its stacked readiness PR. Complete the
steps in order. Keep the Tyrion connector disabled and all notification,
presentation, action, and Finance Insight delivery gates off until the steps
that explicitly enable them. Metadata readiness calls query only local state
and do not contact Monarch or Tyrion. The explicitly invoked attribution
preview contacts Tyrion but does not persist attribution, notifications,
tasks, actions, or delivery work.

All operator mutations require the existing trusted Finance mutation boundary
and an `Idempotency-Key` of 16-160 safe characters. Responses and audit rows
contain only connector/generation IDs, stable codes, timestamps, and counts.
Never paste credentials, protected connector identity state, finance payloads,
or notification content into a request, log, or incident note.

## 1. Backup and immutable deployment

1. Stop if a verified database backup cannot be created and restored.
2. Record the current database path, artifact digest, connector instance ID,
   enabled state, schedules, delivery gates, and notification counts.
3. Deploy PR #1563 and this stacked PR as one immutable artifact. Web and worker
   must run the identical digest. Do not mix old and new worker/web revisions.
4. Confirm migrations `0113_finance_attention_repair`,
   `0114_tyrion_readiness`, and `0117_simplify_tyrion_identities` applied
   through normal startup. Migration `0117` invalidates cached Finance Insight
   publications and identity-dependent projection/backfill proofs so no legacy
   raw source identity can be replayed. A fresh disabled/quarantined sync must
   regenerate them before canary authorization. It also resets non-manual v1
   attribution, current exceptions, derived subjects, and occurrence summaries
   for re-evaluation under v2 while preserving authoritative manual decisions
   and audit history. Existing Finance Insight delivery cutover is rolled back
   fail closed and must be explicitly re-authorized against a regenerated v2
   publication.
5. Keep the connector disabled. Do not run a sync yet.

Stop on a migration error, digest mismatch, unexpected worker revision, or
backup verification failure. Restore the prior artifact and database backup
before retrying.

## 2. Configure application state and policy

In **Settings > Connectors > Tyrion**, set the exact uppercase ISO-4217
household currency. Currency is ordinary connector/application state in
`settings.householdCurrency`; it is not an environment variable or secret.
Legacy connectors without it report `needs-configuration` and unrelated edits
preserve that state.

Configure the service token through the existing credential mechanism. In
**Attribution policy readiness**, choose whether this connector follows
Tyrion's current policy or pins a specific positive policy version. Follow
current is the default: every preview or sync resolves the active policy once,
then sends that exact version as the CAS fence for every batch in the
operation. A configured pin bypasses discovery and retains strict mismatch
failure. The attribution `contractVersion: "2.0"` and mutable policy version
remain independent.

Deploy Tyrion's protected `GET /api/internal/v2/attribution/policy` discovery
endpoint before deploying this Mission Control version.

Keep `TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED=true`, while leaving:

- `TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED` off
- `TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED` off
- Finance Insight cutover delivery off

Mission Control v2 sends `accountRef` as the stable Tyrion Bridge Account DTO
`id` verbatim. It does not derive an `account-v1:` value from the connector
identity namespace. Tyrion validates the case-sensitive direct reference as
1-128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Direct account IDs are
private homelab contract data: they may cross the private attribution boundary,
but must not be logged or returned by readiness or preview responses. Mission
Control still derives opaque transaction source references for response
correlation. The persisted service token is authentication only.

Open **Attribution policy readiness** in the Tyrion connector editor, then use
the linked private Tyrion configuration UI to set each active account's Default
attribution to a specific child, Parent/shared, or Rule-based. Tyrion owns the
account catalog and editor; there is no reference copy/paste handoff. This is a
default rather than an absolute assignment. Evaluation preserves a
per-transaction manual decision first, then applies explicit merchant or other
rules, then the account default, then historical fallback when available.
Rule-based has no account default and unmatched transactions remain `no-match`.

Existing account and transaction projections already persist the Tyrion Bridge
account ID, so this change requires no schema migration or destructive reset.
The next disabled/quarantined sync and the no-write preview send those existing
IDs directly and re-evaluate prior automated attribution. Authoritative manual
decisions remain attached to each request and must be returned as manual
results. Do not enable the connector, release quarantine, or mutate live policy
as part of this compatibility transition.

After saving the Tyrion policy, run **Run no-write preview** in Settings, or
invoke the trusted endpoint below. Follow-current mode accepts the newly active
policy on the next operation without changing environment state or redeploying
Mission Control. Pinned mode continues to fail closed until the configured pin
matches:

```bash
curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance/attribution-readiness" \
  -H "X-MC-API-Key: ${MC_API_KEY}"
```

The preview reads at most 5,000 current local transactions, sends bounded
100-item-or-smaller batches to Tyrion, and returns aggregate status, reason,
method, confidence, and review-state counts only. Preview requests include the
same existing manual decisions as normal attribution, while preview responses
never expose transaction rows, direct account IDs, merchant names, or manual
decision payloads. It must report
`complete=true`, `truncated=false`, `ready=true`, and zero pending review before
another canary is authorized. A truncated or empty projection is never ready.
Any intentionally accepted residual review outcome requires a separate
documented release decision; do not infer acceptance from nonzero rule counts.

## 3. Metadata-only readiness

```bash
curl --fail-with-body \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}"
```

Before repair, record the returned stable blockers and metadata counts. Do not
continue if the response contains private finance content or key material.

Also inspect `insights.projection` in the connector health response. A usable
Finance Insight history projection reports `status=succeeded`,
`windowCount=37`, current `sourceAsOf`, non-null coverage and item count, and no
`lastErrorCode`. When capture reports `transaction_projection_unavailable`,
use the projection's stable `lastErrorCode` to repair the separate 37-month
history sync before canary authorization; a fresh 90-day operational sync does
not prove this projection succeeded.

The readiness, health, recovery, attribution-review, manual KID, and cutover
web paths use the same backend-selected Finance persistence composition as the
worker. PostgreSQL deployments fail closed if that complete composition is not
registered; they never read or write the SQLite compatibility database. These
metadata reads do not claim work or mutate leases. Cutover and rollback remain
single atomic database operations, and notification dispatcher wake occurs only
after a successful commit.

## 4. Repair PR #1563 projections

Follow [Finance Attention Projection Repair](./finance-attention-repair.md)
exactly:

1. Run the bounded dry-run.
2. Confirm the expected 4,632 target baseline; stop on any mismatch.
3. Apply using the exact dry-run ID and confirmation string.
4. Replay the apply with the same idempotency key and require
   `replayed: true`.
5. Run a new dry-run with a new key and require every target count to be zero.

Stop on `repair_scope_changed`, `repair_delivery_in_flight`, an unexpected
digest/count, or any nonzero verification replay. Do not broaden the scope or
edit projection tables directly.

## 5. Quarantine the scheduler

Quarantine is an application-supported per-connector fence. It atomically
rejects a running job, cancels queued work, removes the poll schedule, blocks
nightly/watchdog/recovery/API enqueue, and permits only one authorized canary
for the active quarantine generation.

```bash
curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: tyrion-quarantine-20260822-01" \
  -H "Content-Type: application/json" \
  --data '{"action":"quarantine-scheduler"}'
```

Require `status: quarantined`, then repeat metadata readiness and require
`scheduler.queued=0` and `scheduler.running=0`. If quarantine reports
`sync_quarantine_active_job`, let the current job finish; do not force a second
job or bypass the fence.

## 6. Run exactly one controlled canary

Require sync readiness `ready: true`, with notification/delivery/presentation/
actions gates false, before authorization.

```bash
curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: tyrion-canary-20260822-01" \
  -H "Content-Type: application/json" \
  --data '{"action":"authorize-canary"}'
```

The connector remains disabled. The authorized job is full, has one attempt,
and is the only job claimable for that quarantine generation. Replay the same
request and require the same `jobId` with `replayed: true`; a different key must
return `sync_canary_already_invoked`.

Poll metadata readiness until the canary is terminal. Require:

1. `canary.status=succeeded` and `notificationsAdded=0`.
2. Finance health reports healthy attribution.
3. All six Finance projections are fresh with expected bounded item counts.
4. Pre/post notification counts and delivery counts have no delta.
5. No queue, retry, presentation, action, or delivery work was produced.

Readiness and verification must not call Monarch. Only the explicitly
authorized canary performs provider sync.

## 7. Canary rollback or scheduler release

On failure, unexpected notification delta, degraded attribution, stale/partial
projection, policy mismatch, private error content, or worker/artifact change,
keep the connector disabled and rotate the quarantine generation:

```bash
curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: tyrion-canary-rollback-20260822-01" \
  -H "Content-Type: application/json" \
  --data '{"action":"rollback-canary"}'
```

Rollback cancels queued canary work or requests cancellation of a running
canary, retains quarantine, and creates a new generation only after active work
has drained. Investigate before authorizing another canary.

After successful verification, release quarantine:

```bash
curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: tyrion-release-20260822-01" \
  -H "Content-Type: application/json" \
  --data '{"action":"release-scheduler"}'
```

Because the connector is still disabled, release does not create a schedule.
Enable the connector separately in Settings only after release and confirm one
poll schedule is registered. Stop and quarantine again if more than one
scheduled or active job appears.

## 8. Stage Finance Insight cutover and delivery

Let a normal post-release sync complete with shadow ingestion on and all
delivery gates off. Copy the exact `publication.sourceGeneration` from:

```bash
curl --fail-with-body \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations?sourceGeneration=$SOURCE_GENERATION" \
  -H "X-MC-API-Key: ${MC_API_KEY}"
```

Require cutover readiness `ready: true`. It fails closed for a missing/disabled
or ambiguous connector, missing currency, disabled shadow ingestion, enabled
notification gates, missing completed publication/cache parity, or a stale
generation.

```bash
curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: finance-insight-cutover-20260822-01" \
  -H "Content-Type: application/json" \
  --data "{\"action\":\"enable-insight-cutover\",\"sourceGeneration\":\"$SOURCE_GENERATION\"}"
```

This invokes the existing atomic cutover primitive for exactly that connector
and generation. Replay with the same key and require `replayed: true`. Verify
the imported count, legacy expiration count, presentation/actions, and no
unexpected delivery. Enable immediate and monthly notification gates later,
one at a time, through a separate immutable deployment and observe each stage.

On any cutover or delivery anomaly, turn the notification gates off first and
run:

```bash
curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: finance-insight-rollback-20260822-01" \
  -H "Content-Type: application/json" \
  --data "{\"action\":\"rollback-insight-cutover\",\"sourceGeneration\":\"$SOURCE_GENERATION\"}"
```

Rollback accepts only the active exact generation, suppresses pending/sending
Finance Insight delivery atomically, and leaves legacy production disabled.
Restore the previous immutable artifact only after database and delivery state
are understood; restore the backup if migration/data rollback is required.
