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

Task promotion and provider-neutral task links use the independent additive
ActionV2 surface:

- `GET /v2/integrations/action-feed`
- `POST /v2/integrations/action-feed/mutations`

V1 is frozen for compatibility. V2 does not change V1 routes, payloads,
cursors, receipts, UUID vectors, persisted rows, or `action_state_v1`.
Mission Control reads the unchanged `ActionV1` embedded in each V2 upsert and
handles task relations, creation intents, managed commands, and lifecycle
provenance as V2 sidecars.

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

## Notification projection

Every canonical action projects to one Mission Control notification. The
stable source identity is:

```text
rymessage:companion:${connectorId}:${actionId}
```

Lifecycle controls whether the notification is active, resolved, or deleted.
Priority and confidence only select presentation severity; they never filter an
action out. Tombstones delete the source projection. Notification persistence
contains portable action content and bounded presentation metadata only. Raw
provider identity, sender/contact data, conversation titles, message excerpts,
source URLs, classification reasoning, model names, extracted payloads, and
feedback bodies are excluded.

## User-initiated task promotion

Promotion is explicit in the first release. The notification's **Create task**
action opens a multi-row dialog backed by Mission Control's writable
destination discovery, so each row may target Mission Control local tasks,
GitHub, Microsoft To Do, or another writable adapter. A batch may contain up to
16 rows and partial success is retained for targeted retry.

Each row receives a durable UUID intent before provider delivery:

1. register the V2 creation intent in Companion;
2. claim it before one delivery attempt;
3. create the Mission Control task with the same UUID as its idempotency key;
4. deliver through the selected provider adapter; and
5. fulfill the intent with the immutable provider tuple, then attach Mission
   Control management in a separate principal-injected mutation.

Replays return the existing local task. Concurrent requests converge on the
same task ID, provider push leases fence delivery, and stable Companion
operation IDs make response-loss retries safe. A failed row does not replay
successful rows. An unavailable provider leaves the persisted intent
recoverable rather than synthesizing success.

The frozen V2 request envelope is:

```json
{
  "contractVersion": "2.0",
  "operationId": "<uuid>",
  "actionId": "<uuid>",
  "expectedRevision": 7,
  "mutation": {}
}
```

`creation-intent.register` contains only `intentId` and a provider-neutral
`draft` (`title`, optional `notes`, `dueAt`, `reminderAt`, and boolean
`priority`). Provider account and container identity are forbidden at
registration; destination selection remains a Mission Control concern.
Mutation receipts contain only `operationId`, `actionId`, `outcome`,
`revision`, and the applicable optional `relationId`, `intentId`, or
`commandId`.

Relation identity is RFC 4122 UUIDv5 under namespace
`60ed6d9d-c9d5-5fd6-9c7a-dbb312af3fb5`, using the UTF-8 RFC 8785/JCS JSON bytes
of:

```json
["actionId","providerId","providerAccountId","providerContainerId-or-empty","providerTaskId"]
```

No trimming, case folding, Unicode normalization, or alternate delimiters are
permitted. The canonical fixture
`["00000000-0000-4000-8000-000000000001","microsoft-todo","account","list","task"]`
produces `cc1ee9ad-ad34-5b29-957c-08fb19507768`.

## Linked-task lifecycle and managed edits

Companion derives canonical lifecycle atomically. Any nonterminal relation,
including blocked, unknown, unavailable, or link-broken, keeps the action
linked/in progress. Completed, cancelled, and provider-deleted relations are
terminal; only when all linked relations are terminal does Companion complete
the action and Mission Control resolve the notification. Manual **Mark
handled** queues the canonical lifecycle mutation and remains available for
early resolution. Manual handled/dismissed disposition is sticky; only
task-derived completion may reopen when a new active relation appears.
Explicit `materialization.unlink` removes the relation from lifecycle
aggregation without deleting the provider task. Mission Control retains no
implicit deletion-to-unlink shortcut.

Mission Control reports managed task observations from provider-authoritative
task state. V2 managed commands are claimed before execution. Remote commands
go through the selected Mission Control provider adapter and never fall back to
a direct RyMessage provider write. Unsupported fields fail with a bounded
symbolic code rather than being silently ignored.

## Companion setup

The connector stores only non-secret `mode: companion`, `companionBaseUrl`,
`trustedMissionControlOrigin`, and the credential environment-variable name.
The bearer defaults to `RYMESSAGE_COMPANION_ACTION_FEED_TOKEN` and must be
available to both the web runtime (connection tests and user promotion) and the
worker runtime (feed reconciliation and observations).

Stop Companion before principal provisioning, then run:

```text
node --enable-source-maps dist/companion/integrationAdmin.js provision \
  --manager-instance-id <stable-id> \
  --trusted-origin <exact-origin>
```

Capture the one-time credential directly into secret storage without logging
it. Trusted origins are exact HTTP(S) roots with no userinfo, path, query, or
fragment. Explicitly allowlisted private, loopback, and link-local HTTP origins
are supported for trusted homelab deployments.

## Portable persistence

SQLite and PostgreSQL preserve the frozen V1 tables and add the same four V2
sidecar entities:

| Entity | Purpose |
|---|---|
| Feed state | Opaque cursor, feed identity, and recovery state |
| Action projection | Sanitized V2 action/link state and monotonic revision |
| Ingress receipt | Stable event identity, content digest, aggregate revision, and outcome |
| Mutation outbox | Exact request, aggregate `expectedRevision`, lease, retry/dead-letter state, and receipt |

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

For each linked Microsoft To Do materialization without management, Mission
Control searches imported tasks by the exact immutable provider tuple:

```text
providerAccountId + providerContainerId + providerTaskId
```

An exact match emits `materialization.attach-manager` with the existing Mission
Control task ID and current snapshot; it never registers an intent or creates
a provider task. No match causes no task synthesis. A removed or inaccessible
provider task is not recreated.

When a linked task's provider status or version differs from the canonical
snapshot, reconciliation queues `materialization.observe`. Its operation ID and
payload are derived from stable provider state, so repeated reconciliations do
not echo or conflict. Each run classifies at most 5,000 relations using a
set-based PostgreSQL task lookup/update and queues at most 100 observation
candidates, rotating processed rows for eventual fairness.

## Mutation concurrency and delivery

Every caller mutation supplies a stable UUID operation ID, action ID, and
aggregate `expectedRevision`. Reusing an operation ID
with identical content returns the existing queue outcome; reuse with different
content is rejected. Companion performs the aggregate CAS and returns a durable
conflict receipt with its current revision.

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
