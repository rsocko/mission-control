---
title: "Configurable Connector Push Notifications"
status: proposed
created: 2026-07-31
last_reviewed: 2026-07-31
category: design
related:
  - "[Notifications Redesign](notifications-redesign.md)"
  - "[Connector Settings](../active/connector-settings.md)"
  - "[Connectors Architecture](../../architecture/connectors.md)"
---

# Configurable Connector Push Notifications

## Summary

Mission Control should allow selected connector notifications to be delivered as
browser push notifications. Connectors declare the notification types they can
produce and safe delivery defaults; users decide which connector instances,
types, and attention levels may interrupt them.

The Notifications table remains the durable source of truth. Push is a
best-effort delivery channel evaluated after a notification is persisted:

```text
connector produces notification
  -> persist and deduplicate notification
  -> resolve user push policy
  -> apply global suppression and rate limits
  -> enqueue delivery
  -> send to registered subscriptions
  -> retain delivery outcome for diagnostics
```

The central rule is:

> Every connector push must reference a persisted Mission Control notification,
> but not every persisted notification should produce a push.

## Problem

Today, push delivery is limited to three system-scheduled triggers:

- Morning Summary
- Triage Nudge
- Carry-Forward Reminder

Those triggers write directly to the Notifications table and then call the Web
Push service. Connector-produced notifications are stored in the UI but do not
share that delivery path.

This creates several gaps:

1. A high-value connector event, such as an expired credential or requested PR
   review, cannot notify the user outside the app.
2. Delivery behavior cannot be configured by connector, notification type, or
   attention level.
3. Notification producers would have to duplicate DND, quiet-hours, privacy,
   deduplication, and push-send logic to add delivery independently.
4. Delivery attempts are not durably associated with the notification record,
   making support and diagnostics difficult.
5. The existing "Notification Scheduler" switch controls scheduled jobs, not a
   general push channel. Reusing it as a global push switch would be misleading.

## Goals

- Allow connector notifications to opt into Web Push eligibility.
- Support user rules per connector instance, notification type, and minimum
  attention level.
- Preserve the existing `NotificationLevel` vocabulary: `urgent`,
  `action_needed`, `heads_up`, `fyi`, and `digest`.
- Keep all notification producers behind one policy and delivery service.
- Make push delivery auditable without treating successful delivery as a
  requirement for storing the notification.
- Apply DND, quiet hours, privacy, deduplication, and rate limiting consistently.
- Keep defaults conservative and avoid enabling new interruptions silently.
- Support system-generated notification types through the same contract.

## Non-Goals

- Replacing the Notifications UI with the operating system notification center.
- Guaranteeing Web Push delivery or adding native APNs/FCM delivery in the first
  implementation.
- Letting connectors bypass user preferences or global suppression.
- Pushing task, sync, or webhook events that were not first normalized into a
  Mission Control notification.
- Adding arbitrary user-authored boolean rule expressions in the first release.
- Deferring every notification suppressed during quiet hours for later delivery.

## Design Decisions

### 1. Connectors declare capability; users grant permission

A connector owns the semantics of its notification types. It is best positioned
to explain that `pr_review_requested` is actionable and
`weekly_repository_digest` is informational.

The connector declaration may therefore provide:

- a stable type key matching the notification's `templateKey`
- a display label and description
- the expected default level
- whether the type is safe and meaningful to push
- a conservative recommended default
- a lock-screen preview classification
- an optional cooldown recommendation

These are product defaults, not authorization. A connector cannot turn on push
for itself or override a user's DND, quiet hours, threshold, or disabled rule.

### 2. Configuration is per connector instance

Rules attach to `connectorInstanceId`, not only `connectorType`. A user may want
urgent pushes from a work GitHub account while disabling them for a personal
account of the same connector type.

A connector-wide rule uses the reserved notification type `*`. An exact type
rule overrides the wildcard for that connector instance.

### 3. `templateKey` is the notification type identifier

The existing notification model already uses `templateKey` for stable,
producer-defined notification types. Introducing a second `eventType` field
would create overlapping identifiers.

