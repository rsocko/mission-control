---
title: "Finance Attention Projection Repair"
status: accepted
created: 2026-08-22
last_reviewed: 2026-08-22
category: operations
related:
  - "[Connectors](../architecture/connectors.md)"
  - "[Connector Data and Privacy](../governance/connector-privacy.md)"
---

# Finance Attention Projection Repair

This recovery repairs the Mission Control projections created when
`attribution_not_configured` was incorrectly treated as a human-reviewable
Finance attribution exception. It does not call Tyrion, enable a connector,
change a finance transaction, or resolve/dismiss the authoritative
`finance_attribution_exceptions` row.

The scope is deliberately fixed to one connector and one reason code. A target
must also have the deterministic Finance attention identity and the exact
MC Finance attention producer metadata, `finance-attribution-review`
notification signature, and incident window from 2026-08-11T00:00:00Z up to
but not including the 2026-08-13T00:00:00Z cutover. Other Finance
notifications, post-cutover failures, and genuine ambiguity exceptions are
excluded. The endpoint returns only counts, stable codes, opaque run IDs, and a
SHA-256 scope digest.

Tyrion attribution is stateless strict v1 and has no attribution outbox. This
repair does not inspect Tyrion policy, automation jobs, or Finance Insight
occurrences, and it never translates a local notification dismissal into a
Tyrion policy suppression. It does not require or infer a fingerprint key
version. A later attribution recovery may send a null instrument fingerprint
when parity with Tyrion's persisted fingerprint-key sidecar cannot be proven;
that explicitly disables card-rule matching for that request rather than
guessing a fingerprint.

## Deployment requirement

Deploy migration `0113_finance_attention_repair` before invoking the endpoint.
It adds only `finance_attention_repair_audit` and two indexes; no data backfill,
Tyrion deployment, connector enablement, or planned downtime is required.
Normal startup migration handling applies it on the first database connection.

## Dry-run

Use the connector instance ID, not the display name. Authentication uses the
existing trusted Finance mutation boundary. Keep the API key in an environment
variable so it is not written into shell history.

```bash
curl --fail-with-body \
  -X POST "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance/attention-repair" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: tyrion-attribution-repair-dry-20260822-01" \
  -H "Content-Type: application/json" \
  --data '{"mode":"dry-run"}'
```

Record the returned `runId`, `targetDigest`, and counts. The incident baseline
is 4,632 occurrences/notifications, but operators must investigate any mismatch
rather than broadening the scope. The connector may remain disabled; disabled
state is reported as `connectorEnabled: false` and does not block repair.

## Apply

Apply requires the exact completed dry-run ID and confirmation string. If any
target state changed after dry-run, the endpoint returns
`repair_scope_changed` without mutation; run a new dry-run.
If a targeted push delivery is already in `sending`, apply returns
`repair_delivery_in_flight` without mutation. Let the delivery worker drain,
then run a new dry-run before retrying apply. This prevents repair from racing a
sender that may already have passed its suppression check.

```bash
curl --fail-with-body \
  -X POST "$MC_ORIGIN/api/connectors/$CONNECTOR_ID/finance/attention-repair" \
  -H "X-MC-API-Key: ${MC_API_KEY}" \
  -H "Idempotency-Key: tyrion-attribution-repair-apply-20260822-01" \
  -H "Content-Type: application/json" \
  --data "{\"mode\":\"apply\",\"dryRunId\":\"$DRY_RUN_ID\",\"confirmation\":\"repair-attribution-not-configured-projections\"}"
```

The apply transaction archives/resolves the affected notifications, clears
their actionable and primary-action state, removes only connector-created
notification actions, cancels coupled generated tasks, and removes coupled My
Day items. Pending or leased push deliveries are suppressed before they can be
claimed or retried; an in-flight delivery blocks the transaction instead. The
audit row commits in the same transaction and includes content-free delivery
counts. Repeating the same request with the same idempotency key returns the
original result.

The scope is capped at 10,000 authoritative exceptions. A larger scope fails
closed with `repair_scope_too_large`; do not bypass the bound or edit the
database directly.

## Verification and recovery

1. Replay the apply request with the same idempotency key and confirm
   `replayed: true`.
2. Run a new dry-run with a new idempotency key and confirm all counts are zero.
3. Confirm the Finance notification inbox no longer contains actionable
   `finance-attribution-review` projections for the connector.
4. Leave the authoritative exceptions in place. After Tyrion attribution is
   correctly configured, a normal connector sync can re-evaluate them and
   recreate only genuine human-review work. Do not enable card-rule attribution
   unless fingerprint-key parity is independently proven; use null fingerprints
   otherwise.

Stable operator errors are `forbidden`, `invalid_repair_request`,
`invalid_repair_idempotency_key`, `repair_confirmation_required`,
`repair_dry_run_not_found`, `repair_scope_changed`, `repair_delivery_in_flight`,
`repair_idempotency_conflict`, `repair_scope_too_large`,
`finance_connector_not_found`, `invalid_finance_connector_type`, and
`finance_attention_repair_failed`.
