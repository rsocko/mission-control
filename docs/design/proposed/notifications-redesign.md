---
title: "Notifications Redesign"
status: proposed
created: 2026-07-22
last_reviewed: 2026-08-17
category: design
related:
  - "[Triage Queue](../proposed/triage-queue.md)"
  - "[Dashboard KPI Customization](../active/dashboard-kpi-customization.md)"
  - "[Document Intelligence Integration](../proposed/doc-intelligence.md)"
  - "[Configurable Connector Push Notifications](configurable-connector-push-notifications.md)"
---

# Mission Control Notifications Redesign

## Summary

Redesign Mission Control's current **Alerts** system into a broader, more actionable **Notifications** system. The new design keeps the fast right-rail workflow, but upgrades the model, terminology, visuals, and action system so notifications can represent everything from sync failures to finance anomalies to PR review requests without feeling alarmist or underpowered.

The redesign introduces:

- **Alerts → Notifications** across schema, API, UI, and assistant tooling
- A more human/actionable severity model
- Rich cards with source/category identity, metadata, grouping, and stronger CTA patterns
- A dedicated **`/notifications`** page for triage, bulk actions, and keyboard-driven processing
- An extensible action registry so core features and plugins can attach first-class actions

## August 17 Filtering Revision

The approved filtering mockups are available at
[`docs/mockups/mockup-notifications-filtering-redesign.html`](../../mockups/mockup-notifications-filtering-redesign.html).

The dedicated Notifications page uses a hybrid model:

1. **The left rail keeps frequent one-click facets.** Level, State, Source, and
   Time remain visible and continue to mirror the Dashboard navigation pattern.
2. **Saved views live at the top of the rail.** Built-in and custom views share
   one location. `Save current view` appears only when the active criteria do
   not already match a saved view.
3. **Advanced criteria use the task-list filtering pattern.** Category,
   Merchant, Repository, Owner, Reason, Subject type, Source account,
   Participating, and Actionable are selected from one searchable `Add filter`
   control and represented as removable chips.
4. **Quick filters show useful non-zero queues.** Urgent, Action needed,
   Actionable, and Unread appear as count-bearing buttons only when their
   global count is greater than zero.
5. **Actions do not compete with filters.** Page-wide actions stay in the title
   row. Selection and matching counts move to the list header, and bulk actions
   remain contextual.

## July 31 Interaction Revision

The revised mockup is available at
[`docs/mockups/mockup-notifications-v2.html`](../../mockups/mockup-notifications-v2.html).
It supersedes the interaction direction in the original mockup while preserving the
notification taxonomy and full-page split view described below.

### Decisions

1. **The dashboard panel is a quick attention queue.** It is not a compressed
   version of the full Notifications page.
2. **Every actionable notification exposes one clear, verb-specific CTA.**
   Examples include `Review PR`, `Reconnect`, `Track package`, and
   `Review spending`. Avoid generic labels such as `Open` or `View` when a more
   specific verb is available.
3. **Selecting a panel item opens an anchored preview.** The preview is larger
   than the row, contains genuinely new context, and presents the primary and
   secondary actions. Selection must never only change line wrapping, padding,
   or text spacing.
4. **Panel filters prioritize level at a glance.** The primary row shows unread
   counts for `All`, `Urgent`, `Action`, `Heads Up`, and `FYI`. `Unread only`
   and `Actionable only` are independent attribute toggles, so they can refine
   any selected level. Source, text, category, and date filtering belong on the
   full page.
5. **The full page owns deep triage.** Text search, source/category filters,
   date/history controls, bulk selection, and saved views belong on
   `/notifications`. Preserve the existing left navigation for level, category,
   source, and state filters so the center remains familiar and consistent.
   Keep search and sorting in the page header.
6. **Digests do not inflate the attention badge.** A digest is a periodic
   summary rather than a single event, such as a weekly finance summary or a
   grouped activity roundup. New digests remain visible in `Inbox` and `Unread`
   and are marked read normally, but they are excluded from the bell's attention
   count. The badge therefore represents unread non-digest items.