Push-capable connector notifications must provide a non-empty `templateKey`.
Notifications without one remain visible in Mission Control but are ineligible
for push until the producer adopts a stable key.

Keys are namespaced by connector instance at policy lookup time, so common names
such as `auth_expired` do not collide across connectors.

### 4. Persist before evaluating delivery

The notification insert and delivery-intent insert occur in one database
transaction. Policy evaluation uses the normalized, persisted notification
rather than a connector-specific payload.

This gives the system a durable record even when:

- no browser is subscribed
- VAPID is not configured
- delivery fails
- DND or quiet hours suppresses push
- a rate limit blocks delivery

Suppression is not an error and does not remove or downgrade the notification in
the UI.

### 5. Delivery uses a durable outbox

Calling Web Push directly from connector sync makes successful sync depend on an
unreliable external delivery channel. Instead, eligible notifications create a
delivery event in an outbox table. A dispatcher claims pending events and sends
them after the notification transaction commits.

The dispatcher must use a compare-and-set claim (`pending` to `sending`) and a
lease timestamp so multiple app processes cannot send the same event
concurrently. Expired leases may be reclaimed.

Transient delivery failures use bounded exponential backoff. HTTP 404/410 still
removes expired subscriptions. Permanent configuration errors fail the event
without retry loops.

### 6. Global controls always win

Policy precedence, highest to lowest:

1. Push channel disabled or unavailable
2. Do Not Disturb
3. Quiet Hours
4. Exact connector-instance and notification-type rule
5. Connector-instance wildcard rule
6. Connector-declared recommended default
7. System default: off
8. Global and per-rule rate limits

DND and quiet hours suppress all levels, including urgent. The user explicitly
controls these global boundaries; connectors may not define exceptions.

Suppressed events are recorded as final and are not replayed later by default.
The durable Notifications UI is the catch-up surface. Deferred quiet-hours
delivery can be designed separately if users request it.

### 7. The scheduler is not the push master switch

The existing Notification Scheduler controls when Mission Control generates its
three scheduled reminders. Connector notifications arrive through connector
syncs and webhooks independently of that scheduler.

Settings should distinguish:

- **Push Delivery**: master Web Push channel switch
- **Scheduled Reminders**: starts or stops Morning Summary, Triage Nudge, and
  Carry-Forward generation
- **Do Not Disturb / Quiet Hours**: suppresses all push delivery

Stopping Scheduled Reminders must not disable eligible connector pushes.

## Connector Contract

Add an optional notification type catalog to the connector declaration:

```ts
type PushRecommendation = 'off' | 'urgent_only' | 'action_needed_or_higher';
type PushPreview = 'title_only' | 'title_and_body';
type NotificationSensitivity = 'standard' | 'sensitive';

interface ConnectorNotificationTypeDefinition {
  key: string;
  label: string;
  description: string;
  defaultLevel: NotificationLevel;
  pushEligible: boolean;
  pushRecommendation: PushRecommendation;
  sensitivity: NotificationSensitivity;
  defaultPreview: PushPreview;
  cooldownSeconds?: number;
}
```

The catalog should be available without connecting to the upstream service so
Settings can render it when credentials are expired. The preferred long-term
home is static connector factory metadata rather than data fetched during
`IConnector.initialize()`.

For the first migration, an optional readonly catalog on `IConnector` is
acceptable if the implementation also exposes factory-level metadata before the
Settings UI ships.

### Catalog validation

At registration time:

- keys must be non-empty lowercase snake case
- keys must be unique within a connector type
- `defaultLevel` must be a valid `NotificationLevel`
- `pushEligible: false` forces `pushRecommendation: off`
- sensitive types must default to `title_only`
- unknown connector-produced keys use the system default of push off

Custom REST and inbound webhook integrations cannot declare trusted push
eligibility from an incoming payload. Their type catalog must be configured
locally by the user.

## User Policy Model

### Rule behavior

Each rule has:

