---
title: "Homelab Operational Digests"
status: proposed
created: 2026-08-21
last_reviewed: 2026-08-21
category: design
related:
  - "[Homelab Incident Notifications](homelab-incident-notifications.md)"
  - "[Notifications Redesign](notifications-redesign.md)"
  - "[Configurable Connector Push Notifications](configurable-connector-push-notifications.md)"
---

# Homelab Operational Digests

## Decision

Mission Control should aggregate low-interruption homelab outcomes into bounded
daily, weekly, and monthly digests. A digest is a derived summary, not a stream
of successful events and not an incident source of truth.

The existing `digest` notification level is the correct surface. Digests stay in
Inbox and Unread but do not increase the attention badge.

## Principles

- Aggregate from durable outcome facts, not ntfy history.
- Do not create one notification per successful backup, update, or maintenance
  job.
- Escalate a failure immediately through the incident path; do not wait for the
  next digest.
- Do not include an unresolved urgent or action-needed incident only as a
  reassuring success percentage.
- Keep every digest bounded and link to the authoritative dashboard or run
  history for detail.
- Default digest push delivery to off.

## Cadence

### Daily operations digest

Purpose: answer "Did routine operations work today?"

Include:

- backup jobs succeeded, failed, missed, and still running;
- scheduled n8n maintenance and reconciliation outcomes;
- endpoint availability as an aggregate, not one row per probe;
- newly opened and resolved incidents;
- services currently degraded at cutoff time; and
- stale telemetry or missing expected runs.

Example:

> Daily homelab operations: 10/10 backups succeeded, 6/6 scheduled workflows
> completed, 99.98% monitored availability, and no incidents remain open.

Create no daily digest when there are no configured facts or the source data is
too stale to support the summary. Never silently interpret missing data as
success.

### Weekly reliability digest

Purpose: surface trends and recurring maintenance work.

Include:

- availability by service group or site;
- incident count, time to resolution, and repeat offenders;
- backup success and restore-verification coverage;
- automation success rate and repeated retries;
- capacity trend exceptions, such as storage growth or sustained saturation;
- alert volume, inhibited duplicates, and noisy rules; and
- actions or tasks created from incidents and their completion state.

The weekly digest should emphasize changes from the prior week rather than a
large static inventory.

### Monthly health digest

Purpose: support capacity, resilience, and operational investment decisions.

Include:

- SLO or availability trend;
- incident frequency and duration trend;
- backup and restore confidence;
- storage, memory, and queue capacity trajectory;
- recurring manual interventions;
- alert-quality measures such as dismiss rate, duplicate rate, and
  action-to-noise ratio; and
- recommended configuration or maintenance work.

Monthly recommendations should be deterministic where possible. AI may summarize
already-bounded facts, but it must not invent health, severity, or causality.

## Data model

A digest generator consumes normalized facts:

```ts
interface HomelabOperationalFact {
  factId: string;
  occurredAt: string;
  kind:
    | 'job_succeeded'
    | 'job_failed'
    | 'job_missed'
    | 'incident_opened'
    | 'incident_resolved'
    | 'availability_window'
    | 'capacity_observation'
    | 'telemetry_stale';
  source: string;
  service?: string;
  site?: string;
  value?: number;
  unit?: string;
  status: 'success' | 'warning' | 'failure' | 'unknown';
  authoritativeUrl?: string;
}
```

Facts require stable IDs so retries and replay do not inflate totals. Retention
must cover the longest digest comparison window. Raw logs, traces, and
high-cardinality labels are not digest facts.

Fact bucketing and period identity use Mission Control's configured IANA
timezone. Daily boundaries follow local calendar dates, weekly boundaries use
ISO weeks beginning Monday, and monthly boundaries follow local calendar
months. The stored timezone and UTC coverage boundaries make daylight-saving
transitions and later configuration changes deterministic.

Digest identity is deterministic by cadence and period, for example:

- `homelab:daily:2026-08-21`
- `homelab:weekly:2026-W34`
- `homelab:monthly:2026-08`

Late facts update the same digest while its correction window is open. Material
corrections may mark it unread again; cosmetic changes do not.

## Presentation

Use the existing rich notification content:

- title and covered period;
- overall status as primary text;
- success/failed/missed/open counts as stats;
- a progress bar only for meaningful ratios, such as backup completion;
- up to three exceptions or trend callouts;
- links to Grafana, n8n executions, backup status, or the Homelab saved view.

Avoid green-only vanity summaries. `100% successful` is valuable only when the
denominator and coverage are clear, such as `10/10 expected backups`.

## Delivery defaults

| Digest | In-app | Push | Default timing |
|---|---|---|---|
| Daily operations | On | Off | End of local operational day |
| Weekly reliability | On | Off | Monday morning |
| Monthly health | On | Off | First day after month close |

Users may opt into a weekly push. Daily and monthly push should remain off unless
explicitly enabled. Failures represented by these digests continue to use their
immediate incident notification policy.

The connector catalog recommendation remains `off` for every digest. A weekly
push opt-in is represented by a user push rule whose minimum level includes
`digest`; it is not a connector-declared cadence exception.

## Success criteria

- Replayed outcome facts do not change aggregate totals.
- Missing expected data is reported as unknown or missed, never successful.
- Immediate failures appear before their next digest.
- Digests remain bounded and exclude raw telemetry.
- Each digest links to authoritative detail.
- Digest notifications do not increase the attention badge.