7. **All sources remain eligible for the panel initially.** Track per-source
   notification volume, read and dismissal rates, and time-to-read using
   persisted notification timestamps. Revisit source suppression or grouping
   only when observed volume shows that it is necessary.

### Why this split

GitHub and Linear both treat notifications as an inbox rather than a passive
feed: unread state is visible, selection leads to context, and the dedicated
inbox supports heavier filtering and keyboard workflows. Commerce and community
products reinforce a second useful pattern: notification CTAs work best as
concrete verbs tied to the event, such as tracking a shipment or replying to a
message.

The side panel should optimize for answering two questions quickly:

- What needs my attention now?
- What is the next best action?

The full page should optimize for finding, reviewing, and processing a larger
history. Keeping those jobs separate avoids a crowded panel without removing
power from the notification system.

### Panel interaction contract

| Interaction | Result |
|---|---|
| Click or press Enter on a row | Select it, mark it read, and open the anchored preview |
| Click the primary CTA | Execute or navigate to the notification's primary action |
| Click a level | Show notifications at that level |
| Toggle `Actionable only` | Refine the selected level to notifications with executable actions |
| Toggle `Unread only` | Refine the selected level to unread notifications |
| Click `Open notification center` | Navigate to `/notifications` with the current lightweight filter when practical |

On narrow screens, the anchored preview becomes a bottom sheet or full-height
detail view rather than attempting to float beside the panel.

### Source provider architecture

Notification sources integrate through the typed provider registry in
`src/lib/notifications/providers/`. UI components and API routes must not switch
on connector names to decide how a notification looks or how a custom action is
handled.

Each `NotificationSourceProvider` owns:

- **Signatures** — ordered matchers that identify source-specific notification
  shapes such as a GitHub review request, missing statement, or unmatched EOB.
- **Presentation** — source name, title/body overrides, template key, subtitle,
  metadata chips, and optional generic rich content such as progress, stats,
  and links.
- **CTAs** — typed action drafts with verb-specific labels, icon, variant,
  payload, confirmation requirements, and one normalized primary action.
- **Execution** — an optional server-side handler for source-owned action types.
  Built-in actions such as safe external URLs, internal navigation, task
  creation, and workflows remain explicit platform fallbacks.

The ingestion pipeline resolves the source provider, stores its presentation
schema, and materializes its CTA definitions into `notification_actions`. The
action endpoint delegates to the same source provider before considering
built-in handlers. Unclaimed custom actions fail explicitly instead of being
returned as successful opaque payloads.

```ts
interface NotificationSourceProvider {
  sourceType: string;
  displayName: string;
  signatures: readonly NotificationSignature[];
  executeAction?(
    context: NotificationProviderActionContext,
  ): Promise<NotificationProviderActionResult | null>;
}

interface NotificationSignature {
  key: string;
  matches(notification: InboundNotification): boolean;
  present(notification: InboundNotification): {
    title?: string;
    body?: string | null;
    templateKey?: string | null;
    presentation?: NotificationPresentation;
    actions?: NotificationActionDraft[];
  };
}
```

Provider-generated links are restricted to HTTP(S), internal navigation targets
must be same-origin paths, and the action materializer guarantees at most one
primary CTA. The shared card renders the generic presentation schema; richer
source appearances do not require source-specific JSX.

---

## Problem Statement

The current Alerts system works as a basic feed, but it is too narrow for Mission Control's role as a personal aggregation hub:

1. **"Alert" is too alarm-oriented.** Not every item is urgent. Weekly summaries, messages, PR reviews, and shipment updates all fit poorly under the word "alert."
2. **Severity is visually weak and semantically inconsistent.** A left border plus `critical/high/medium/low/info` is generic, but not especially actionable for a personal productivity product.
3. **Cards do not carry enough context.** Source identity, category meaning, and structured metadata are mostly hidden inside plain title/body text.
4. **Actions are underdeveloped.** "Open →" is too limited for a system that should create tasks, run workflows, navigate in-app, or accept connector-defined actions.
5. **The surface is too constrained.** A 272px side panel is great for quick review, but not for bulk triage, keyboard workflows, or complex filtering.
6. **The model is not future-friendly.** Existing schema/API patterns assume a simpler alert feed rather than a durable notification center with templates, grouped rendering, and plugin extensibility.