- enabled/disabled delivery
- a minimum attention level
- preview mode
- optional per-hour limit

The attention ordering uses the existing numeric rank:

| Level | Rank | Included by `action_needed` threshold |
|---|---:|:---:|
| `urgent` | 1 | Yes |
| `action_needed` | 2 | Yes |
| `heads_up` | 3 | No |
| `fyi` | 4 | No |
| `digest` | 5 | No |

A notification passes a threshold when its `levelRank` is less than or equal to
the configured threshold rank. Code should use one shared level-to-rank helper,
not duplicate string comparisons.

### Proposed table

```ts
notificationPushRules {
  id: string
  connectorInstanceId: string
  templateKey: string // exact key or "*"
  enabled: boolean
  minLevel: NotificationLevel
  preview: 'title_only' | 'title_and_body'
  maxPerHour: number | null
  createdAt: string
  updatedAt: string
}
```

Add a unique index on `(connectorInstanceId, templateKey)`.

Do not store connector defaults as copied rows. Missing rows mean "inherit the
current connector recommendation." This keeps corrected privacy defaults
effective for users who have not explicitly overridden them.

An explicit user override remains stable across connector upgrades. Settings
must offer "Reset to recommended" to delete the override.

## Delivery Event Model

Use a separate table because one notification may be evaluated or delivered
more than once, and delivery lifecycle does not belong in the notification
state machine.

```ts
notificationDeliveryEvents {
  id: string
  notificationId: string
  channel: 'web_push'
  dedupeKey: string
  status: 'pending' | 'sending' | 'sent' | 'partial' | 'failed' | 'suppressed'
  suppressionReason: string | null
  policySnapshot: json
  payloadSnapshot: json
  attemptCount: number
  nextAttemptAt: string | null
  leaseExpiresAt: string | null
  subscriptionsAttempted: number
  subscriptionsSent: number
  subscriptionsFailed: number
  createdAt: string
  sentAt: string | null
  lastError: string | null
}
```

`dedupeKey` is unique and generated from the notification and delivery
occurrence. Normal connector notifications use
`web_push:<notificationId>:initial`. A producer intentionally resurfacing the
same notification must supply a stable occurrence key.

The policy snapshot records the winning rule and global gates without storing
credentials or complete connector settings.

## Central Notification Service

All producers should converge on one service:

```ts
createNotification(input): Promise<NotificationItem>
```

Responsibilities:

1. Validate and normalize connector identity, type, level, and navigation.
2. Insert or deduplicate the notification.
3. Check that the connector catalog declares the notification type push-eligible.
4. Resolve the effective push policy for eligible types.
5. Insert a pending or suppressed delivery event for eligible types.
6. Commit the transaction.
7. Wake the dispatcher after commit.

Ineligible or unknown types create no delivery event. This avoids doubling
storage for connector notifications that cannot be pushed while preserving a
durable decision trail for every type that participates in push policy.

Connectors must not call `sendPushToAll()` directly. The low-level sender remains
internal to the dispatcher.

For bulk sync, the service should support a transaction-aware batch form to
avoid N+1 policy queries. Rules and connector catalogs may be cached for the
duration of one sync operation, with invalidation after settings updates.

## Push Payload and Privacy

The payload contains:

```ts
interface MissionControlPushPayload {
  notificationId: string;
  title: string;
  body?: string;
  tag: string;
  url: string;
}
```

Rules:

- `url` should normally be `/notifications?id=<notificationId>` or a validated
  internal navigation target.
- `title_only` omits body text entirely.
- Sensitive connector types cannot be changed to `title_and_body` unless the
  connector explicitly marks body previews safe.
- Secrets, access tokens, raw webhook payloads, full email bodies, finance
  amounts marked sensitive, and private message bodies must never enter push
  payloads.
- Payload snapshots retain only the final redacted payload used for delivery.
- Service-worker notification tags should collapse equivalent repeated events
  where appropriate without changing database deduplication.

## Rate Limiting and Deduplication

Apply both:

- a global safety cap per hour across all connector pushes
- an optional lower cap from the winning connector/type rule

