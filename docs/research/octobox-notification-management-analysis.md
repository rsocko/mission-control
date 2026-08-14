---
title: "Octobox Notification Management Analysis"
status: research
created: 2026-08-06
last_reviewed: 2026-08-06
category: research
source_repository: "octobox/octobox"
source_revision: "7ce316b6577e36c7c6fd0650ab35e221ce8960e5"
related:
  - "[Notifications Redesign](../design/proposed/notifications-redesign.md)"
  - "[Configurable Connector Push Notifications](../design/proposed/configurable-connector-push-notifications.md)"
  - "[Connector Expansion Review](../design/active/connector-expansion-review.md)"
---

# Octobox Notification Management Analysis

## Executive summary

[Octobox](https://github.com/octobox/octobox) is an inbox and triage layer over GitHub
notifications. Its most valuable idea for Mission Control is not a particular screen or
framework. It is the separation of two questions:

1. **Have I seen this?** (`unread`)
2. **Does this still need to occupy my inbox?** (`archived` / handled)

Octobox lets a notification be read but still in the inbox, or handled while technically
unread. Archiving removes it from the inbox and all attention counts immediately. If
GitHub reports later activity on the same thread, Octobox reopens it by clearing the
archive flag. That is a better model for an attention system than treating "read" as
"done."

Mission Control already has a more extensible notification schema, richer action model,
push-policy layer, and source reconciliation framework. However, its notification
workflow currently uses one mutually exclusive `state` value for unread, read,
dismissed, resolved, or archived. Its GitHub connector also does not write local read or
dismiss actions back to GitHub, ignores GitHub's initial read state during ingestion, and
does not update or reopen an existing notification when a known GitHub thread receives
new activity.

The highest-value direction is therefore:

- adopt an independent **attention state** and **workflow disposition**;
- make **handled** the normal inbox-clearing action and reserve **dismissed** for
  intentionally irrelevant items;
- add a durable GitHub action outbox for mark-read, mark-done, and subscription changes;
- reopen handled notifications only when the upstream activity version advances;
- keep Mission Control's stronger reconciliation and push-policy architecture;
- add saved, URL-addressable views and filter-scoped bulk actions;
- do not copy Octobox's capped newest-first sync, swallowed failures, coarse token model,
  or optional webhook verification.

## Implementation tracking

The recommendations are tracked by:

- [Epic #2338](https://github.com/rsocko/mission-control/issues/2338) for sequencing,
  shared invariants, and overlap with existing notification work;
- [Issue #2337](https://github.com/rsocko/mission-control/issues/2337) for independent
  attention, disposition, source lifecycle, and activity-driven reopening;
- [Issue #2336](https://github.com/rsocko/mission-control/issues/2336) for lifecycle-correct
  GitHub ingestion, polling, and durable upstream actions;
- [Issue #2335](https://github.com/rsocko/mission-control/issues/2335) for saved views,
  filter-scoped bulk processing, and accessible keyboard triage.

Existing issues remain the source of truth for shared bulk writeback infrastructure
([#2192](https://github.com/rsocko/mission-control/issues/2192)), promotion and source
resolution ([#864](https://github.com/rsocko/mission-control/issues/864) and
[#866](https://github.com/rsocko/mission-control/issues/866)), event-driven update
research ([#898](https://github.com/rsocko/mission-control/issues/898)), and
evidence-driven grouping ([#697](https://github.com/rsocko/mission-control/issues/697)).

## Scope and evidence

This review covers Octobox code, schema, migrations, tests, OpenAPI description, README,
installation guide, and roadmap at commit
[`7ce316b6577e36c7c6fd0650ab35e221ce8960e5`](https://github.com/octobox/octobox/tree/7ce316b6577e36c7c6fd0650ab35e221ce8960e5).
It also compares those findings with Mission Control's notification implementation as of
2026-08-06.

The review is architectural and product-focused. It is not a dependency or penetration
test.

## 1. How Octobox tames GitHub notifications

### 1.1 GitHub remains the source of delivery state

Octobox polls GitHub's user-scoped `GET /notifications` API. OAuth defaults to the
`notifications` scope, with optional broader scopes or a PAT for richer data
([configuration](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/lib/octobox/configurator.rb#L33-L39),
[token selection](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/user.rb#L94-L117)).
A GitHub App supplies repository and subject enrichment but cannot replace per-user
notification polling.

`DownloadService` captures a timestamp before network work, performs an incremental
download and a read-state reconciliation pass, then advances `last_synced_at` only after
both complete
([implementation](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/services/download_service.rb#L24-L85)).
Capturing the watermark before I/O is correct: changes arriving during the request are
eligible for the next run.

Rows are idempotent through a unique `(user_id, github_id)` constraint
([schema](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/db/schema.rb#L64-L88)).
Octobox stores enough denormalized repository, subject, reason, and state data to support
fast triage without loading every GitHub subject on every page.

### 1.2 Delivery state and work state are independent

The key fields are:

| Concern | Octobox field | Meaning |
|---|---|---|
| Delivery | `unread` | GitHub/user has not read the thread |
| Work disposition | `archived` | User has handled and removed the thread from the inbox |
| Importance | `starred` | Local bookmark independent of inbox state |
| Suppression | `muted_at` | A mute was requested for the GitHub thread |
| Activity version | `updated_at` | GitHub thread activity timestamp used to detect reopening |

The inbox is simply notifications where `archived != true`
([inclusive scopes](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/lib/octobox/notifications/inclusive_scope.rb#L7-L14)).
The attention count adds `unread=true` to that inbox scope
([controller concern](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/controllers/concerns/notifications_concern.rb#L38-L40)).
Consequently:

- opening a notification can mark it read without removing it from the inbox;
- archiving removes it from the inbox and badge even if it remains unread;
- starred is not overloaded to mean pending;
- filters can address each concern explicitly.

### 1.3 "Handled" disappears locally and upstream

Archiving:

1. sets local `archived=true` immediately;
2. removes the row from default inbox queries and unread counts;
3. asynchronously calls GitHub's `DELETE /notifications/threads/{id}` endpoint.

Despite the HTTP verb, GitHub defines that operation as **mark thread done**, not delete.
See Octobox's
[`Notification#archive`](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/notification.rb#L79-L98)
and GitHub's
[notifications REST documentation](https://docs.github.com/en/rest/activity/notifications).

This local-first behavior makes the UI responsive. The default scope and count contract
ensures that a handled notification no longer appears in the inbox, sidebar count,
browser title, or favicon badge.

### 1.4 New upstream activity reopens handled work

When the same GitHub thread is fetched again, Octobox compares the previous and incoming
`updated_at`. If activity advanced, it clears `archived`
([model](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/notification.rb#L158-L177)).
Tests cover both the model rule and download behavior
([model test](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/test/models/notification_test.rb#L7-L32),
[service test](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/test/services/download_service_test.rb#L57-L71)).

This creates a useful invariant:

> Handling acknowledges the current activity version, not the subject forever.

That rule avoids both common failures: archived threads never returning when someone
mentions the user again, and archived threads returning on every sync without new work.

### 1.5 Read, mute, star, and delete remain distinct

- **Read** queues GitHub `PATCH /notifications/threads/{id}` and updates local unread
  state
  ([implementation](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/notification.rb#L100-L120)).
- **Mute** archives and reads locally, marks the GitHub thread read, and updates its
  subscription to `{ ignored: true }`
  ([implementation](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/notification.rb#L122-L141)).
- **Star** is local-only.
- **Delete** removes only the local notification record.

The separation is sound, but Octobox's mute is incomplete: there is no unmute workflow,
and new activity can unarchive a row whose `muted_at` still remains set.

## 2. Code and architecture review

### 2.1 What Octobox does well

#### Idempotent per-user storage

The unique user/thread identity is a reliable base for retries. User ownership is applied
at controller and channel boundaries, reducing direct-object-reference risk
([controller actions](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/controllers/notifications_controller.rb#L121-L132),
[comments channel](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/channels/comments_channel.rb#L3-L9)).

#### Local-first bulk triage

Page selection, shift-range selection, and "all matching this filter across all pages"
are first-class. The server resolves the current filtered query rather than trusting a
client-generated list of IDs
([selection resolution](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/controllers/concerns/notifications_concern.rb#L42-L69)).
This is both better UX and safer than posting thousands of client-held identifiers.

#### Powerful search without folders

Octobox combines free text, prefix operators, negation, repeated filters, facets, URL
state, and pinned named searches
([search model](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/search.rb#L17-L51),
[parser](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/lib/search_parser.rb#L7-L45)).
Default saved views such as Archivable, Mergeable, and My PRs teach the system by example.

#### Webhooks enrich rather than impersonate the inbox

GitHub App webhooks update shared subject/repository context and can trigger later
per-user polling, but they do not pretend to know which users received a notification.
This respects the boundary between repository events and a user's notification inbox.

#### Keyboard-first triage

Selection, navigation, archive, mute, read, and star actions have keyboard mappings
([mapping reference](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/views/shared/_keyboard_mappings.html.erb)).
The workflow supports repeated processing without forcing a pointer round trip.

### 2.2 What should not be copied

#### A capped newest-first sync can permanently skip work

Octobox requests pages until a configurable cap, default 500
([pagination client](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/lib/page_limiting_octokit_client.rb#L1-L30)).
It then advances the time watermark. If more than 500 threads change between runs, older
overflow changes can fall behind the new watermark forever.

**Do not** combine a newest-first cap with a watermark that advances beyond unconsumed
pages. Persist continuation state and exhaust it, or keep the previous watermark until
all pages in the window have been processed.

#### Retryable failures are swallowed

The sync worker catches transient network/API errors and records a message without
re-raising, causing the job system to see success
([worker](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/workers/sync_notifications_worker.rb#L5-L37)).
Bulk upstream actions also lack durable per-item delivery state.

**Do not** return success-shaped results for failed upstream mutations. Use typed
retryability, exponential backoff, `Retry-After`, a dead-letter state, and visible
partial-failure reporting.

#### Polling ignores parts of GitHub's contract

Octobox traverses the feed twice, synthesizes its own conditional timestamp, requests 100
items per page even though GitHub's current authenticated-user endpoint documents a
maximum of 50, and does not honor `Last-Modified` or `X-Poll-Interval`. It also schedules
all accounts every ten minutes, regardless of activity.

**Do not** hard-code polling cadence or page size. Consume GitHub's headers, add jitter,
back off on secondary rate limits, and prioritize recently active accounts.

#### Shared private subject data lacks a complete retention contract

Subjects are shared by API URL across users. User deletion and bulk `delete_all` can
bypass subject cleanup, leaving bodies, labels, and comments without a notification
reference
([user association](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/user.rb#L8),
[cleanup callback](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/models/notification.rb#L236-L238)).

**Do not** share enriched private content without explicit tenant references, retention,
garbage collection, and account-deletion tests.

#### Webhook verification is optional and legacy

If no secret is configured, Octobox accepts unsigned GitHub webhooks. Verification uses
the SHA-1 header and has no delivery replay ledger
([hook authentication](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/controllers/hooks_controller.rb#L42-L53)).

**Do not** permit unsigned production webhooks. Require SHA-256 verification, constant-time
comparison, delivery-ID idempotency, replay retention, and request-size limits.

#### Search implementation will become expensive

The UI computes many grouped counts and pinned-view counts; title search has no stored
`tsvector`/GIN index, and pagination is offset-based. The UX is worth copying, not the
query strategy.

## 3. Documentation and test review

### 3.1 Documentation strengths

The README explains the product promise and the archive-reopening behavior succinctly
([README](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/README.md#L3-L35)).
Installation documentation covers scopes, background scheduling, subject enrichment,
GitHub App setup, and live-update limitations. The historical migrations also provide a
useful record of why notification-state fields were introduced.

### 3.2 Documentation weaknesses

The hand-maintained OpenAPI contract conflicts with actual routes:

- it documents `DELETE` where the route uses `POST`;
- it documents `GET` mark-read behavior where the route requires `POST`;
- it presents `X-Octobox-API` as an authentication alternative even though the header
  only changes request/CSRF handling.

See
[`openapi.yaml`](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/openapi.yaml#L51-L68)
and
[`routes.rb`](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/config/routes.rb#L14-L28).
Search help also omits newer GitHub reasons even though generic filtering still works.

Mission Control should generate or validate API contracts in CI rather than relying on
parallel handwritten truth.

### 3.3 Test strengths and gaps

Octobox has useful model, controller, service, and browser coverage for filters, actions,
reopening, and row removal. Missing or weak areas include:

- overflow and watermark correctness;
- `Last-Modified`, `X-Poll-Interval`, rate-limit, and retry behavior;
- partial bulk-action failures;
- webhook replay protection;
- orphaned private-data cleanup;
- edited/deleted comment reconciliation;
- multi-tenant subject access;
- accessibility semantics and live announcements.

## 4. UX and accessibility review

### 4.1 UX patterns worth adopting

- Treat the main surface as a work inbox, not a chronological event log.
- Keep filters and searches in the URL.
- Provide useful default saved views before asking users to build their own.
- Support select-page and select-all-matching as separate, explicit states.
- Preserve selection/cursor after an item disappears.
- Show last sync, active sync, partial failure, empty, and filtered-empty states
  distinctly.
- Preview enough subject context to make a triage decision without leaving the app.
- Make keyboard processing a documented primary workflow.

### 4.2 UX patterns to improve

Octobox still has non-semantic clickable SVG/div controls, hover-dependent icon
explanations, status messages without `aria-live`, deprecated keyboard-event handling,
and invalid/weak table semantics
([row](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/views/notifications/_notification.html.erb#L1-L24),
[list](https://github.com/octobox/octobox/blob/7ce316b6577e36c7c6fd0650ab35e221ce8960e5/app/views/notifications/_list.html.erb#L1-L97)).

Mission Control should retain its semantic buttons, focus restoration, `aria-pressed`
filters, and explicit loading/error roles. Add an `aria-live` region for bulk-action,
sync, and outbox status rather than copying Octobox's markup.

## 5. Mission Control comparison

### 5.1 Mission Control's current strengths

Mission Control already exceeds Octobox in several architectural areas:

- `src/db/schema/notifications.ts` stores normalized level/category, actions,
  presentation, grouping/dedupe keys, entity relationships, reconciliation attempts,
  staleness, and auto-resolution reason.
- `src/lib/notifications/providers/` separates source-specific presentation from shared
  UI rendering.
- `src/lib/notifications/service.ts` has push eligibility, suppression reasons, policy
  snapshots, channel delivery events, dedupe keys, and retry-related fields.
- `src/lib/sync/index.ts` supports full active-set reconciliation, per-item deep checks,
  fail-open source errors, bounded reconciliation work, and stale-item fallback.
- `src/app/api/notifications/route.ts` excludes archived, dismissed, and resolved items
  from the default inbox and attention counts.
- `src/components/notifications/NotificationsPanel.tsx` already distinguishes a quick
  attention queue from the deeper notification center and has better baseline
  accessibility than Octobox.

These should be retained. Octobox is not a wholesale architecture replacement.

### 5.2 Current GitHub notification lifecycle

`src/lib/connectors/github-issues/index.ts` currently:

1. fetches both unread threads and recently updated `all=true` threads;
2. follows GitHub pagination;
3. filters configured notification reasons;
4. maps GitHub reason and subject type to Mission Control level/category;
5. exposes GitHub's thread `updated_at` and `last_read_at` only in metadata;
6. supports an active-ID reconciliation pass;
7. deep-checks PR/issue state and review-request completion.

The deep reconciliation is valuable. A PR notification can resolve when the PR merges,
closes, or no longer requests the authenticated user's review, even if GitHub still
returns the thread.

### 5.3 Gaps that affect "handled notifications do not alert again"

#### Read and handled are mutually exclusive

`NotificationState` is one of `unread | read | dismissed | resolved | archived`.
This conflates delivery and workflow dimensions. A notification cannot represent
"handled but unread" or "read but still needs action" without interpreting one enum value
contextually.

#### Local mark-read does not write to GitHub

The GitHub connector implements `markNotificationRead`, but the notification API and
writeback layer never call it. `src/app/api/notifications/bulk/route.ts` updates only the
local row for `mark_read`.

#### Local dismiss does not mark the GitHub thread done

Dismiss writeback calls the generic connector method `dismissAlert`. The GitHub connector
does not implement that method, so GitHub receives no `DELETE
/notifications/threads/{thread_id}` mark-done request. The UI still removes the local row
because the default query excludes `dismissed`.

#### GitHub read state is discarded during ingestion

The connector maps GitHub's `unread` flag to `InboundNotification.isRead`, but
`SyncScheduler.upsertNotifications` sets every prepared notification's state to
`unread`. This can inflate Mission Control's unread/attention badge for threads already
read on GitHub.

#### Existing notifications are immutable on re-fetch

Notification creation uses `onConflictDoNothing` on `sourceId`. Re-fetching a known
GitHub thread does not update its title, body, metadata, sort timestamp, read state, or
activity version. It also cannot reopen an archived/dismissed item when GitHub reports
new activity.

The unique source ID prevents duplicate rows, which is good, but it currently turns
idempotency into immutability.

#### Best-effort writeback is not durable

Dismiss returns local success and launches writeback asynchronously. Failures are logged
but not persisted, retried, or shown to the user. That is acceptable only for sources
where upstream consistency is unimportant; GitHub notification state is not such a
source.

### 5.4 What currently keeps handled items off alerts

Mission Control's local behavior is deterministic:

- dismiss sets `state='dismissed'`;
- archive sets `state='archived'`;
- default notification queries exclude `dismissed`, `archived`, and `resolved`;
- attention counts use the same base exclusion;
- the client optimistically removes dismissed cards.

Therefore a locally handled notification stops appearing and stops contributing to the
badge. The missing guarantee is cross-system consistency and intentional reopening:
GitHub may still show the thread as active, while Mission Control can never update/reopen
the existing row on later activity.

## 6. Recommended target model

### 6.1 Separate delivery, disposition, and source lifecycle

Use independent fields rather than adding more values to the current state enum:

| Dimension | Suggested values | Purpose |
|---|---|---|
| `readState` | `unread`, `read` | Seen/delivery state |
| `disposition` | `inbox`, `handled`, `dismissed` | User workflow |
| `sourceState` | `active`, `resolved`, `deleted`, `unknown` | Upstream lifecycle |
| `syncState` | `synced`, `pending`, `failed` | Local mutation delivery |

Suggested timestamps:

- `readAt`
- `handledAt`
- `dismissedAt`
- `snoozedUntil`
- `sourceResolvedAt`
- `lastSourceActivityAt`
- `handledSourceActivityAt`
- `lastSourceSyncedAt`

Snooze is an inbox visibility timer (`snoozedUntil`), not another disposition. A snoozed
item remains pending inbox work and becomes visible again when the timer expires. Likewise,
long-term archival is a retention/storage concern rather than a second synonym for
handled. During migration, current `archived` rows should normally become `handled`;
retain a separate storage archive marker only if Mission Control needs cold-history
retention.

`handledSourceActivityAt` is the activity version the user acknowledged. Reopen when:

```text
disposition = handled
AND incoming.lastSourceActivityAt > handledSourceActivityAt
AND sourceState = active
```

Do not reopen `dismissed` automatically unless the source/provider policy explicitly
says a dismissed thread can become relevant again.

### 6.2 Define inbox and badge contracts centrally

Use named server-side predicates rather than repeating raw state lists:

```text
isInInbox =
  disposition = inbox
  AND sourceState IN (active, unknown)
  AND (snoozedUntil IS NULL OR snoozedUntil <= now)

needsAttention =
  isInInbox
  AND readState = unread
  AND level != digest
```

Every surface should use the same contract:

- side panel;
- full notification center;
- collapsed bell badge;
- mobile screen;
- browser/OS push eligibility;
- KPI counts;
- AI notification tools.

This is how "handled means no more alerts" becomes an invariant rather than a UI
convention.

### 6.3 Add a durable connector action outbox

For GitHub:

| Mission Control action | GitHub operation |
|---|---|
| Mark read | `PATCH /notifications/threads/{thread_id}` |
| Handle / mark done | `DELETE /notifications/threads/{thread_id}` |
| Mute thread | `PUT /notifications/threads/{thread_id}/subscription` with `ignored=true` |
| Unmute thread | update/delete thread subscription according to current GitHub API semantics |

Each mutation should:

1. update local state optimistically;
2. insert an outbox row in the same transaction;
3. retry with typed backoff and GitHub rate-limit headers;
4. expose pending/failed state per item;
5. reconcile remote truth on the next poll;
6. preserve the local user's disposition if a remote retry fails.

Bulk APIs should return accepted, no-op, failed, and queued counts rather than reporting
`ids.length` as the updated count.

### 6.4 Use activity-aware upsert

For an existing source notification:

- refresh title/body/presentation/metadata;
- keep local user-authored disposition unless activity advanced;
- update remote read state only according to an explicit conflict policy;
- set `sortAt` to new source activity when reopening;
- materialize action changes safely;
- do not create another push delivery for an unchanged occurrence;
- create a new occurrence/push only when the upstream activity key changes.

Use a provider-supplied `sourceActivityKey`, preferably a stable version or timestamp
plus event identity. Timestamp comparison alone is the fallback, not the universal
contract.

### 6.5 Improve GitHub polling without copying Octobox's cap

- Honor `Last-Modified`, `If-Modified-Since`, `X-Poll-Interval`, `ETag` when available,
  `Retry-After`, and primary/secondary rate-limit headers.
- Validate configured credentials against GitHub's current notification-endpoint
  authentication contract; as of this review, the endpoint documentation calls out
  classic PAT support and the `notifications` or `repo` scope.
- Persist a per-account poll checkpoint and incomplete-page continuation.
- Do not advance the checkpoint beyond pages not consumed.
- Add jitter and account activity prioritization.
- Treat webhooks as enrichment and poll triggers, not proof that a user received a
  notification.
- Model each GitHub identity/installation as a distinct connector instance.
- Make notification-reason filters forward-compatible: preserve unknown reasons as
  `github`/`fyi` and expose them for user rules rather than dropping them.

## 7. Product recommendations

### DO

1. **Use "Handled" as the primary clearing verb.** It maps to GitHub's mark-done
   semantics and is less ambiguous than "Dismiss."
2. **Keep "Read" independent.** Opening can mark read while leaving work in the inbox.
3. **Reopen on new activity, not on every sync.** Show a "New activity since handled"
   indicator.
4. **Offer explicit source actions.** `Mark done on GitHub`, `Mute thread`, and `Open PR`
   should be clear, provider-owned actions.
5. **Add saved views.** Seed useful GitHub views: Review requests, Mentions, Assignments,
   CI activity, Security, Participating, and All GitHub.
6. **Add filter-scoped bulk processing.** Distinguish visible-page selection from
   all-matching selection and show the exact scope before action.
7. **Preserve URL-addressable filters and keyboard workflows.**
8. **Show sync truth.** Surface last GitHub poll, rate-limit/backoff state, pending
   writebacks, and partial failures.
9. **Keep source resolution distinct from user handling.** "PR merged" and "I handled
   this" are different audit events even if both remove an item from the inbox.
10. **Measure workflow outcomes.** Track time-to-read, time-to-handle, reopening rate,
    dismissal rate, outbox failures, and notification volume by source/reason.

### DON'T

1. **Do not equate read with done.**
2. **Do not use one enum for delivery, workflow, source, and sync state.**
3. **Do not silently claim upstream success after only a local update.**
4. **Do not permanently suppress a handled thread when its activity version advances.**
5. **Do not auto-reopen intentionally dismissed or muted threads without an explicit
   policy.**
6. **Do not advance incremental checkpoints after capped or partial page consumption.**
7. **Do not poll every account at a fixed cadence regardless of activity and headers.**
8. **Do not derive a user's inbox solely from repository webhooks.**
9. **Do not store provider tokens or private enrichment without encryption, retention,
   account deletion, and tenant-isolation contracts.**
10. **Do not hand-maintain API documentation without contract tests.**
11. **Do not make icon-only or hover-only controls the only way to process notifications.**
12. **Do not add AI classification before lifecycle correctness.** AI cannot compensate
    for duplicated, stale, or incorrectly reopened notifications.

## 8. Prioritized Mission Control roadmap

### P0: Lifecycle correctness

1. Add regression tests for current GitHub ingestion and writeback behavior.
2. Preserve incoming GitHub read state on first insert.
3. Implement GitHub mark-read and mark-done writeback through durable operations.
4. Replace create-only conflict behavior with activity-aware update semantics.
5. Centralize inbox and attention predicates.

### P1: Dual-axis workflow

1. Migrate the single `state` enum to independent read/disposition/source fields.
   Audit every current `state` consumer in desktop, mobile, hooks, providers, APIs, AI
   tools, and KPI queries; keep a compatibility adapter during the migration.
2. Add handled activity watermark and activity-driven reopening.
3. Rename the common clearing action from Dismiss to Handle; keep Dismiss as a separate
   lower-frequency action.
4. Add pending/failed writeback indicators and retry controls.
5. Ensure push eligibility checks disposition/source state at send time, not only at
   notification creation time.

### P2: High-throughput triage

1. Add saved named views with URL-backed query definitions.
2. Add filter-scoped all-matching bulk actions.
3. Add keyboard next/previous, handle, read/unread, snooze, and mute commands.
4. Add GitHub reason/repository/owner/participating facets.
5. Add undo for local handling while keeping outbox semantics deterministic.

### P3: Rules and suppression

1. Add rules for reason, repository, owner, subject type, participation, level, and
   source account.
2. Add snooze with predictable wake and push behavior.
3. Add thread mute/unmute and repository-level local suppression.
4. Consider digests only after individual lifecycle and reopening are reliable.

## 9. Required test coverage

### State and reopening

- read without handling remains in inbox;
- handled unread disappears from inbox and attention counts;
- unchanged handled activity stays handled;
- advanced activity reopens handled and updates sort position;
- dismissed/muted behavior follows explicit reopening policy;
- source-resolved items leave inbox without rewriting user history.

### GitHub sync

- initial `unread=false` remains read locally;
- pagination exhausts or persists continuation;
- checkpoint does not advance after partial consumption;
- exact conditional and poll headers are honored;
- unknown reasons are retained safely;
- rate-limit and retry headers schedule the next attempt correctly;
- multiple GitHub connector instances remain isolated.

### Writeback

- mark-read, mark-done, mute, and unmute enqueue atomically with local state;
- retries are idempotent;
- 401/403 disables or flags credentials rather than retrying forever;
- 404 is interpreted per action contract;
- 429/secondary rate limit backs off;
- partial bulk outcomes are visible and retryable;
- local handled state remains stable during remote outage.

### Counts and delivery

- every panel/page/mobile/KPI count uses the central inbox predicate;
- handled/resolved/snoozed items cannot generate a late push;
- reopened activity gets at most one new push occurrence;
- digest unread state does not inflate the attention badge.

### Security and accessibility

- connector-instance ownership is enforced on every action;
- tokens are encrypted and never included in notification metadata/logs;
- webhook SHA-256, body-size, and delivery replay checks are covered;
- bulk and sync status is announced through a live region;
- all row actions are keyboard reachable and semantically labeled;
- focus moves predictably after row removal and undo.

## Conclusion

Octobox validates that a GitHub notification product should behave like a work inbox,
not merely a mirror of unread events. Its dual-axis read/handled model, activity-driven
reopening, saved searches, and bulk keyboard triage are strong patterns for Mission
Control.

Mission Control should adopt those product invariants without adopting Octobox's
operational shortcuts. Mission Control's existing provider registry, reconciliation
framework, push-policy snapshots, and richer notification actions are a stronger base.
The immediate work is to make that base lifecycle-correct: split read from disposition,
wire durable GitHub writeback, and update/reopen known threads when source activity
advances.
