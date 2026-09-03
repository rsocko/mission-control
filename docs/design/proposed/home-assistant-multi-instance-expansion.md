---
title: "Home Assistant: Multi-Instance, Updates/Repairs, and Custom Actions"
status: proposed
created: 2026-09-03
last_reviewed: 2026-09-03
category: design
related:
  - "[Connector Expansion Review](../active/connector-expansion-review.md)"
  - "[Homelab Incident Notifications](homelab-incident-notifications.md)"
  - "[Configurable Connector Push Notifications](configurable-connector-push-notifications.md)"
  - "[Notifications Redesign](notifications-redesign.md)"
---

# Home Assistant: Multi-Instance, Updates/Repairs, and Custom Actions

## Summary

A `home-assistant` connector already exists
(`src/lib/connectors/home-assistant/`). It polls `/api/states`, matches entity
patterns against a rule engine (door open, low battery, motion, device
offline, package tracking), and auto-resolves alerts whose condition is no
longer true via `getActiveAlertSourceIds`. This is a solid foundation, but it
doesn't yet cover the two-homes requirement, HA's own Updates/Repairs
subsystems, or connector-specific action buttons.

This is an extension of the existing connector, not a rewrite. Most of the
requested capability is either already built generically (multi-instance
connectors, notification levels, "convert to task") or is a bounded addition
to the existing HA client/rule engine.

## What's already solved