When the cap is reached, record `status = suppressed` and
`suppressionReason = rate_limited`. Do not silently discard the decision.

Database uniqueness, not in-memory maps, must enforce delivery deduplication.
This is necessary across restarts and multiple app processes.

The existing Triage Nudge behavior may intentionally send again as the queue
grows. Each repeat must create a distinct delivery event linked to the same or a
new persisted notification; it must not generate an untraceable push.

## API Design

### Read effective configuration

`GET /api/push/rules`

Returns:

- global push and suppression settings
- connected connector instances that produce notifications
- connector type catalogs
- explicit user overrides
- resolved effective rules and their source (`user`, `connector`, or `system`)

### Update one rule

`PUT /api/push/rules`

```json
{
  "connectorInstanceId": "github-work",
  "templateKey": "pr_review_requested",
  "enabled": true,
  "minLevel": "action_needed",
  "preview": "title_only",
  "maxPerHour": 5
}
```

The route validates that:

- the connector instance exists and is not soft-deleted
- the type is declared and push-eligible
- the level and preview mode are valid
- the rate limit is within a bounded range

### Reset an override

`DELETE /api/push/rules?connectorInstanceId=...&templateKey=...`

Deletes the explicit row and restores the connector recommendation.

### Diagnostics

`GET /api/push/deliveries?notificationId=...`

This is an admin/support endpoint initially. It should not expose subscription
endpoints or encryption keys.

## Settings UX

### Notifications settings

Add a **Connector Push Rules** section below global push controls:

```text
Connector Push Rules

GitHub - Work                         Recommended defaults
  All GitHub notifications           Off
  Review requested                   Action Needed+   Title only
  CI workflow failed                 Urgent only      Title only
  Mention                            Off

Outlook Email - Work
  All email notifications            Off
  Direct action requested            Action Needed+   Title only
```

Each connector card:

- shows the connector instance name and icon
- provides a wildcard default
- lists only declared push-eligible types
- shows inherited versus overridden values
- supports "Reset to recommended"
- explains that notifications still appear in the UI when push is off

### Connector settings

The same rule component may appear in an individual connector's detail page.
Both entry points edit the same API and table; connector settings must not
introduce a second configuration model.

### Empty and unavailable states

- No push subscription: rules remain editable, with a prompt to enable browser
  notifications.
- VAPID unavailable: show channel unavailable; do not imply rules can deliver.
- No eligible types: omit the connector from this section.
- Soft-deleted connector: hide its rules from normal Settings, retain rows
  during the connector restore grace period, and purge them with permanent
  deletion.

## Scheduled Trigger Migration

Treat system reminders as a built-in producer with a static catalog:

| Type | Recommended default | Level |
|---|---|---|
| `morning_start_day` | On | `fyi` |
| `triage_nudge` | On | `heads_up` |
| `carry_forward` | On | `heads_up` |

The existing per-trigger enabled flags and schedule values continue to control
whether the notification is generated. The push policy controls only whether a
generated record is delivered externally.

This separates generation from delivery:

- trigger disabled: no notification record and no push
- trigger enabled, push rule disabled: notification record only
- trigger enabled, push rule enabled: notification record plus delivery event

## Initial Connector Rollout

Start with a narrow set of high-confidence types:

1. System scheduled reminders
2. GitHub review requests, direct mentions, and connector/auth failures
3. Home Assistant types already classified as urgent or action needed
4. Document Intelligence action-needed notifications

Outlook email, finance, and message connectors should remain default-off until
their catalogs and redaction behavior receive a privacy review.

## Observability

Track structured counts for:

- notifications evaluated
- policy outcomes by reason
- delivery events sent, partially sent, failed, retried, and suppressed
- expired subscriptions removed
- rate-limit suppressions by connector/type

Logs must use notification and delivery IDs, not payload bodies or subscription
endpoints.

The Settings status surface should distinguish:

- channel configured/unconfigured
- number of active subscriptions
- dispatcher healthy/stopped
- last successful delivery time

