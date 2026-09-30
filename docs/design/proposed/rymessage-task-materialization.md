---
title: "RyMessage Companion Action Reconciliation"
status: implemented
created: 2026-08-19
last_reviewed: 2026-09-29
category: design
related:
  - "[Connectors Architecture](../../architecture/connectors.md)"
  - "[Task Sync Integration](../../architecture/task-sync-integration.md)"
tracking:
  github_issue: "#1524"
  companion_contract: "rsocko/rymessage#1090"
---

# RyMessage Companion Action Reconciliation

## Decision

Mission Control consumes the canonical Companion ActionV1 integration surface:

- `GET /v1/integrations/action-feed`
- `POST /v1/integrations/action-feed/mutations`

It does not register as a Companion device and does not use `/v1/sync/*`.
Companion is authoritative for portable action content, lifecycle, revisions,
and materialization relationships. Microsoft To Do remains authoritative for
provider task fields and execution. Mission Control imports the existing To Do
task first, then binds the canonical relation by exact immutable provider
identity. It never creates a task from an ActionV1 relation.

The older notification webhook remains a compatibility path. It is not part of
canonical ActionV1 reconciliation and does not gain mutation authority.

## Authority boundary

Mission Control may submit only:

- user edits to title, summary, details, action type, category, priority, due
  and reminder times, and disposition;
- action lifecycle transitions;
- correction feedback; and
- provider observations for materializations already present in the canonical
  action.

Mission Control cannot create unrelated actions or materialization links. It
cannot mutate source identity, extraction or confidence data, revisions,
routing, destination, provider identity tuples, or provider task fields.
Provider observations are generated only by reconciliation, never accepted
from callers.

The Companion bearer principal determines account scope. Mission Control does
not accept account selectors. The credential is read at runtime from the
configured environment variable, defaulting to
`RYMESSAGE_COMPANION_ACTION_FEED_TOKEN`; credentials are not persisted in
connector settings.

## Portable persistence

SQLite and PostgreSQL store the same five reconciliation entities:

| Entity | Purpose |
|---|---|
| Feed state | Opaque cursor, feed identity, recovery generation, and full-snapshot generation |
| Action projection | Sanitized portable ActionV1 state and monotonic revision |
| Materialization relation | Canonical provider tuple, local imported task binding, and surfaced relation state |
| Ingress receipt | Stable event identity, content digest, aggregate revision, and outcome |
| Mutation outbox | Stable operation identity, expected field revisions, lease, retry, and receipt |

All tables cascade from the connector configuration, so connector erasure
removes reconciliation state. They participate in ordinary database
backup/restore. No secret, raw provider response, raw source identity, sender
name, conversation title, message excerpt, source URL, classification reason,
model name, extracted payload, or feedback body is persisted.

## Feed and recovery semantics

Feed pages and cursor advancement commit in one database transaction. A fresh
read must begin with a `full` page. Multi-page full snapshots share a local
generation, and prior projections omitted from recovery are tombstoned only
after the final full page. Incremental pages apply explicit upserts and
tombstones. Requests use the canonical strict page size of 20.

Receipts are keyed by `(connectorId, eventId)`. Replaying the same event and
digest is a no-op; reusing an event ID with different content is a surfaced
conflict. Revisions never overwrite a newer projection.

A distinct event carrying different content at the current aggregate revision
is quarantined before any page effect or cursor advancement. Feed state keeps
the retained cursor plus a bounded `REVISION_CONFLICT` marker, and sync reports
`unavailable` until an explicit recovery-generation invalidation. The next
authoritative full snapshot may replace that same revision and clears the
quarantine only when the full snapshot completes.

An HTTP 410 cursor response or changed feed identity clears the cursor and feed
identity, increments the recovery generation, and permits one bounded restart
from a full snapshot. A second recovery failure is surfaced rather than
looped.

Tombstoned projections are retained up to 25,000 per connector. Incremental
overflow prunes the oldest tombstones and invalidates the cursor so a full
snapshot re-establishes a safe convergence watermark; a completed full
snapshot is itself a safe pruning watermark. Event receipts remain durable and
duplicate tombstones update one projection rather than growing the set.

## Relation reconciliation

For each non-deleted Microsoft To Do materialization, Mission Control searches
active imported tasks for the exact source identity:

```text
${providerListId}:${providerTaskId}
```

| Match result | Relation state |
|---|---|
| Zero, never linked | `pending-import` |
| Exactly one | `linked` |
| More than one | `conflict` with `AMBIGUOUS_PROVIDER_IDENTITY` |
| Zero after a prior link | `link-broken` |
| Canonical relation/action deleted | `deleted` |

No match causes no task synthesis. A removed or inaccessible provider task is
not recreated.

When a linked task's provider status or version differs from the canonical
snapshot, reconciliation queues `materialization.observe`. Its operation ID and
payload are derived from stable provider state, so repeated reconciliations do
not echo or conflict. Each run classifies at most 5,000 relations using a
set-based PostgreSQL task lookup/update and queues at most 100 observation
candidates, rotating processed rows for eventual fairness.

## Mutation concurrency and delivery

Every caller mutation supplies a stable UUID operation ID, aggregate base
revision, and expected revisions for touched fields. Reusing an operation ID
with identical content returns the existing queue outcome; reuse with different
content is rejected. Future aggregate or touched-field revisions are rejected
at enqueue and revalidated under the lease transaction. A stale aggregate may
rebase only when every touched field still has the exact expected revision.

At lease time:

- a stale aggregate with unchanged touched fields is rebased to the current
  aggregate revision;
- an overlapping field change becomes `FIELD_REVISION_CONFLICT`;
- missing or tombstoned actions become conflicts; and
- expired leases are reclaimed after a crash.

Leases contain at most 20 operations. Retryable failures use exponential
backoff capped at one hour and become dead letters after eight attempts.
Applied, duplicate, and stale-noop receipts settle the operation. Canonical
conflict receipts remain surfaced. A receipt settles only the lease with the
same operation ID and action ID; mismatched 2xx or 409 receipts are protocol
conflicts and never success-shaped.

The local route is deliberately narrow:

- `GET /api/connectors/{id}/rymessage-actions` returns bounded reconciliation
  status, including relation and canonical mutation conflict counts;
- `POST /api/connectors/{id}/rymessage-actions` accepts only trusted, bounded,
  exact mutation queue envelopes; and
- the route never accepts account scope or provider observations.

## Quotas

- 25,000 live projections per connector
- 25,000 retained tombstone projections per connector
- 200,000 retained ingress receipts per connector
- 10,000 pending, retrying, or leased outbound mutations
- 5,000 materializations classified and 100 observations considered per run
- 20 mutations per lease
- 1,250 feed pages per sync
- 24 KiB canonical aggregate and 32 KiB local mutation request bounds

These limits bound recovery, offline accumulation, and poison-input behavior
without widening the canonical Companion contract.
