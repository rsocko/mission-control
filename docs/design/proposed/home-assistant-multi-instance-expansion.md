---
title: "Home Assistant: Multi-Instance, Updates, Repairs, and Actions"
status: proposed
created: 2026-09-03
last_reviewed: 2026-09-07
category: design
related:
  - "[Connector Expansion Review](../active/connector-expansion-review.md)"
  - "[Homelab Incident Notifications](homelab-incident-notifications.md)"
  - "[Configurable Connector Push Notifications](configurable-connector-push-notifications.md)"
  - "[Notifications Redesign](notifications-redesign.md)"
mockups:
  - "[Home Assistant integration mockup](../../mockups/mockup-home-assistant-integration.html)"
---

# Home Assistant: Multi-Instance, Updates, Repairs, and Actions

## Decision summary

Extend the existing `home-assistant` connector rather than replacing it. Each
Home Assistant server remains a separate connector instance with independent
credentials, source settings, sync health, notifications, and actions.

The implementation adds three first-class sources:

1. **Updates** from `update.*` states returned by REST `GET /api/states`.
2. **Persistent notifications** from the WebSocket command
   `persistent_notification/get`. Persistent notifications are not
   `persistent_notification.*` REST state entities.
3. **Repairs** from the WebSocket command `repairs/list_issues`.

Mission Control may invoke a small allowlist of Home Assistant actions. Every
mutating action requires confirmation. Update installation offers a backup
choice only when the update entity advertises backup support. No arbitrary
Home Assistant service caller is exposed.

Every Home Assistant condition is stored as an individual Mission Control
notification with its own stable identity and lifecycle. Routine update
delivery defaults to one daily outbound push summary per connector instance;
that summary is a delivery event, not an inbox notification. Home Assistant
Core, Supervisor, and Operating System updates have explicit default critical
patterns that may trigger immediate push delivery. Other escalation is
pattern-based and user configured; Mission Control does not infer that an
update is "security-relevant" from names, release text, or AI.

## Job and audience

### Primary user

A power user operating more than one Home Assistant installation - for example,
a primary residence and a second home - who wants one reliable place to notice
maintenance, understand which installation needs attention, and take bounded
actions without opening each Home Assistant dashboard.

This is an **Operate** surface. The user is scanning live operational state,
not exploring analytics or configuring an automation platform.

### Job to be done

> When one of my Home Assistant installations needs maintenance, show me what
> changed, identify the installation unambiguously, let me take the safe common
> action, and clear the item when Home Assistant says it is handled.

### User outcomes

- Add two or more Home Assistant instances without their data or credentials
  colliding.
- Recognize the owning instance before reading a notification body.
- See and act on each routine maintenance item independently without receiving
  a separate device push for every minor update.
- See truly actionable conditions at the right attention level without
  speculative "security" classification.
- Install or skip a supported update, ignore a repair, dismiss a persistent
  notification, or open the exact Home Assistant context.
- Trust that a successful action changes Home Assistant and that failures remain
  visible and diagnosable.
- Filter notifications by source type, connector instance, and Home Assistant
  source.

## Scope

### In scope

- Multiple independently named `home-assistant` connector instances.
- Add and edit flows for identity, URL, token, source toggles, outbound delivery
  behavior, escalation patterns, and action availability.
- Existing entity-rule alerts and package checks.
- Update ingestion, individual update notifications, outbound update summaries,
  critical update overrides, version and progress presentation, install, and
  skip.
- Persistent-notification ingestion and dismissal.
- Repair ingestion, severity mapping, ignore, and deep-linking to Home
  Assistant's repair flow.
- Per-source reconciliation, partial failure behavior, connector health, action
  audit data, migration defaults, and accessibility requirements.
- Desktop notification list/detail, mobile notification list/detail, and
  Settings behavior.
- Generic "Create task" on every resulting Mission Control notification.

### Non-goals

- Reimplementing Home Assistant repair flows. Fixable repairs open Home
  Assistant at `/config/repairs`; Mission Control does not reproduce those
  multi-step forms.
- A persistent WebSocket subscription or Home Assistant-initiated push. The
  connector remains polling-based and opens WebSocket only for bounded
  request/response work.
- Creating, editing, or dismissing all persistent notifications in bulk.
- Installing a user-selected historical update version in the first release.
- Automatically installing updates, skipping updates, ignoring repairs, or
  dismissing persistent notifications.
- Generic or AI-derived "security relevance" inference.
- A generic Home Assistant service/action console.
- New notification levels or a Home Assistant-only notification center.
- Changing existing entity-rule semantics, except to add clear instance
  attribution and isolate failures by source.
- Building the linked mockup in this workstream.

## Current foundation

The connector at `src/lib/connectors/home-assistant/` already:

- reads `/api/states` through `HAClient`;
- evaluates configured entity patterns and alert rules;
- emits notification-only connector data;
- keys records by `connectorInstanceId`;
- auto-resolves absent conditions through `getActiveAlertSourceIds`; and
- uses the shared notification pipeline, which already supports generic
  `create_task` and provider-owned actions.

`ConnectorConfig` is keyed by instance `id`, not connector `type`, so the data
model already permits multiple Home Assistant rows. The remaining multi-instance
work is product correctness: creation must not assume one instance, names must
be distinct and visible, filters must preserve the distinction, and every
action must resolve credentials from the notification's owning instance.

## Authoritative Home Assistant API contract

### Transport and authentication

- REST uses the configured `baseUrl`, a bearer long-lived access token, and the
  existing Home Assistant REST endpoints. Service calls send Home Assistant
  `service_data` as the JSON request body.
- WebSocket connects to `/api/websocket` using `ws` or `wss` derived from the
  configured `baseUrl`. It waits for `auth_required`, sends
  `{"type":"auth","access_token":"..."}`, requires `auth_ok`, and then sends
  integer-ID commands.
- A polling cycle opens at most one WebSocket connection per connector
  instance, reuses it for all enabled WebSocket sources, and closes it after
  responses or timeout. It is not a subscription.
- Each command response must match the request `id`, have `type: "result"`, and
  have `success: true`. Home Assistant error objects are normalized without
  logging the access token or full command payload.