## Failure and Edge-Case Behavior

| Scenario | Result |
|---|---|
| Notification insert fails | No delivery event and no push |
| Delivery-event insert fails | Transaction rolls back notification insert |
| No subscriptions | Event completes as suppressed (`no_subscriptions`) |
| VAPID missing | Event completes as failed (`channel_unconfigured`) |
| One of several subscriptions fails | Event is `partial`; transient endpoints retry |
| Subscription returns 404/410 | Remove subscription; do not retry that endpoint |
| DND/quiet hours active | Record suppressed event; notification remains unread |
| Connector/type unknown or ineligible | No delivery event; notification remains in the UI |
| Connector deleted before dispatch | Suppress pending event (`connector_deleted`) |
| User changes rule after event queued | Dispatcher uses stored policy snapshot |
| Duplicate webhook/sync item | Existing notification and delivery dedupe prevent repeat |
| App restarts during send | Lease expiry allows safe reclaim; dedupe limits duplicates |

Web Push cannot provide exactly-once delivery. The design guarantees durable
intent and at-most-one active dispatch per event, while accepting that a process
failure after remote acceptance but before local acknowledgement may cause a
duplicate. Stable Web Push tags should minimize duplicate visible cards.

## Security Requirements

- Rules APIs require the same local authorization boundary as connector
  settings.
- Connector instances may declare only their own catalog; incoming payloads
  cannot mutate it.
- Validate all navigation targets and reject unsafe URL schemes.
- Never expose push subscription endpoints or keys through diagnostics APIs.
- Bound title/body lengths before constructing Web Push payloads.
- Store no connector credentials in policy or payload snapshots.
- Apply redaction before persistence in the delivery event, not only in the
  service worker.

## Testing Strategy

### Unit tests

- policy precedence and inheritance
- level threshold comparisons
- catalog validation
- preview redaction
- global and per-rule rate limits
- delivery dedupe keys
- retry classification and backoff

### Integration tests

- notification and delivery event commit atomically
- connector sync persists notifications when push is disabled
- DND and quiet hours produce suppressed delivery events
- dispatcher claims events safely under concurrent workers
- stale leases are reclaimed
- expired subscriptions are deleted
- soft-deleted connectors cannot create or deliver events

### API and UI tests

- rules reject unknown connector instances and invalid types
- exact type overrides wildcard rules
- reset restores inherited recommendation
- sensitive types cannot enable unsafe previews
- Settings renders inherited/overridden/unavailable states
- keyboard and screen-reader operation for all selectors and toggles

## Rollout Plan

### Phase 1: Contracts and persistence

- Add connector notification catalogs.
- Add push rule and delivery event schemas.
- Add catalog/rule validation and policy resolution.
- Keep connector defaults off.

### Phase 2: Central service and dispatcher

- Introduce the notification creation service and outbox dispatcher.
- Migrate scheduled triggers.
- Add diagnostics and delivery tests.

### Phase 3: User configuration

- Add rules API and Settings UI.
- Separate Push Delivery from Scheduled Reminders.
- Add inherited/override and unavailable states.

### Phase 4: Connector adoption

- Add reviewed catalogs connector by connector.
- Route every notification producer through the central service.
- Enable only conservative recommended defaults.

### Phase 5: Cleanup

- Remove direct producer calls to `sendPushToAll()`.
- Remove in-memory delivery deduplication.
- Document operations and troubleshooting.

## Acceptance Criteria

- A connector can declare stable push-eligible notification types without
  controlling user preferences.
- A user can configure push by connector instance, type, and minimum level.
- Global DND, quiet hours, and channel-disable settings suppress all connector
  push attempts.
- Every connector push is linked to a persisted notification and delivery event.
- Notification persistence succeeds independently of push availability.
- Delivery is asynchronous, retryable, rate-limited, privacy-safe, and
  diagnosable.
- Scheduled reminder generation remains independent from connector push
  delivery.
- Existing users receive no newly enabled connector pushes without an explicit
  opt-in or a separately approved migration decision.
