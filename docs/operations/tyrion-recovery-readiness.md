---
title: "Tyrion Recovery and Finance Insight Readiness"
status: accepted
created: 2026-08-22
last_reviewed: 2026-10-10
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
   `0114_tyrion_readiness`, `0117_simplify_tyrion_identities`, and
   `0150_finance_clean_bootstrap` (PostgreSQL:
   `0028_finance_clean_bootstrap`) applied
   through normal startup. Migration `0117` invalidates cached Finance Insight
   publications and identity-dependent projection/backfill proofs so no legacy
   raw source identity can be replayed. A fresh disabled/quarantined sync
   regenerates only current operational projections and attribution before
   canary authorization. Historical projection is a separate, explicit
   post-activation operator action. Migration `0117` also resets non-manual v1
   attribution, current exceptions, derived subjects, and occurrence summaries
   for re-evaluation under v2 while preserving authoritative manual decisions
   and audit history. Existing Finance Insight delivery cutover is rolled back
   fail closed and must be explicitly re-authorized only after a later
   historical generation is captured.
5. Keep the connector disabled. Do not run a sync yet.

Stop on a migration error, digest mismatch, unexpected worker revision, or
backup verification failure. Restore the prior artifact and database backup
before retrying.

## 2. Configure Tyrion policy

In Tyrion, confirm the household currency is configured as an exact uppercase
ISO-4217 code. Tyrion is authoritative; Mission Control reads the value from the
protected attribution-policy response and does not store or edit a duplicate.
Missing or invalid Tyrion currency configuration fails readiness and publication
closed.

Configure the service token through the existing credential mechanism. In
**Attribution policy readiness**, choose whether this connector follows
Tyrion's current policy or pins a specific positive policy version. Follow
current is the default: every preview or sync resolves the active policy once,
then sends that exact version as the CAS fence for every batch in the
operation. A configured pin bypasses discovery and retains strict mismatch
failure. The attribution `contractVersion: "2.0"` and mutable policy version
remain independent.

In **Account review notifications**, confirm the connector defaults. A summary
qualifies when an account has at least 10 pending unmatched transactions or
one unmatched transaction whose absolute amount is at least 250 in the
configured household currency. Either default may be changed to a nonnegative
value; `0` disables that trigger. Optional account overrides inherit each blank
value from the connector default. Mission Control retains every unmatched item
in the manual review queue, but maintains at most one actionable notification
per qualifying account. That notification may include the highest qualifying
amount and merchant to make review actionable.

Deploy Tyrion's protected `GET /api/internal/v2/attribution/policy` discovery
endpoint before deploying this Mission Control version.

Keep `TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED=true`, while leaving:

- `TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED` off
- `TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED` off
- `TYRION_FINANCE_INSIGHTS_WEEKLY_SUMMARY_NOTIFICATIONS_ENABLED` off
- Finance Insight cutover delivery off

Keep `TYRION_FINANCE_AUTOMATION_ENABLED=false` during readiness. The automation
consumer shares the protected Finance Insights bearer boundary and requires
Tyrion's `TYRION_FINANCE_AUTOMATION_WRITE_ENABLED=true`. Enable both sides only
after the Finance source generation is complete and current. The optional
`TYRION_FINANCE_AUTOMATION_INTERVAL_MINUTES` controls the stable schedule
bucket and defaults to 15 minutes.

When enabled, each scheduled Finance domain sync sends normalized persisted
facts to `duplicateTransactions` and a bounded Bridge/sync observation to
`connectorHealth`. Mission Control applies Tyrion's embedded delivery snapshot
through the atomic Finance attention adapter before acknowledging the exact
delivery key and version. A crash before acknowledgement is safe: Tyrion
replays the delivery and Mission Control's stable source/activity identities
make the local apply idempotent. A stale acknowledgement conflicts and retries;
it never clears a newer outbox version.

Duplicate candidates remain notifications until the approved 24-hour
actionable threshold, then become one high-priority Finance task and ordinary
My Day candidate. Informational adjacent-date candidates never become tasks.
Connector-health attention becomes a task only after four hours. Fresh
authoritative Tyrion settlement resolves the notification and completes or
cancels related work; process restart, notification dismissal, and projection
success alone never imply recovery. Navigation is limited to the fixed
`/finance/review` and `/settings/connectors` routes, and metadata stores only
bounded evidence plus opaque signal/source references.