---

## Goals

- Rename the system from **Alerts** to **Notifications** everywhere user-facing
- Make notification level/severity easier to understand and act on
- Improve card design so items are scannable in a dark-first UI
- Support richer, typed actions beyond a single URL
- Preserve the fast dashboard rail while adding a full-page notification center
- Distinguish Notifications from Triage while allowing both to share patterns
- Support connector- and plugin-defined notification actions and templates
- Provide a clean migration path from current schema/API/components

## Non-Goals

- Replacing the existing Triage Queue with Notifications
- Rebuilding every connector at once
- Creating a full Slack/Discord-style notification inbox with threading, reactions, or chat
- Designing mobile push delivery in this doc
- Solving all reminder/snooze semantics for tasks and notifications in one pass

---

## Current State

Current Alerts behavior:

- Dashboard right-side panel, **272px (`w-72`)** wide
- Collapsed bell rail with unread badge
- `AlertCard` shows:
  - title
  - body
  - left severity border
  - time ago
  - `Open →` link
  - dismiss `X`
- Schema:
  - `id`, `sourceId`, `connectorType`, `connectorInstanceId`
  - `title`, `body`, `severity`, `category`
  - `isRead`, `isDismissed`, `isActionable`, `actionUrl`
  - `receivedAt`, `expiresAt`, `relatedTaskId`, `metadata`
- API:
  - `GET /api/alerts?source=&severity=&unreadOnly=`
  - `PATCH /api/alerts` with `act_now | schedule | dismiss | delegate`
- AI:
  - AI triage tool processes alerts
- Producers:
  - Home Assistant
  - Document Intelligence
  - Monarch Money / finance alerts
  - RyMessage

Pain points:

- Naming is narrow
- Severity is color-heavy but meaning-light
- No first-class grouping or bulk processing
- CTA model is too weak for the app's automation ambitions

---

## Proposed Solution

## 1) Rename: Alerts → Notifications

### Rationale

**Notifications** is the better umbrella term because it:

- is the industry-standard name users already understand
- is less alarming than "alerts"
- accommodates both urgent and low-stakes items
- better fits summaries, AI suggestions, connector updates, and workflow completions
- leaves room for a smaller subset of truly urgent items to still be called "alerts" informally within the notification taxonomy

### Naming Changes

| Current | Proposed |
|---|---|
| Alerts | Notifications |
| AlertCard | NotificationCard |
| alerts panel | notifications rail / notifications panel |
| `unread-alerts` KPI | `unread-notifications` KPI |
| `/api/alerts` | `/api/notifications` |
| `alertTools` | `notificationTools` |
| `AlertSeverity` _(retired)_ | `NotificationLevel` |
| `AlertItem` | `NotificationItem` |

### Migration Plan

#### Phase 1 — Terminology aliasing

- Change user-facing copy first:
  - Dashboard header: **Alerts → Notifications**
  - KPI label: **Unread Alerts → Unread Notifications**
  - Shortcut help: **Toggle notifications panel**
- Keep underlying `alerts` table and `/api/alerts` working
- Introduce UI/component aliases:
  - `NotificationCard` wraps or replaces `AlertCard`
  - `useNotifications()` can adapt current alert payloads

#### Phase 2 — Dual API support

- Add **`/api/notifications`**
- Keep **`/api/alerts`** as a compatibility alias
- Old query params still work, but new endpoint prefers richer filters:
  - `source`
  - `category`
  - `level`
  - `state`
  - `groupBy`
  - `actionableOnly`

#### Phase 3 — Schema expansion + backfill

- Create new `notifications` table
- Backfill from `alerts`
- Update connectors and finance engine to write notifications
- Provide a read adapter for legacy rows until old code paths are removed

#### Phase 4 — Full deprecation

- Remove `Alert*` types/components/routes after one release cycle
- Retire `/api/alerts` after all internal callers migrate

