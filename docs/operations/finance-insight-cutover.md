---
title: Finance Insight cutover
sidebar_label: Finance Insight cutover
---

# Finance Insight cutover

Use this workflow to move exactly one enabled Tyrion Finance connector from
shadow ingestion to Finance Insight notification delivery. It uses the trusted
Finance operator API and the existing atomic cutover and rollback boundaries;
do not update `finance_insight_cutovers` directly.

## Prerequisites

Apply SQLite migrations through `0149` or PostgreSQL migrations through `0027`.
Deploy the canonical Tyrion Finance source and Finance attention settlement
stack before this change. Configure the existing Tyrion service token and
household currency, then set:

```text
TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED=true
TYRION_FINANCE_AUTOMATION_ENABLED=true
```

Keep immediate, monthly digest, and weekly summary notification gates off
during cutover. Confirm exactly one Finance connector is enabled. Set the
operator endpoint and trusted API key without placing the key on the command
line:

```bash
export MC_ORIGIN=https://mission-control.example
export MC_API_KEY='<trusted-operator-key>'
```

## Review and enable

Allow a normal sync to produce a completed publication and atomically apply its
shadow snapshot. Copy the exact generation identifier from the completed
publication evidence. Do not infer it from a connector name or reuse an older
generation.

```bash
npm run finance:insight-cutover -- readiness \
  --connector "$CONNECTOR_ID" \
  --source-generation "$SOURCE_GENERATION"
```

Require `readiness.ready: true`. The response contains only connector identity,
the latest completed publication generation and sequence, gate state, current
cutover state, and stable blocker codes. Stop for any blocker, including a
missing or disabled connector, zero or multiple enabled Finance connectors,
unavailable Tyrion configuration, disabled shadow ingestion, an enabled
notification gate, no completed publication, or a stale generation.

Enable the reviewed exact generation with a unique idempotency key:

```bash
npm run finance:insight-cutover -- enable \
  --connector "$CONNECTOR_ID" \
  --source-generation "$SOURCE_GENERATION" \
  --idempotency-key "$CUTOVER_IDEMPOTENCY_KEY"
```

The operation atomically expires legacy anomaly notifications, imports the
eligible Finance Insight lifecycle, and enables delivery. Repeating the exact
command returns `replayed: true`; reusing the key for another operation or
generation fails. Observe the imported and legacy-expired counts before
enabling notification-type gates one at a time.

## Safe rollback

Turn the notification-type gates off first. Roll back only the active exact
generation with a new idempotency key:

```bash
npm run finance:insight-cutover -- rollback \
  --connector "$CONNECTOR_ID" \
  --source-generation "$SOURCE_GENERATION" \
  --idempotency-key "$ROLLBACK_IDEMPOTENCY_KEY"
```

Rollback atomically disables the connector cutover and suppresses pending or
sending Finance Insight deliveries. Repeating the exact rollback is an
idempotent replay. It intentionally does not re-enable legacy anomaly
production. Set `TYRION_FINANCE_AUTOMATION_ENABLED=false` separately if Tyrion
Finance attention polling must also stop; unacknowledged Tyrion deliveries
remain replayable after that gate is restored.