**Multiple homes.** `ConnectorConfig` is keyed by `id`, not `type` — nothing
in `ConnectorRegistry` or the `/api/connectors` route enforces one instance
per type. You already add two rows of `type: 'home-assistant'`, each with its
own `name` (e.g. "Home Assistant — Lake House" / "— City Condo"), `baseUrl`,
and `accessToken`. The sync engine, notification tables, and UI already key
everything off `connectorInstanceId`, so alerts/tasks from each home stay
distinct. **Gap:** verify the settings UI doesn't assume singleton types for
HA (it doesn't appear to), and make sure notification cards surface
`connectorInstanceId → name` so you can tell which house an alert is from at
a glance.

**Notification types (FYI / Alert / Action Required).** `NotificationLevel`
already has exactly this taxonomy: `urgent`, `action_needed`, `heads_up`,
`fyi`, `digest`. The plan below maps every new HA signal onto these levels
instead of inventing new ones.

**"Turn into a task."** Every notification already supports a generic
`create_task` action (`/api/notifications/[id]/actions/[actionId]`). Nothing
new is needed for "handled notifications become tasks on demand" — HA alerts
get this for free as soon as they flow through the standard notification
pipeline.

**Auto-clear when handled.** `IConnector.getActiveAlertSourceIds()` already
implements "clear and refresh": each poll, the connector returns every
currently-true alert `sourceId`; anything Mission Control is holding that's
no longer in that set gets auto-resolved. This is the exact mechanism needed
for "updates that are already installed disappear" and "repairs that are
fixed disappear" — it just needs to be extended to the new source kinds
below.

## What's new

### 1. Data sources beyond generic entity patterns

| Source | HA API | Transport | Notes |
|---|---|---|---|
| Updates | `update.*` entities | REST `/api/states` (already used) | State `on` = update available; attributes carry `title`, `latest_version`, `installed_version`, `release_url`, `in_progress`. Filter `entity_id` prefix `update.` instead of user-supplied glob patterns. |
| Persistent notifications | `persistent_notification.*` entities | REST `/api/states` | HA creates a real entity per persistent notification (bell icon items), so these are readable the same way as any other state — no new transport. |
| Repairs | Repairs issue registry | **WebSocket API only** (`repairs/list_issues`) | Repairs issues are *not* exposed as entities or via REST. This is the one genuinely new capability: a small authenticated WS client (`ha-ws-client.ts`) that opens `wss://<host>/api/websocket`, authenticates with the same long-lived token, sends `{"type":"repairs/list_issues"}`, and closes. Short-lived request/response — Mission Control does not need to keep a persistent connection open. |

Each source becomes its own module under
`src/lib/connectors/home-assistant/sources/` (`updates.ts`,
`persistent-notifications.ts`, `repairs.ts`) exporting a
`fetch(...) -> InboundNotification[]` and an `activeIds(...) -> string[]`,
mirroring the existing `checkPackages` pattern in `entity-transformer.ts`.
`fetchNotifications()` and `getActiveAlertSourceIds()` in `index.ts` compose
all sources (existing rule engine + new ones) instead of just the rule
engine.

### 2. Notification taxonomy mapping

| Source | Condition | Level | Category |
|---|---|---|---|
| Update available | Normal integration/add-on/HACS update | `fyi` (or `digest` if user wants batching) | `system` |
| Update available | HA Core / Supervisor / OS update, or update flagged security-relevant | `action_needed` | `system` |
| Update in progress | `update.*` attribute `in_progress: true` | `heads_up` | `system` |
| Repair issue | `severity: warning` | `heads_up` | `system` |
| Repair issue | `severity: error` or otherwise high-impact | `action_needed` | `system` |
| Persistent notification | default | `heads_up` | `home` |
| Persistent notification | `notification_id` matches a user-configured "critical" pattern (e.g. `automation_failed`) | `action_needed` | `automation` |
| Existing entity rules | unchanged | unchanged | unchanged |

Defaults are conservative and user-overridable via per-source severity
overrides in connector settings (same pattern `alertRules` already uses).

### 3. Auto-resolve semantics per source

- **Updates:** "handled" = installed. `activeIds()` returns the set of
  `update.*` entities currently `state: 'on'`. Once you install (or HA
  reports it installed), the entity flips to `off`/version matches, drops out
  of the active set, and the existing reconciliation loop auto-resolves it.
  No polling changes needed — same mechanism as door/battery.
- **Repairs:** "handled" = HA no longer lists the issue (user fixed it or
  ignored it in HA). `activeIds()` returns current `issue_id`s from
  `repairs/list_issues`; anything missing next poll is auto-resolved.
- **Persistent notifications:** "handled" = the entity disappears from
  `/api/states` (HA removes it when dismissed at the source, e.g. via
  `persistent_notification.dismiss`). Same clear-and-refresh mechanism.

This means **dismissing/fixing in Home Assistant itself is sufficient** —
Mission Control doesn't need a bespoke reconciliation poll per source, only
to include each source's IDs in the existing `getActiveAlertSourceIds` set.

### 4. Custom actions (via the existing notification-provider framework)

Mission Control already has a generic action framework
(`src/lib/notifications/providers/*`, `NotificationSourceProvider`,
`NotificationActionDraft`, `POST /api/notifications/[id]/actions/[actionId]`)
used today by Document Intelligence to render provider-specific buttons and
execute server-side effects. Home Assistant should register its own provider
instead of inventing a parallel action system:

- **Install update** (`ha_install_update`) — calls
  `POST /api/services/update/install` with the entity's `entity_id`. Marked
  `requiresConfirmation: true`.
- **Skip update** (`ha_skip_update`) — calls `update.skip`. Useful for
  updates you deliberately don't want yet; the entity stays resolved until a
  newer version appears.
- **Ignore repair** (`ha_ignore_repair`) — calls the WS command
  `repairs/ignore_issue`. HA's "fix" flow for repairs is often a multi-step
  interactive form (confirm data migration, pick options, etc.) that doesn't
  map to a single REST/WS call — for those, the action is `open_url`
  pointing at `{baseUrl}/config/repairs` (existing generic action type, no
  new code) rather than trying to reimplement HA's repair flow UI.
- **Dismiss notification** (`ha_dismiss_persistent_notification`) — calls
  `persistent_notification.dismiss` with the notification's id, so
  dismissing in Mission Control also clears it in HA (keeps both sides in
  sync instead of HA re-surfacing it next poll).
- **Open in Home Assistant** — generic `open_url` action (no new code) to
  the relevant dashboard/history view, for anything that doesn't have a safe
  one-call action.

All of these are additive, allowlisted, single-purpose service calls over
the same REST `/api/services/<domain>/<service>` endpoint the client already
knows how to authenticate against — no new write-capability surface is
opened beyond "call this specific, named HA service."

### 5. Settings additions

Extend `HomeAssistantConfig` (`index.ts`) with:

```ts
interface HomeAssistantConfig {
  // ...existing fields
  enableUpdates?: boolean;                 // default true
  enableRepairs?: boolean;                 // default true
  enablePersistentNotifications?: boolean;  // default true
  criticalUpdateEntities?: string[];        // glob patterns forced to action_needed (e.g. 'update.home_assistant_core*')
  criticalNotificationPatterns?: string[];  // notification_id glob patterns forced to action_needed
  updateDigestMode?: boolean;               // batch routine updates into a single digest notification
}
```

Persisted the same way existing settings are (`config.settings`, parsed in
`initialize()`), so no schema migration is required.

### 6. Auth / setup (per instance, unchanged pattern)

Each home gets its own **Long-Lived Access Token**, generated in HA under
Profile → Security → Long-Lived Access Tokens, pasted into that connector
instance's credentials (`accessToken`). This is exactly what
`HAClient`/`createHAClient` already expects — the WS client reuses the same
token (`{"type":"auth","access_token":"..."}` on connect) so there's no
second credential to manage.

## Non-goals / explicitly deferred

- Reimplementing HA's interactive repair "fix flows" (multi-step forms) —
  link out to `/config/repairs` instead.
- A persistent WebSocket connection / live push from HA — polling on the
  existing sync cadence is sufficient and keeps the connector stateless
  between polls, consistent with every other connector.
- Home Assistant → Mission Control push notifications (HA calling us) — out
  of scope; this stays pull-based like the rest of the connector.
- Renaming/adding new `NotificationLevel` values — reuse the existing five.

## Delivery sequence

1. Add `sources/updates.ts` (REST, no new transport) + tests; wire into
   `fetchNotifications`/`getActiveAlertSourceIds`.
2. Add `sources/persistent-notifications.ts` (REST) the same way.
3. Add `ha-ws-client.ts` (new: minimal request/response WS client) +
   `sources/repairs.ts`; wire in.
4. Register a `home-assistant` `NotificationSourceProvider` with the action
   set in §4, backed by `POST /api/services/<domain>/<service>` and the WS
   client for `repairs/ignore_issue`.
5. Add the settings fields in §5 to connector settings UI + `initialize()`.
6. Verify/adjust the "add connector" UI so a second `home-assistant`
   instance can be created cleanly with its own name/URL/token, and confirm
   notification cards show the owning instance name.
7. Docs: update `connector-expansion-review.md`'s Home Assistant row.

## Success criteria

- Two Home Assistant instances (two homes) run side by side with
  independent tokens, alerts clearly attributed to the right home.
- Updates, repairs, and persistent notifications surface as notifications
  with correctly-mapped `urgent/action_needed/heads_up/fyi/digest` levels.
- Fixing/installing/dismissing in Home Assistant (or via a Mission Control
  action) causes the notification to auto-resolve on the next poll without
  manual cleanup.
- Any HA notification can be promoted to a task via the existing generic
  action, no HA-specific code required for that path.
- New HA-specific actions (install/skip/ignore/dismiss) are single
  allowlisted service calls, confirmed before execution, and never open a
  new generic "run arbitrary service" capability.