---

## 2) Severity Terminology Redesign

### Options Evaluated

#### Option A — Urgency-based

- **Urgent**
- **Action Needed**
- **Heads Up**
- **FYI**
- **Digest**

**Pros**
- Human-readable
- More actionable in a personal app
- Handles non-alarming summaries well
- Works across finance, home, tasks, AI, and system events

**Cons**
- Less compact for engineers than P-levels

#### Option B — Priority mapping

- **P0 / P1 / P2 / P3 / P4**

**Pros**
- Aligns with existing task-priority mental model
- Easy to sort

**Cons**
- Feels too operational/engineering-centric
- Users may confuse notification priority with task priority
- Awkward for summaries and passive updates

#### Option C — GitHub-inspired

- **Error / Warning / Notice / Info / Success**

**Pros**
- Familiar to developer audiences
- Nice for system/connector health

**Cons**
- Poor fit for finance reminders, delivery updates, or weekly digests
- "Success" does not solve the summary/digest case

### Recommendation

Adopt **Option A: Urgency-based** as the primary user-facing model:

- **Urgent**
- **Action Needed**
- **Heads Up**
- **FYI**
- **Digest**

### Why this is the best fit

- Mission Control is a **personal attention system**, not just an ops console
- The label should tell the user what level of attention is warranted
- The model comfortably spans:
  - critical failures
  - important tasks/messages
  - passive updates
  - summaries

### Compatibility Mapping

| Legacy severity | New level | Notes |
|---|---|---|
| `critical` | `urgent` | time-sensitive, high-risk, break/fix |
| `high` | `action_needed` | user should do something soon |
| `medium` | `heads_up` | notable, review soon |
| `low` | `fyi` | low-stakes awareness |
| `info` | `digest` | summary or passive informational item |

### Important nuance

Internally, we can still store:

- a **sortable numeric rank** (`attentionScore` or `levelRank`)
- an optional **task priority hint** if a notification becomes a task

That preserves programmatic sorting without exposing P-level language in the UI.

---

## 3) Visual Design Improvements

## Design Principles

- **Identity first** — always show where the notification came from
- **Meaning before prose** — icons, labels, and metadata should explain the item before the body text does
- **CTA clarity** — the next best action must be obvious
- **Dark-first contrast discipline** — use color as reinforcement, not as the only signal

## Card Anatomy

Each notification card should support:

1. **Source icon/logo**
   - prominent leading avatar/badge
   - e.g. Home Assistant, Monarch, RyMessage, Document Intelligence
2. **Category icon**
   - secondary icon indicating the kind of item
3. **Title**
4. **Subtitle/meta row**
   - level pill
   - time ago
   - source name
5. **Body**
6. **Rich metadata chips / stat row**
   - amount, delta %, counts, due date, connector state, etc.
7. **Primary action**
8. **Quick actions strip**
9. **Read/unread indicator**

### Recommended icon treatment

- **Source icon** = brand/logo
- **Category icon** = semantic meaning
- **Level icon** = status/urgency

This avoids overloading one icon/color with too many jobs.

### Category Icon Map

| Category | Icon |
|---|---|
| PR review | `git-pull-request` |
| security | `shield` |
| finance | `dollar-sign` |
| home/devices | `house` / `lightbulb` / `package` |
| tasks | `check-square` |
| system | `server-crash` / `plug-zap` |
| messages/mentions | `at-sign` / `message-circle` |
| AI insights | `sparkles` / `brain` |
| shipping | `truck` / `package` |

### Severity/Level treatment

Do **not** rely on a left border alone.

Use:

- level icon
- level pill text
- subtle tinted background or border
- optional accent stripe only as a secondary cue

Example:

- Urgent = red icon + red-tinted pill
- Action Needed = amber/orange icon + pill
- Heads Up = blue pill
- FYI = slate pill
- Digest = purple/neutral summary pill

### Rich metadata examples

**Finance**

- `$84 over budget`
- `112% used`
- `2 duplicate subscriptions`

**Home**

- `Front door unlocked for 18m`
- `3 packages delivered`

**Social/PR**