Operational logs contain only job and delivery counts or stable error codes.
Do not log automation requests, merchant names, amounts, transaction
references, delivery payloads, or Tyrion state paths. Rollback is to set
`TYRION_FINANCE_AUTOMATION_ENABLED=false`; existing attention remains
reconcilable when the gate is re-enabled, and Tyrion retains unacknowledged
deliveries. There is no Mission Control schema migration for this consumer.

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

The account-summary routing change also requires no schema migration. During
the normal Finance attention reconciliation cycle it archives or cancels old
per-transaction `no-match` notification/task projections, including the prior
backlog, without deleting or resolving pending attribution exceptions. It then
creates or updates one stable account summary only when an effective threshold
is met. Replays do not duplicate it; worsening activity marks it unread,
improvements update it without unread churn, and clearing both conditions
settles it. True conflicts and operational/degraded alerts remain independently
routable. Verify this reconciliation in the disabled/quarantined deployment;
do not edit projection tables directly.

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
decision payloads. It must report `complete=true`, `truncated=false`, and
`ready=true` before another canary is authorized. A truncated or empty
projection is never ready. Pending outcomes other than an explicitly accepted
Rule-based `no-match` backlog remain blocking. An accepted Rule-based backlog
may remain pending in Mission Control's manual attribution review queue and is
not a configuration defect; it does not create a notification or task per
transaction. Record that acceptance in the release decision rather than
inferring it from nonzero rule counts.

## 3. Metadata-only readiness

```bash
curl --fail-with-body \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}"
```

Before repair, record the returned stable blockers and metadata counts. Do not
continue if the response contains private finance content or key material.

`insights.projection` is not a current-window activation gate. After clean
bootstrap it may be absent, and a prior explicit history attempt may remain
failed with a stable `lastErrorCode`. Normal sync and canary must not invoke the
37-month history synchronizer or create history state, windows, facts, plans,
or proofs. `transaction_projection_unavailable` is therefore expected for
Finance Insight capture until an operator explicitly starts a later bounded
historical backfill; it does not block current operational attribution or
account-summary readiness. Any explicit history operation remains fail closed
and must satisfy its own count, digest, fence, and safety checks.

The readiness, health, recovery, attribution-review, manual KID, and cutover
web paths use the same backend-selected Finance persistence composition as the
worker. PostgreSQL deployments fail closed if that complete composition is not
registered; they never read or write the SQLite compatibility database. These
metadata reads do not claim work or mutate leases. Cutover and rollback remain
single atomic database operations, and notification dispatcher wake occurs only
after a successful commit.

## 4. Choose repair or clean-current-state recovery

Do not combine the legacy projection repair with a clean-current-state
bootstrap. Use [Finance Attention Projection Repair](./finance-attention-repair.md)
only when preserving and reconciling the old derived projection is an explicit
operator goal.

Use the clean bootstrap in section 6 when the approved recovery decision is to
abandon old Mission Control-derived Tyrion state and start from the current
contract. It does not mutate Monarch, Tyrion policy, connector configuration or
credentials, the stable Finance identity namespace, quarantine, or gate
settings. It has no option to delete manual attribution decisions. Any manual
decision count greater than zero is a hard stop requiring a later, separate
user decision.

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

## 6. Clean-current-state bootstrap

Only use this two-phase operation after scheduler quarantine is active. Both
phases require trusted Finance mutation authentication, the explicit connector
ID, an idempotency key, a disabled connector, active quarantine, zero
queued/running jobs, every downstream gate false, and the connector's exclusive
retention lease. Neither phase contacts Monarch or Tyrion. Neither phase
enqueues a sync or canary.

### 6.1 Aggregate-only inventory

```bash
DRY_RUN_KEY="tyrion-clean-inventory-$(date -u +%Y%m%dT%H%M%SZ)"

curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: $DRY_RUN_KEY" \
  -H "Content-Type: application/json" \
  --data '{"action":"inventory-clean-bootstrap"}'
```

The response is privacy-safe and aggregate-only. It separately counts manual
attribution decisions, automated attribution exceptions, Finance
notifications, Finance tasks, account projections, transaction projections,
history projections, backfill plans, backfill proofs, active delivery work,
and active action work. It never returns transaction IDs, direct account IDs,
merchant names, amounts, child identities, credentials, or source payloads.
Record the exact `dryRunId`, `scopeDigest`, and `confirmationToken`. Replaying
the same key must return those same values with `replayed=true`.

