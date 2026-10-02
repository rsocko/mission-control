# RyMessage canonical ActionV2 integration

## Decision

Mission Control consumes exactly the Companion contract shipped by
`rsocko/rymessage@01d1fb00e25c4e7aa0928a36ed403f3a4eea6599`:

- `GET /v2/integrations/action-feed?cursor=&limit=`
- `POST /v2/integrations/action-feed/mutations`

There is no ActionV1, notification-webhook, REST message, or source-SQLite
fallback. An upsert contains one authoritative
`projection: { action, taskMaterializations, creationIntents, managedTaskCommands, taskLifecycle }`;
a tombstone contains only the event envelope.

## Trust and configuration

The connector stores non-secret `mode: companion`, `companionBaseUrl`,
`trustedMissionControlOrigin`, `trustedTaskOrigins`, and the credential
environment-variable name. `trustedTaskOrigins` is the explicit allowlist for
provider task URLs (for example `https://github.com`); the Mission Control
origin is always included. The bearer defaults to
`RYMESSAGE_COMPANION_ACTION_FEED_TOKEN`.

All action, source-context, task-link, page, mutation, and receipt values are
validated before use. Rich Unicode is accepted; C0 controls and DEL are
rejected. Mutation operation IDs are content-addressed and durable. Reusing an
operation ID with different canonical bytes is an idempotency conflict.

## Persistence and recovery

Mission Control stores the validated V2 event envelope and projection, the
opaque next cursor, event receipts, and a durable outbound mutation queue.
Applying this cutover intentionally removes the five ActionV1 tables and wipes
RyMessage-derived notifications, semantic projections, tasks, V2 projections,
cursors, receipts, and pending mutations. Unrelated connector data survives.

The next cursor is persisted even when `complete` is true because the terminal
full-snapshot cursor is already the incremental cursor. HTTP 410
`cursor_invalid` or `cursor_expired`, a feed-identity change, or a revision
conflict invalidates local V2 state and starts one cursorless full recovery.
The physical page limit is 20 and synchronization is bounded.

## Notification and task projection

Notification bodies prefer `source.messageExcerpt`, then summary, details, and
classification reason. Sender and conversation context are retained. Category
defines semantic Type before action type; explicit priority defines urgency
before semantic or confidence fallbacks. Handled, dismissed, completed, and
tombstoned actions converge to resolved or deleted source state.

Provider-neutral task relations remain Companion-owned. Mission Control claims
and fulfills creation intents, attaches management only after immutable
provider identity is known, executes managed commands with revision fences, and
observes provider state through canonical task-link mutations.

## Coordinated rollout

1. Deploy `rsocko/rymessage#1214`.
2. Verify a cursorless V2 feed request returns the canonical projection.
3. Deploy Mission Control, apply migrations, and run a full cursorless sync.

Do not deploy Mission Control first: this is an intentionally coordinated
breaking cutover with no V1 compatibility path.