- `2 reviewers requested`
- `5 unread messages`

**AI/Insights**

- `7-item weekly digest`
- `Pattern confidence 91%`

### Time grouping

Group notifications in the rail and page by:

- **Today**
- **Yesterday**
- **This Week**
- **Older**

This improves scanability more than a flat list sorted by timestamp alone.

### Example compact card wireframe

```text
┌──────────────────────────────────────────────────────┐
│ [Monarch]  [$] Budget exceeded            [Action Needed]
│ Groceries spending is 112% of monthly budget.   2h ago
│ $84 over   112% used   Category: Groceries
│
│ [Create Task]  [Open Monarch]  [Snooze]  [Dismiss]
└──────────────────────────────────────────────────────┘
```

### Quick panel wireframe

```text
┌──────────────── Notifications ────────────────┐
│ [Inbox] [Needs action] [Unread]               │
│ Today                                         │
│ ┌───────────────────────────────────────────┐ │
│ │ [GitHub] Review requested        unread ● │ │
│ │ repo: mission-control · 1 reviewer · 8m  │ │
│ │ [Review PR]                               │ │
│ └───────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────┐ │
│ │ [Monarch] Budget exceeded        [Action] │ │
│ │ $84 over · 112% used · 2h                │ │
│ │ [Review spending]                         │ │
│ └───────────────────────────────────────────┘ │
│ Yesterday                                     │
│   ...                                         │
│ [Open notification center →]                  │
└───────────────────────────────────────────────┘

Selecting a row opens an anchored preview beside the panel with the full body,
metadata, primary action, and secondary actions. The row itself remains the same
size.
```

---

## 4) Actionability & Call-to-Action

The new model should treat each notification as a container for **typed actions**, not just a URL.

## Core Action Types

- **Open URL**
- **Create Task**
- **Run Workflow**
- **Navigate to Page**
- **Approve / Reject**
- **Dismiss**
- **Snooze**
- **Mark Read / Mark Unread**

## CTA Model

Each notification may expose:

- **primary action** — most likely next step
- **secondary quick actions** — common alternatives
- **overflow actions** — less common/destructive actions

### Primary action examples

| Notification | Primary action |
|---|---|
| PR review requested | `Open PR` |
| Budget exceeded | `Create Task` |
| Connector auth expired | `Reconnect` |
| Weekly summary | `Open Summary` |
| Workflow approval request | `Approve` |

### Quick actions strip

Bottom-of-card quick actions should be explicit buttons, not inline links:

```text
[Open PR] [Create Task] [Run Workflow] [Dismiss]
```

### AI-suggested action

If AI recommends an action, visually highlight it:

- small `AI suggested` badge
- subtle glow/ring on the suggested button
- explanation in the selected preview or on hover:
  - `AI suggested: Create Task because this looks time-sensitive and unresolved`

### Extensible action system

Plugins/connectors should be able to register custom actions such as:

- `Pay Bill`
- `Add to Calendar`
- `Ack Device Alert`
- `Reply in RyMessage`
- `Re-run Sync`

This should not require hardcoding each action in the notification card renderer.

---

## 5) Dedicated Notifications Page

## Recommendation

Add a separate **`/notifications`** route.

### Why it should exist

The rail is ideal for:

- quick review
- recent items
- lightweight action-taking

But a full page is better for:

- bulk triage
- advanced filters
- long histories
- keyboard-driven processing
- grouped views
- plugin/custom action affordances

### Relationship to Triage

**They are related but different systems.**

#### Triage

- content ingestion/routing
- "saved for later" items
- user-curated queue
- heavy on classification and routing

#### Notifications

- events requiring awareness or attention
- system + connector + assistant generated
- often ephemeral or stateful
- may resolve, dismiss, escalate, or spawn tasks/workflows

### Shared patterns with Triage

They should share:

- queue/list shell primitives
- bulk action bar
- keyboard patterns
- filter chips
- selection and detail-preview behavior

They should **not** be merged into one dataset or one route.

### Notifications page capabilities