Stop if `manualAttributionDecisions` is nonzero. This release deliberately has
no force-delete-manual option. Also stop for active delivery/action work, an
unexpected count, private content, an enabled connector, missing quarantine,
active jobs, an enabled gate, or lease contention.

### 6.2 Exact confirmed apply

Use a new apply idempotency key and copy the three dry-run values exactly:

```bash
APPLY_KEY="tyrion-clean-apply-$(date -u +%Y%m%dT%H%M%SZ)"

curl --fail-with-body -X POST \
  "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance-operations" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: $APPLY_KEY" \
  -H "Content-Type: application/json" \
  --data "{
    \"action\":\"apply-clean-bootstrap\",
    \"dryRunId\":\"$DRY_RUN_ID\",
    \"scopeDigest\":\"$SCOPE_DIGEST\",
    \"confirmationToken\":\"$CONFIRMATION_TOKEN\"
  }"
```

Apply re-inventories under the exclusive lease and refuses
`finance_clean_bootstrap_scope_drift` if anything changed. It also refuses a
missing/mismatched confirmation, a reused key with different input, manual
decisions, in-flight delivery/action work, or any safety-fence change. There is
no partial success response: SQLite uses an immediate transaction and
PostgreSQL uses a transaction plus connector-scoped advisory lock.

The transaction retires only connector-scoped Mission Control-derived state:

- Automated attribution exceptions, audits/results, and local subject
  projections.
- Finance attention/insight notifications by resolving their source lifecycle,
  clearing actionability, and removing connector-created actions.
- Finance-derived tasks by cancelling open work with `not_planned` lifecycle
  semantics while preserving already terminal disposition.
- Account and transaction projections, transaction-history state/windows/facts,
  insight publications/delivery/cache/occurrences/cutover state, stale
  connection-attention state, attention delivery receipts, and obsolete
  attention-repair audits.
- Old transaction backfill plans and proofs.

It retains connector configuration and credentials, the stable Finance
identity namespace and dedupe identity inputs, external Tyrion policy,
quarantine, all gate settings, terminal notification/task records, and the
clean-bootstrap audit. It does not delete or modify Monarch data.

Replay the exact apply with the same apply key and require the same result with
`replayed=true`. Then run a new inventory with a new key. Require zero manual
decisions, automated exceptions, account/transaction/history projections,
backfill plans/proofs, active delivery work, and active action work. Finance
notifications and tasks remain as terminal lifecycle records and therefore may
still be counted; verify they are resolved/archived/dismissed or
done/cancelled, not actionable.

Re-read Finance operations metadata and require the connector still disabled
and quarantined, zero queued/running jobs, every gate unchanged and false, and
no canary. The state is now empty and ready for exactly one normal
current-window canary in section 7; apply never enqueues it.

Apply is intentionally destructive for derived projections and has no online
undo. Rollback means stop all operators, restore the verified pre-apply
database backup with the matching prior artifact, and re-run inventory before
any further mutation. Do not attempt table-level reconstruction from the audit.

After activation is complete, a later historical backfill may be run only as
an explicit operator action through the trusted Finance sync endpoint with an
`insightBackfill` request. It must use a new idempotency key and generation,
fetch again from Monarch, and evaluate through the current Tyrion contract. It
must not reuse old plan/proof IDs or resurrect any retired legacy attention
notification/task identity. Do not make this action part of a canary,
scheduler release, or recurring sync.

## 7. Run exactly one controlled canary

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

1. `canary.status=succeeded` and `notificationsAdded=0`. This remains mandatory
   even when an explicitly accepted Rule-based review backlog remains pending.
   Updates to an existing account summary do not increment this delta, but a
   newly created qualifying account summary does; investigate any nonzero
   value instead of treating the accepted backlog as an exemption.
2. Finance health reports healthy attribution.
3. All six Finance projections are fresh with expected bounded item counts.
4. Pre/post notification counts and delivery counts have no delta.
5. No queue, retry, presentation, action, or delivery work was produced.
6. History state remains unchanged from the clean bootstrap baseline; the
   canary created no history state, windows, facts, backfill plans, or proofs.

Readiness and verification must not call Monarch. Only the explicitly
authorized canary performs current-window provider sync; it must not request
the 37-month history projection.

## 8. Canary rollback or scheduler release

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

## 9. Stage Finance Insight cutover and delivery

Follow the [Finance Insight cutover runbook](./finance-insight-cutover.md) for
the supported authenticated CLI, exact prerequisites, and safe rollback.

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