See the official
[Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
for the authentication and command protocol and the
[Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
for state reads and service-call request shape.

### Updates

Updates remain based on REST `GET /api/states`. Select entities whose
`entity_id` begins with `update.`.

| Home Assistant field | Mission Control use |
|---|---|
| `state` | `on` means an update is available; `off` means current or skipped; `unknown`/`unavailable` is degraded data, not an available update |
| `attributes.title` | Preferred product title; fall back to `friendly_name`, then a humanized entity ID |
| `attributes.installed_version` | Current version shown on the card and confirmation |
| `attributes.latest_version` | Offered version shown on the card, identity, and confirmation |
| `attributes.in_progress` | Boolean installation status |
| `attributes.update_percentage` | Progress from 0 to 100 when present and finite |
| `attributes.release_summary` | Optional, sanitized summary in detail |
| `attributes.release_url` | Optional HTTPS/HTTP external link after URL validation |
| `attributes.skipped_version` | Diagnostic context; a skipped current version normally makes the entity state `off` |
| `attributes.supported_features` | Gates install and backup controls |
| `attributes.auto_update` | Hides Skip when true |

The card must not compare version strings itself to decide availability. Home
Assistant owns that decision through entity state.

`update.install` is invoked through
`POST /api/services/update/install` with exactly one stored `entity_id` in the
JSON service-data body. The first release omits `version`, so Home Assistant
installs the latest offered version. Include `backup: true|false` only when the
entity advertises `UpdateEntityFeature.BACKUP`; otherwise omit it and do not
render the choice.

`update.skip` is invoked through `POST /api/services/update/skip` with exactly
one stored `entity_id` in the JSON service-data body. Skip is unavailable when
`auto_update` is true. Home Assistant marks the current offered version skipped,
returns the entity to `off`, and surfaces it again when a newer version appears.

Authoritative references:

- [Update entity developer contract](https://developers.home-assistant.io/docs/core/entity/update/)
- [Update integration states and actions](https://www.home-assistant.io/integrations/update/)
- [`update.install` action](https://www.home-assistant.io/actions/update.install/)
- [`update.skip` action](https://www.home-assistant.io/actions/update.skip/)
- [Home Assistant Core update service implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/update/__init__.py)

### Persistent notifications

Persistent notifications are held by Home Assistant's persistent-notification
component, not represented as `persistent_notification.*` entities in
`/api/states`.

Read current notifications with:

```json
{
  "id": 2,
  "type": "persistent_notification/get"
}
```

The successful result is a list containing:

```json
{
  "notification_id": "invalid_config",
  "title": "Invalid config",
  "message": "Review the configuration error.",
  "created_at": "2026-09-07T00:00:00+00:00"
}
```

Dismiss one notification with REST
`POST /api/services/persistent_notification/dismiss` and:

```json
{
  "notification_id": "invalid_config"
}
```

The stored notification ID comes from the WebSocket response and is never
accepted from client-supplied action input.

Authoritative references:

- [Persistent Notification integration](https://www.home-assistant.io/integrations/persistent_notification/)
- [`persistent_notification.dismiss` action](https://www.home-assistant.io/actions/persistent_notification.dismiss/)
- [Home Assistant Core `persistent_notification/get` and service source](https://github.com/home-assistant/core/blob/dev/homeassistant/components/persistent_notification/__init__.py)

### Repairs

Read current repair issues with:

```json
{
  "id": 3,
  "type": "repairs/list_issues"
}
```

Use the returned `issues` array. The identity is the pair `domain` and
`issue_id`; `issue_id` alone is not globally unique. Relevant fields are
`domain`, `issue_id`, `severity`, `is_fixable`, `ignored`,
`breaks_in_ha_version`, `learn_more_url`, `translation_key`, and
`translation_placeholders`.

Mission Control excludes `ignored: true` issues from notifications and active
IDs. Ignoring an issue sends all required fields at the top level:

```json
{
  "id": 4,
  "type": "repairs/ignore_issue",
  "domain": "some_integration",
  "issue_id": "manual_migration",
  "ignore": true
}
```

Mission Control does not execute repair flows. `is_fixable: true` changes the
primary link label to **Fix in Home Assistant**, but the destination remains
the Home Assistant Repairs page.

Home Assistant's issue payload does not provide a localized ready-to-display
title. Mission Control must not fabricate one from an unavailable translation
catalog. Use `Repair required: {humanized domain}` as the title, show a
humanized `translation_key` plus safe placeholder key/value pairs as supporting
detail, and provide Home Assistant or `learn_more_url` as the authoritative
detail destination.

Authoritative references:

- [Repairs developer documentation](https://developers.home-assistant.io/docs/core/platform/repairs/)
- [Home Assistant Core repairs WebSocket source](https://github.com/home-assistant/core/blob/dev/homeassistant/components/repairs/websocket_api.py)

## Product model and identity

### Connector naming

- **Source type:** always `Home Assistant`.
- **Primary visible source:** the connector instance display name, such as
  `Lake House` or `City Condo`.
- **Setup default:** `Home Assistant`; prompt for a location-specific name as
  soon as another Home Assistant instance exists.
- New and renamed Home Assistant instances must have a non-empty,
  case-insensitively unique display name among active Home Assistant instances.
- Do not derive the visible name from a hostname or expose an internal instance
  ID on cards.
- Legacy duplicate names remain valid. Settings and filter menus disambiguate
  them with the normalized hostname as secondary text until the user renames
  them; notification cards still lead with the saved display name.

Every Home Assistant notification carries:

```ts
{
  connectorType: 'home-assistant';
  connectorInstanceId: string;
  metadata: {
    sourceName: string;       // connector instance display name
    sourceType: 'Home Assistant';
    haSource: 'entity_rule' | 'updates' | 'persistent_notifications' | 'repairs';
  };
}
```

The provider presentation sets `sourceName` to the connector instance display
name. The Home Assistant icon and source-type label remain visible in detail,
tooltips, and filters so `Lake House` is not mistaken for a separate connector
brand.

### Filtering

The Notifications filter model exposes:

- **Source type:** Home Assistant - includes every instance.
- **Instance:** one option per connector instance, labeled by display name with
  `Home Assistant` as supporting text.
- **Home Assistant source:** Entity alerts, Updates, Persistent notifications,
  or Repairs.

Filters compose with existing level, state, and category filters. Outbound
summary deliveries do not create filterable inbox records. Filter state uses
immutable connector instance IDs, not display names, so renaming an instance
does not break saved views.

## Onboarding and editing

### Add flow

Use the existing Add Connector modal and connector detail patterns. Do not
introduce a separate Home Assistant wizard route.

1. **Identify**
   - Display name, required.
   - Home Assistant URL, required; strip trailing slashes.
   - Long-Lived Access Token, required and masked.
2. **Test**
   - Verify REST authentication with the existing service/state probe.
   - Verify WebSocket authentication.
   - Probe enabled read commands independently:
     `persistent_notification/get` and `repairs/list_issues`.
   - Report one row per source: Available, Permission required, Unsupported, or
     Unreachable. Do not claim mutating permission was tested.
3. **Choose sources**
   - Existing entity alerts: on.
   - Updates: on.
   - Persistent notifications: on when its read command succeeds.
   - Repairs: on when its read command succeeds.
   - Routine update push delivery: daily summary.
   - Allow confirmed Home Assistant actions: off until explicitly enabled.
4. **Review and save**
   - Summarize the instance name, hostname, enabled sources, outbound delivery
     behavior, and whether actions are allowed.
   - Save is allowed when REST authentication succeeds and at least one enabled
     source is readable. Unavailable optional sources remain off with a reason.

The final action opt-in text is:

> Allow Mission Control to install or skip updates, ignore repairs, and dismiss
> persistent notifications. Every action asks for confirmation.

### Edit flow

- Show the saved display name, normalized URL, source settings, last successful
  test, last sync per source, and action opt-in.
- Never reveal the saved token. The token field reads `Saved` and only supports
  replacement.
- Display-name and source-setting changes do not require a connection retest.
- URL or token changes require a successful test before Save.
- Turning a source off stops fetching it. After the next successful connector
  cycle, unresolved notifications owned by that source become resolved with
  reason `source_disabled`; history is retained.
- Turning actions off removes mutating actions from cards immediately without
  resolving the underlying notifications.
- Deleting one connector instance affects only records with that
  `connectorInstanceId`.

## Per-source settings contract

Settings remain in the connector's JSON settings blob; no database migration is
required. Normalize to this versioned shape when a connector is saved:

```ts
interface HomeAssistantConfig {
  settingsVersion: 2;
  baseUrl: string;
  entityPatterns: string[];
  alertRules: AlertRule[];
  sources: {
    entityAlerts: {
      enabled: boolean; // default true
    };
    updates: {
      enabled: boolean; // default true
      criticalEntityPatterns: string[];
    };
    persistentNotifications: {
      enabled: boolean; // default true
      criticalNotificationPatterns: string[];
    };
    repairs: {
      enabled: boolean; // default true
    };
  };
  actions: {
    enabled: boolean; // default false until user opts in
  };
  outboundDelivery: {
    updatePush: 'immediate' | 'daily_summary' | 'off'; // default 'daily_summary'
    dailySummaryTime: string; // local HH:mm, default '08:00'
    immediateCriticalUpdates: boolean; // default true
    immediateActionNeededRepairs: boolean; // default true
    immediateUrgentEntityAlerts: boolean; // default true
    immediateCriticalPersistentNotifications: boolean; // default true
  };
}
```

Default `criticalEntityPatterns`:

```text
update.home_assistant_core_update
update.home_assistant_supervisor_update
update.home_assistant_operating_system_update
```

Default `criticalNotificationPatterns` is empty. Patterns use the existing
case-sensitive glob matcher and are matched only against the documented
identifier (`entity_id` or `notification_id`). Settings copy explains that
"critical" means mapping to Action needed and, when enabled, bypassing the
scheduled outbound summary with an immediate push. It does not mean Mission
Control verified a security advisory.

## Ingestion architecture

### Poll plan

For each enabled connector instance and polling cycle:

1. Fetch REST states once if entity alerts or updates are enabled.
2. Evaluate existing entity rules from that response.
3. Transform `update.*` states from that response.
4. If persistent notifications or repairs are enabled, open one authenticated
   WebSocket session and issue each enabled command independently.
5. Normalize each successful source into notifications and source-scoped active
   IDs.
6. Persist/upsert notifications and reconcile only the sources that completed
   successfully.
7. Record source-level counts, duration, and failures, then close the WebSocket.

One source failing must not discard successful results from another source. A
failed source returns "reconciliation unavailable" rather than an empty active
set, preventing false resolution.

Suggested modules:

```text
src/lib/connectors/home-assistant/
  index.ts
  ha-client.ts
  ha-ws-client.ts
  source-result.ts
  sources/
    updates.ts
    persistent-notifications.ts
    repairs.ts
  notification-provider.ts
```

`ha-ws-client.ts` owns authentication, command IDs, response correlation,
timeouts, safe error normalization, and connection closure. Source modules own
payload validation and notification mapping. The provider owns presentation
and the allowlisted actions.

### Source result contract

Do not overload `null` and `[]` across independent sources. Each source returns:

```ts
type HomeAssistantSourceResult = {
  source: 'entityAlerts' | 'updates' | 'persistentNotifications' | 'repairs';
  status: 'ok' | 'disabled' | 'permission_denied' | 'unsupported' | 'unreachable' | 'invalid_response';
  notifications: InboundNotification[];
  activeSourceIds: string[] | null; // null means do not reconcile this source
  durationMs: number;
  errorCode?: string;
};
```

`activeSourceIds` is an empty array only after a successful fetch that proves
there are no active records or when an explicit local source-disable setting
authoritatively retires that source. Existing entity alerts should be adapted
to the same source-scoped result before new sources are added.

## Notification contracts

### Stable identities

Prefix every source ID with the connector instance so two homes can never
collide:

| Source | Stable source ID |
|---|---|
| Entity rule | Existing identity, namespaced by `connectorInstanceId` if not already |
| Individual update | `ha:{instanceId}:update:{entityId}:{latestVersion}` |
| Persistent notification | `ha:{instanceId}:persistent:{notificationId}` |
| Repair | `ha:{instanceId}:repair:{domain}:{issueId}` |

Components must encode reserved characters when constructing IDs. Original
identifiers remain separately in metadata for API calls.

### Severity mapping

| Source condition | Notification level | Category | Decision |
|---|---|---|---|
| Routine update | `fyi` | `system` | One notification per entity/version |
| Update entity matches a critical pattern | `action_needed` | `system` | Individual; eligible for immediate push |
| Update has `in_progress: true` | `heads_up` | `system` | Progress state, not a request to act |
| Repair severity `critical` | `urgent` | `system` | Home Assistant reserves this for true panic |
| Repair severity `error` | `action_needed` | `system` | Something is currently broken |
| Repair severity `warning` | `heads_up` | `system` | Something will break in the future |
| Persistent notification default | `heads_up` | `home` | Home Assistant asks the user to notice it |
| Persistent ID matches a critical pattern | `action_needed` | `automation` | Explicit user escalation |
| Existing entity rules | unchanged | unchanged | Preserve current behavior |

Unknown repair severities map to `heads_up` and record the raw value. No source
is promoted because its title contains words such as "security", "CVE",
"vulnerability", or "critical". AI enrichment must not alter these source-owned
levels.

### Updates

#### Individual update

- Title: `Update available: {title}`.
- Subtitle: connector instance display name.
- Stats: `{installed_version} -> {latest_version}`.
- Detail: sanitized `release_summary`, entity ID, and last observed time.
- Progress: when `in_progress` is true, show `Installing` and a progress bar
  only when `update_percentage` is finite and between 0 and 100.
- Primary action: **Install update** when install is supported and actions are
  enabled.
- Secondary actions: **Skip this version** when allowed, **Release notes** when
  a valid URL exists, **Open in Home Assistant**, and generic **Create task**.

#### Outbound update summary

- Every update remains an individual inbox notification, regardless of outbound
  delivery preference.
- `daily_summary` suppresses routine per-item push delivery until the configured
  local time, then sends at most one push per connector instance summarizing the
  currently active routine updates.
- The push title is `{count} updates available at {instanceName}`. Its body lists
  the first three update titles in stable alphabetical order, then
  `+{remaining} more`.
- Opening the push deep-links to Notifications filtered to that connector
  instance and Home Assistant source `Updates`.
- The summary is a delivery event only. It never creates, replaces, resolves, or
  groups Mission Control notification records.
- Critical-pattern matches remain individual notifications and may push
  immediately when the corresponding trigger is enabled.
- `immediate` permits routine per-item pushes. `off` suppresses routine update
  pushes while leaving every update visible and actionable in Notifications.
- A directly installed or skipped update resolves only its own notification on
  the next authoritative poll and is absent from later summaries.

### Persistent notifications

- Title: Home Assistant `title`, falling back to `Home Assistant notification`.
- Body: Home Assistant `message`, rendered as plain text or the application's
  safe Markdown subset; raw HTML is never rendered.
- Metadata: `notification_id`, `created_at`, and source fields.
- Primary action: **Open in Home Assistant**.
- Secondary action: **Dismiss in Home Assistant** when actions are enabled.
- Generic **Create task** remains available.
- A matching critical pattern changes only level/category, not content or
  action behavior.

### Repairs

- Title: `Repair required: {humanized domain}`.
- Subtitle: connector instance display name.
- Body: humanized `translation_key`; append a compact list of sanitized
  translation placeholders when present.
- Metadata chips: severity, domain, `breaks_in_ha_version` when present, and
  Fixable when true.
- Primary action: **Fix in Home Assistant** when `is_fixable`, otherwise
  **Open in Home Assistant**.
- Secondary actions: **Learn more** for a valid `learn_more_url`, **Ignore in
  Home Assistant** when actions are enabled, and generic **Create task**.
- An ignored issue is not active in Mission Control. It may reappear only when
  Home Assistant deletes and recreates it or reports `ignored: false`.

## Action safety and interaction contract

### General rules

- Resolve the connector by the notification's stored `connectorInstanceId`.
- Reject the action if the connector is deleted, disabled, a different type, or
  no longer owns the notification.
- Read entity, notification, repair, and version identifiers only from
  server-stored metadata. Client input may contain only confirmation options
  such as `backup`.
- Allowlist exact provider action types and exact Home Assistant
  domain/service pairs. Never accept arbitrary domain, service, URL, or entity
  input from the browser.
- Require `actions.enabled` at execution time, not only when rendering buttons.
- Allow one mutating action in flight per notification. A repeated or concurrent
  request returns conflict rather than invoking Home Assistant twice.
- Validate the current upstream item before mutation. If it no longer exists or
  its offered version changed, return stale conflict and reconcile the card.
- Confirmation is required for Install, Skip, Ignore, and Dismiss. Open URL and
  Create task keep their existing behavior.

### Confirmation copy

| Action | Confirmation content |
|---|---|
| Install | `Install {latestVersion} for {title} at {instanceName}?` plus installed version; show `Create a backup first` unchecked only when supported |
| Skip | `Skip {latestVersion} for {title} at {instanceName}?` and `It will appear again when a newer version is available.` |
| Ignore repair | `Ignore this repair at {instanceName}?` and `Home Assistant will hide it until the issue is removed and created again.` |
| Dismiss persistent notification | `Dismiss "{title}" at {instanceName}?` and `This also removes it from Home Assistant.` |

Use the shared confirmation dialog, not `window.confirm`, because install needs a
conditional backup control and all actions need structured error and focus
handling.

### Action request shapes

| Provider action | Upstream request |
|---|---|
| `ha_install_update` | REST `POST /api/services/update/install`; service-data body contains stored `entity_id` and optional supported `backup` |
| `ha_skip_update` | REST `POST /api/services/update/skip`; service-data body contains stored `entity_id` |
| `ha_ignore_repair` | WS `repairs/ignore_issue` with top-level `domain`, `issue_id`, and `ignore: true` |
| `ha_dismiss_persistent_notification` | REST `POST /api/services/persistent_notification/dismiss` with `notification_id` |

### Pending, success, and failure states

| State | Card/detail behavior | User message | Lifecycle |
|---|---|---|---|
| Confirmation open | Focus trapped in dialog; destructive action named with instance and target | Action-specific copy above | No request sent |
| Pending | Selected action shows spinner; all mutating actions disabled; navigation remains available | `Sending to {instanceName}...` via polite live region | Notification stays active |
| Install accepted | Card changes to Installing; show percentage when available | `Installation started in {instanceName}` | Immediate targeted refresh, then normal polls |
| Skip/ignore/dismiss accepted | Card marks handled and exits the active list after refresh | `{Action} completed in {instanceName}` | Resolve only after upstream refresh confirms absence/inactive state |
| Permission denied | Keep card and actions; show persistent inline error with settings link | `Your Home Assistant token cannot perform this action.` | Connector source health records permission error |
| Unsupported | Remove or disable invalid action after refresh | `This item does not support {action}.` | Notification remains if condition remains |
| Stale/conflict | Disable stale action and refresh source | `This changed in Home Assistant. The notification has been refreshed.` | Reconcile current upstream state |
| Unreachable/timeout | Keep card and make action retryable | `Could not reach {instanceName}. Try again.` | Do not resolve |
| Invalid response | Keep card; generic retry plus diagnostic code | `Home Assistant returned an unexpected response.` | Do not resolve |
| Resolved elsewhere | Remove from active list with no failure toast | `Already handled in Home Assistant` in history/detail | Mark resolved |

An HTTP or WebSocket success means Home Assistant accepted the command, not that
an installation completed. Never display `Update installed` until a later state
shows the update is no longer available.

## Layout and responsive behavior

### Desktop

- Notification rows lead with instance display name, then source type and
  source-specific metadata.
- The detail panel contains the full body, version/progress or repair metadata,
  source timestamps, and the complete action set.
- Each update opens its own detail and action lifecycle. An outbound summary
  deep-links to the existing filtered notification list rather than opening a
  second summary-detail surface.
- Settings show each Home Assistant instance as a separate connector card.
  Expanded settings group Connection, Sources, Attention, and Actions.

### Mobile

- The first card line is the notification title; the second begins with the
  instance display name.
- Only the primary action appears inline. All secondary actions are in the
  detail sheet's action group with full labels.
- Confirmation uses a bottom sheet or full-screen dialog with the same content
  and default choices as desktop.
- A summary push opens the normal mobile notification list already filtered to
  that Home Assistant instance and Updates.
- Long instance names, entity IDs, versions, and repair keys wrap or truncate
  with an accessible full-value label; they never force horizontal scrolling.

### Responsive invariants

- Source attribution is never removed to save space.
- Severity is never color-only.
- Progress is accompanied by text.
- Action availability and confirmation behavior are identical across
  breakpoints.
- At 320 CSS pixels, the primary action and overflow control remain reachable
  without overlap.

## Accessibility

- Follow WCAG 2.2 AA and the application design system.
- Every icon-only control has an accessible name that includes its action and,
  where ambiguity exists, the target instance.
- Confirmation dialogs have a programmatic title/description, initial focus on
  Cancel, focus trapping, Escape-to-cancel, and focus restoration.
- Pending and result messages use a polite live region; urgent repair content
  does not force an assertive announcement on page load.
- Disabled actions expose the reason in adjacent text or an accessible
  description, not only a tooltip.
- Update cards are semantic list items; version pairs and progress remain
  readable to screen readers. Summary push copy announces the count and
  instance name.
- Source, severity, progress, and outcome use text or icons in addition to
  color.
- Reduced-motion mode removes card exit movement and progress animation while
  preserving state changes.

## Credentials and trust boundaries

- Keep each token in the existing server-side connector credentials store.
- Return only `hasCredentials`/`Saved` to the browser; never return, prefill,
  serialize into notification metadata, or place the token in a URL.
- Redact authorization headers, auth frames, connector credential payloads, and
  query strings from logs and action audit records.
- Send the token only to the normalized configured Home Assistant origin.
  Redirects must not forward authorization to another origin.
- Recommend HTTPS. Allow HTTP only for explicitly local/private deployments and
  show a non-blocking transport warning.
- Reject non-HTTP(S) base URLs and derive WebSocket protocol internally.
- Treat titles, messages, placeholders, release summaries, and URLs as untrusted
  upstream content. Escape text and validate links before rendering.
- The action provider looks up current server-side credentials per request; it
  never trusts credentials or instance identity from the client.

## Failure and degraded behavior

- A REST failure degrades entity alerts and Updates but does not automatically
  resolve either source.
- A WebSocket authentication/connection failure degrades Persistent
  notifications and Repairs while preserving their active notifications.
- A command-specific error degrades only that source. For example,
  `repairs/list_issues` failing must not suppress successful persistent
  notifications from the same WebSocket session.
- Invalid individual records are skipped, counted, and sampled in redacted
  diagnostics; valid sibling records continue.
- `unknown` or `unavailable` update entities do not create update-available
  notifications and do not prove an existing notification resolved. Preserve
  the prior occurrence until a successful authoritative `on` or `off` state.
- If all enabled sources fail, the connector sync fails. If at least one
  succeeds, the connector reports degraded success with source-level detail.
- Reconciliation is scoped by connector instance and source. A Lake House
  failure can never resolve City Condo notifications.
- Polling and action failures never replace a real notification with a
  success-shaped fallback.

## Observability

Each connector poll records:

- connector instance ID and display name;
- enabled source;
- transport (`rest` or `websocket`);
- status and stable error code;
- duration;
- fetched, emitted, updated, and resolved counts;
- active update count and outbound summary candidate/sent/suppressed counts;
- invalid-record count; and
- WebSocket close/timeout outcome.

Each mutating action records:

- notification ID, action ID/type, connector instance ID, and source;
- redacted target identity (`entity_id`, repair `domain`/`issue_id`, or
  `notification_id`);
- requested/started/completed timestamps;
- upstream status class and stable error code;
- whether backup was requested; and
- final Mission Control lifecycle transition.

Do not record tokens, notification bodies, repair placeholders, release text,
or complete upstream error bodies. Connector health shows per-source status and
last successful sync so a healthy REST source cannot hide a broken WebSocket
source.

## Migration and compatibility

- No database schema migration is required; settings use the existing JSON blob.
- Missing `settingsVersion` is read as version 1.
- Existing `entityPatterns` and `alertRules` are preserved byte-for-byte after
  validation.
- For existing connectors, all three new read sources default on, update push
  delivery defaults to a daily summary at 08:00 local time, immediate critical
  triggers default on, and mutating actions default off until the user opts in.
- Default critical update patterns are applied only when the setting is absent.
  An explicitly saved empty array means no critical update overrides.
- Existing notification source IDs and entity-rule behavior remain stable.
- New Home Assistant notifications always include instance attribution.
- Existing duplicate connector names are not silently rewritten.
- Rollback is safe: older code ignores unknown settings fields, while new source
  notifications remain ordinary notification records.

## Phased delivery

### Phase 0 - contract and fixtures

- Finalize normalized source result, v2 settings, metadata, source IDs, and
  provider action payloads.
- Add representative fixtures for two instances, update capabilities/progress,
  persistent notifications, repairs, malformed payloads, and partial failures.

### Phase 1 - #1706 Updates slice

- Ingest `update.*` states from the existing REST fetch.
- Ship individual update notifications, per-instance outbound summaries, and
  immediate critical-pattern push delivery.
- Present versions, progress, release links, Install, Skip, and supported backup.
- Add source settings and update-specific tests.

### Phase 2 - shared WebSocket transport and persistent notifications

- Add bounded authenticated WebSocket request/response client.
- Ingest with `persistent_notification/get`.
- Add dismissal and lifecycle reconciliation.

### Phase 3 - repairs

- Ingest with `repairs/list_issues`.
- Map authoritative severity.
- Add exact `repairs/ignore_issue` payload and Home Assistant repair links.

### Phase 4 - multi-instance UX and hardening

- Complete add/edit/test flows, unique naming, source/instance filters, and
  connector-health detail.
- Complete responsive, accessibility, degraded-mode, audit, and migration
  coverage.
- Run the full acceptance matrix and close the canonical epic.

Phases may merge separately, but no phase may weaken the source-scoped
reconciliation or action-safety contracts.

## Acceptance and test matrix

| Area | Scenario | Expected result |
|---|---|---|
| Multi-instance | Two servers expose the same entity and notification IDs | Separate cards/actions, each using the correct token and display name |
| Naming | Add a second instance with a case-insensitive duplicate name | Save blocked with a clear uniqueness error |
| Filters | Rename an instance used by a saved filter | Filter still works because it stores instance ID |
| Updates | Routine updates on two instances in one cycle | One individual notification per entity/version with no cross-instance collision |
| Updates | One update disappears next poll | Only that update notification resolves; unrelated updates remain active |
| Delivery | Daily summary enabled with six routine updates | Six inbox notifications remain; one push summary deep-links to the filtered list |
| Delivery | Push delivery off | Individual inbox notifications remain and no routine update push is sent |
| Updates | Critical pattern match | Individual `action_needed` card and immediate push when that trigger is enabled |
| Updates | Title mentions "security" but no pattern matches | Routine level; no inferred escalation |
| Updates | `in_progress: true`, percentage present | `heads_up` Installing state with bounded percentage |
| Updates | `unknown`/`unavailable` after an active occurrence | Existing occurrence preserved; source marked degraded |
| Install | Install unsupported | Action absent |
| Install | Backup unsupported | Confirmation has no backup control and request omits `backup` |
| Install | Backup supported | Optional unchecked backup control; request reflects choice |
| Install | Home Assistant accepts request | Message says installation started, not installed |
| Skip | Auto-update entity | Skip absent |
| Skip | Current version skipped | Resolves after refresh; newer version creates a new occurrence |
| Persistent | `/api/states` contains no persistent-notification entities | WebSocket result still ingested correctly |
| Persistent | Dismiss succeeds | REST service receives stored `notification_id`; card resolves after refresh |
| Repairs | Two domains share an `issue_id` | Distinct notifications and actions |
| Repairs | Ignore action | WS payload has top-level `domain`, `issue_id`, `ignore: true` |
| Repairs | Ignored issue remains in list with `ignored: true` | Excluded from active IDs and resolved |
| Repairs | Unknown severity | `heads_up`, raw severity retained for diagnostics |
| Stale action | Target disappears or update version changes before confirm | 409-style stale result, refresh, no wrong-target mutation |
| Permission | Read works but action is denied | Card retained with actionable permission error |
| Partial failure | Repairs fails while persistent notifications succeeds | Repairs preserved, persistent source reconciled, connector degraded |
| Full failure | Instance unreachable | No source auto-resolves |
| Source toggle | Disable Repairs | Existing repair cards resolve only after next successful connector cycle |
| Action toggle | Disable actions | Mutating buttons disappear immediately; notifications remain |
| Security | Client tampers with entity/domain/ID | Server ignores/rejects client target and uses stored metadata |
| Accessibility | Keyboard-only confirmation/action flow | Focus order, Cancel-first dialog, status announcement, and restoration pass |
| Responsive | 320 px viewport with long names/versions | No horizontal scroll; attribution and primary action remain available |
| Migration | Existing v1 connector starts after deployment | Entity alerts unchanged; new reads on; daily push summary on; actions off |

Automated coverage should include source transformer unit tests, WebSocket
protocol tests with out-of-order IDs and timeouts, provider action tests,
source-scoped reconciliation tests, settings migration tests, notification-card
interaction tests, and one end-to-end two-instance flow.

## Issue reconciliation

| Issue | Role and disposition |
|---|---|
| [mission-control#1756](https://github.com/rsocko/mission-control/issues/1756) | Canonical epic for this complete specification and phased delivery |
| [mission-control#1706](https://github.com/rsocko/mission-control/issues/1706) | First implementation slice: Phase 1 Updates ingestion, presentation, and actions |
| [mission-control#627](https://github.com/rsocko/mission-control/issues/627) | Reopened for the missing end-to-end device-state-alert-to-Notifications setup and presentation slice |
| [rsocko/ideation#1421](https://github.com/rsocko/ideation/issues/1421) | Closed as a duplicate of #1756 with the canonical link |
| [mission-control#133](https://github.com/rsocko/mission-control/issues/133) | Correctly closed: base Home Assistant entity-alert ingestion shipped; do not reopen |
| [mission-control#1297](https://github.com/rsocko/mission-control/issues/1297) | Correctly closed: homelab alert routing is separate from this pull-based expansion; do not reopen |

## Definition of done

- Two Home Assistant connector instances operate concurrently with unmistakable
  attribution and independent settings, credentials, health, and actions.
- Updates, persistent notifications, and repairs use the authoritative
  transports and payloads in this specification.
- Routine updates are individual canonical notifications. Daily summaries are
  outbound push deliveries only, and immediate critical escalation occurs only
  through explicit patterns and enabled delivery triggers.
- All supported actions are allowlisted, confirmed, capability-gated,
  stale-safe, and observable.
- Resolution occurs only after successful source evidence; failures never clear
  active work.
- Desktop, mobile, keyboard, screen-reader, and narrow-width acceptance cases
  pass.
- Migration preserves existing entity alerts and keeps new mutating actions off
  until the user opts in.
- #1706 completes the first implementation slice, #1756 remains canonical until
  all phases pass, and duplicate/fulfilled issues are closed as described above.