- Full-page triage mode
- Group by time / source / category / level
- Multi-select and bulk actions
- Search
- Advanced filters
- Saved views later if needed
- Optional split view: list on left, detail on right

### Suggested layout wireframe

```text
┌────────────────────────────────────────────────────────────────────┐
│ Notifications                                      [Unread] [⋯]   │
│ Filters: [Level ▾] [Source ▾] [Category ▾] [Actionable] [Search]  │
├───────────────────────┬────────────────────────────────────────────┤
│ Today                 │ Notification detail / expanded preview     │
│ > PR review requested │ Source, category, metadata, full history   │
│   Budget exceeded     │                                            │
│ Yesterday             │ [Primary Action] [Quick Actions...]        │
│   Door unlocked       │                                            │
│ Older                 │ Related task / project / connector info    │
└───────────────────────┴────────────────────────────────────────────┘
```

### Keyboard shortcuts

Recommended defaults:

- `j / k` — next/previous notification
- `o` — primary action
- `t` — create task
- `w` — run workflow
- `r` — mark read/unread
- `d` — dismiss
- `s` — snooze
- `a` — approve
- `x` — multi-select
- `shift+x` — clear selection
- `/` — focus search

---

## 6) Surface Actions & Extensibility

## Required built-in action behavior

### Hyperlinks

- Open in a **new tab/window**
- Clear iconography for external destinations
- Preserve source context in action payload for analytics

### Create Task

- Available inline on the card
- Pre-fills task title/description from the notification
- Carries metadata:
  - source connector
  - original notification id
  - deep link back to notification
  - suggested priority

### Run Workflow

- Triggers n8n or custom automation
- Supports parameterized inputs from notification metadata
- Should show optimistic status:
  - `Running…`
  - `Queued`
  - `Completed`
  - `Failed`

### Mission Control deep links

Examples:

- open related task
- open project
- open shipment detail
- open connector settings
- open finance page

### Approve / Reject

Needed for:

- AI-suggested plans
- workflow approvals
- security/device actions
- structured decisions from connectors

### Plugin custom actions

Plugins/connectors should register new action types with:

- id
- label
- icon
- execution handler
- confirmation requirements
- payload schema
- availability rules

---

## 7) Notification Categories (Expanded)

Recommended top-level categories:

| Category | Examples |
|---|---|
| **System** | sync errors, auth expired, connector offline, app updates |
| **Tasks** | overdue warnings, due today, assignment changes, blocked tasks |
| **Finance** | budget alerts, anomalies, kid spending, upcoming bills |
| **Home** | device state changes, automations triggered, deliveries, mail |
| **Social / Comms** | mentions, messages, reply-needed, PR reviews |
| **AI / Insights** | weekly summaries, suggestions, pattern detected, forecast |
| **Packages / Shipping** | out for delivery, delayed, delivered |

### Category vs template

- **Category** = broad grouping/filtering dimension
- **Template** = concrete notification type

Examples:

| Category | Template key |
|---|---|
| Finance | `budget_exceeded` |
| Finance | `subscription_duplicate` |
| Social / Comms | `pr_review_requested` |
| System | `connector_auth_expired` |
| AI / Insights | `weekly_summary` |
| Packages / Shipping | `delivery_delayed` |

This keeps filtering stable while letting connectors add many specific notification types.

---

## 8) Schema Changes

## Proposed Core Model

Rename conceptual model from `AlertItem` to `NotificationItem`.

### Proposed `notifications` table

```ts
notifications {
  id: string
  sourceId: string
  connectorType: string
  connectorInstanceId: string

  title: string
  body: string | null
  level: 'urgent' | 'action_needed' | 'heads_up' | 'fyi' | 'digest'
  levelRank: number
  category: string
  templateKey: string

  state: 'unread' | 'read' | 'dismissed' | 'resolved' | 'archived'
  readAt: string | null
  dismissedAt: string | null
  resolvedAt: string | null
  archivedAt: string | null

  isActionable: boolean
  primaryActionId: string | null
  aiSuggestedActionId: string | null

  receivedAt: string
  sortAt: string
  expiresAt: string | null
  groupKey: string | null
  dedupeKey: string | null
  threadKey: string | null

  relatedTaskId: string | null
  relatedProjectId: string | null
  relatedEntityType: string | null
  relatedEntityId: string | null
  navigationTarget: string | null

  metadata: json
  presentation: json
}
```

### Why these new fields

- `level` / `levelRank` — better naming + stable sorting
- `templateKey` — enables template-based rendering and defaults
- `state` — better than a handful of booleans
- `primaryActionId` — first-class CTA support
- `aiSuggestedActionId` — highlight AI recommendation without mutating action semantics
- `sortAt` — supports resurfacing/snoozing later
- `groupKey` — grouping duplicates or similar events
- `dedupeKey` — prevents spammy repeats
- `navigationTarget` — direct deep-link support
- `presentation` — connector/template-provided display hints without polluting top-level schema

### Backward-compatible mapping from current table

| Current field | Proposed field |
|---|---|
| `severity` | `level` |
| `isRead` | `state = read/unread` |
| `isDismissed` | `state = dismissed` |
| `actionUrl` | action record of type `open_url` |
| `receivedAt` | `receivedAt` + default `sortAt` |
| `relatedTaskId` | `relatedTaskId` |
| `metadata` | `metadata` |

## Action Registry Model

Use a **registry + persisted action instances** approach.

### Registry definition

```ts
type NotificationActionType =
  | 'open_url'
  | 'create_task'
  | 'run_workflow'
  | 'navigate'
  | 'approve'
  | 'reject'
  | 'dismiss'
  | 'snooze'
  | string; // plugin-defined

interface NotificationActionDefinition {
  type: NotificationActionType;
  label: string;
  icon?: string;
  variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  opensExternal?: boolean;
  requiresConfirmation?: boolean;
  payloadSchema?: unknown;
  handler: 'client' | 'server' | 'connector' | 'workflow';
}
```

### Persisted per-notification action instance

```ts
notification_actions {
  id: string
  notificationId: string
  actionType: string
  label: string
  icon: string | null
  variant: string
  isPrimary: boolean
  sortOrder: number
  payload: json
  visibilityRule: string | null
  createdBy: 'system' | 'connector' | 'plugin' | 'ai'
}
```

This gives us:

- stable UI rendering
- connector/plugin extensibility
- per-notification action customization
- room for analytics and audit history later

## Notification Templates

Templates define display defaults and expected metadata for known notification types.

```ts
interface NotificationTemplate {
  key: string;
  category: string;
  defaultLevel: NotificationLevel;
  titleTemplate?: string;
  bodyTemplate?: string;
  categoryIcon?: string;
  sourceDisplayMode?: 'compact' | 'prominent';
  metadataSchema?: unknown;
  defaultActions?: string[];
}
```

Examples:

- `budget_exceeded`
- `kid_threshold`
- `subscription_duplicate`
- `pr_review_requested`
- `connector_auth_expired`
- `delivery_update`
- `weekly_summary`

Templates help standardize:

- icon choice
- CTA defaults
- metadata rendering
- grouping/dedupe behavior

---

## 9) API Changes

## Recommended API shape

### Read

`GET /api/notifications`

Suggested filters:

- `source`
- `category`
- `level`
- `state`
- `groupBy=time|source|category|level`
- `actionableOnly=true`
- `cursor` / `limit`

### Execute a single action

`POST /api/notifications/:id/actions/:actionId`

Why this is better than `PATCH /api/alerts` with a generic action string:

- action instances are explicit
- supports plugin-defined actions
- handles actions beyond `act_now/schedule/dismiss/delegate`

### Bulk operations

`POST /api/notifications/bulk`

Examples:

- mark read
- dismiss
- archive
- run action across multiple notifications where supported

### Backward compatibility

Keep:

- `GET /api/alerts`
- `PATCH /api/alerts`

Map them internally to notification reads/actions during migration.

---

## 10) Dedicated Dashboard Surface Evolution

## KPI Card

Current KPI:

- **Unread Alerts**

Proposed:

- **Unread Notifications**

Implementation notes:

- rename slug from `unread-alerts` to `unread-notifications`
- temporarily support both slugs in the KPI registry
- preserve click behavior, but navigate to `/notifications` or open the panel

## Collapsed Bell Rail

Current:

- simple bell icon with unread count

Proposed:

- retain bell metaphor
- add richer affordances over time:
  - unread badge
  - optional top-level level indicator (e.g. red dot if any urgent items exist)
  - hover tooltip summary:
    - `2 urgent · 5 action needed · 11 unread`

Possible future compact state:

```text
┌──┐
│🔔│  11
│● │  urgent present
└──┘
```

## Quick Panel

The right panel remains the fast-access inbox, but should not become a miniature
version of the full notification center:

- grouping headers
- three attention views: Inbox, Needs action, and Unread

- primary action buttons
- anchored detail preview on selection
- empty states by filter

---

## 11) Relationship to AI Assistant Tools

Current:

- AI triage operates on alerts

Proposed:

- rename tools to **notification tools**
- broaden assistant capabilities from "triage alerts" to:
  - summarize notifications
  - suggest actions
  - bulk classify
  - convert to tasks
  - propose workflows
  - suppress noisy categories/sources

### Recommended tool evolution

| Current | Proposed |
|---|---|
| `getAlerts` | `getNotifications` |
| alert triage recommendations | notification action suggestions |
| severity filter | level/state/category filters |

### AI-specific enhancements

- `aiSuggestedActionId`
- `aiSummary`
- `aiReason`
- `aiPriorityHint`
- `aiDuplicateClusterId`

These can live in `metadata` at first, then graduate if needed.

---

## 12) Rollout Strategy

## Milestone 1 — Rename + UI refresh

- Change copy to Notifications
- Replace `AlertCard` with richer `NotificationCard`
- Keep existing data model/API under an adapter

## Milestone 2 — Action system

- Introduce typed action buttons
- Support `open_url`, `create_task`, `navigate`, `dismiss`
- Add AI-suggested action highlighting

## Milestone 3 — Dedicated page

- Ship `/notifications`
- Add grouping, bulk actions, keyboard shortcuts

## Milestone 4 — Full schema/API migration

- Backfill `notifications`
- Convert connectors + finance engine writers
- Deprecate legacy alert types/routes

---

## 13) Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Rename causes churn across codebase | Use adapters and dual-route support during migration |
| Notification feed becomes noisy | Add dedupe keys, grouping, category filtering, AI suppression later |
| Too many action types make cards chaotic | Enforce one primary action + max 3 quick actions + overflow menu |
| Triage and Notifications become conceptually blurry | Keep separate routes, datasets, and mental models |
| Plugin actions become unsafe/inconsistent | Require typed registry, confirmation flags, and server-side validation |

---

## 14) Resolved Decisions

Resolved: selecting a panel notification marks it read and opens its preview.

Resolved: digests remain visible and unread but do not count toward the bell's
attention badge.

Resolved: the panel has no source filter; source filtering remains in the full
notification center's left navigation.

Resolved: do not preemptively suppress high-volume sources. Measure volume and
engagement by source and adjust grouping or routing based on observed usage.

Resolved: when a notification starts an asynchronous workflow, preserve the
original notification and create a linked follow-up notification when the
workflow completes or fails. Use the same group key so the notification center
can present the request and result together. For example, `Reconcile unmatched
transactions` remains the initiating notification, while `Reconciliation
completed: 3 transactions matched` is the linked result. This preserves history
and supports failures, retries, and delayed completion without rewriting the
event that initiated the work.

Resolved: per-source notification preferences are deferred from the initial
redesign and tracked as follow-up work in GitHub. They belong in notification
settings rather than the dashboard quick panel.

---

## Recommendation

Proceed with a **Notifications** redesign centered on:

- urgency-based user-facing levels
- richer card layout with source/category identity
- typed/extensible actions
- a dedicated `/notifications` page
- a phased migration that preserves existing alert functionality while modernizing the model

This delivers a system that feels less alarmist, more useful, and much more aligned with Mission Control's role as the user's central attention hub.
