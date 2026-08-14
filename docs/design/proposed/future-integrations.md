---
title: "Future Integrations"
status: proposed
created: 2026-07-10
last_reviewed: 2026-07-22
category: design
related:
  - "[Connector Expansion Review](CONNECTOR-EXPANSION-REVIEW.md)"
  - "[Connector Settings](CONNECTOR-SETTINGS-DESIGN.md)"
  - "[External Agent Integration](EXTERNAL-AGENT-INTEGRATION-DESIGN.md)"
  - "[Webhook Sync (Future)](WEBHOOK-SYNC-FUTURE.md)"
mockups: []
---

# Future Integration Considerations

> These are potential integrations for future evaluation. None are currently scheduled for implementation.

---

## Overview

Mission Control's connector architecture is extensible via the `IConnector` interface and the `custom-rest` generic adapter. The integrations below represent high-value candidates identified during design reviews, organized by priority tier.

---

## Tier 1 — High Value / Low-Medium Effort

### Pushover / Ntfy — Mobile Push Notifications

| | |
|---|---|
| **What it does** | Sends push notifications to phone/watch for critical MC alerts instead of relying on in-app only |
| **Effort** | Low |
| **Value** | High — time-sensitive alerts (security, overdue bills, package delivered) need mobile reach |
| **Integration pattern** | Outbound-only — subscribe to MC events via the existing outbound webhook system |
| **Implementation** | Add as an outbound webhook target in Settings, or build a lightweight `NotificationChannel` abstraction that routes critical/high alerts to Pushover/Ntfy API |
| **APIs** | Pushover: `POST https://api.pushover.net/1/messages.json` (simple key+message). Ntfy: `POST https://ntfy.sh/{topic}` (even simpler, self-hostable) |
| **Notes** | Could be done TODAY via n8n outbound webhook → Pushover node. A dedicated MC integration would provide per-severity routing and quiet hours. |

---

### Home Assistant + Grocy — Grocery/Inventory Alerts

| | |
|---|---|
| **What it does** | Low-stock alerts from Grocy (grocery/household inventory) → shopping tasks in MC |
| **Effort** | Low (builds on existing HA connector) |
| **Value** | Medium — automates "we're out of X" → task creation |
| **Integration pattern** | HA connector already monitors entities; Grocy exposes sensors via HA integration |
| **Implementation** | Add entity patterns for `sensor.grocy_*` to HA connector config. Map low-stock sensors to tasks (not just alerts). Alternatively, Grocy has its own REST API (`GET /api/stock/volatile`) |
| **APIs** | Grocy REST: `GET {grocy_url}/api/stock/volatile` returns expiring/below-min-stock items. HA integration exposes these as sensors. |
| **Notes** | Consider whether shopping tasks should go to Microsoft Todo (via write-back) or stay in MC. Likely best as "create task in MS Todo shopping list" action. |

---

### MQTT via n8n — IoT Event Bridge

| | |
|---|---|
| **What it does** | Receives IoT events (doorbell ring, motion detection, package at door, washer done) as MC alerts |
| **Effort** | Low (n8n relay pattern, no MC code needed) |
| **Value** | Medium — real-time IoT awareness |
| **Integration pattern** | n8n subscribes to MQTT topics → transforms → POSTs to MC's `/api/integrations/n8n/webhook` |
| **Implementation** | Zero MC code — configure n8n workflows: MQTT trigger → HTTP Request to MC inbound webhook |
| **Example workflows** | - `zigbee2mqtt/doorbell` → alert "Someone at front door" (critical) <br> - `washer/status` → alert "Washer cycle complete" (low) <br> - `frigate/events` → alert "Person detected: driveway" (medium) |
| **Notes** | Already achievable with current n8n integration. Document recommended n8n workflow templates. |

---

## Tier 2 — Medium Value / Medium Effort

### Notion — Pages/Databases as Tasks

| | |
|---|---|
| **What it does** | Syncs Notion database items as tasks or links Notion pages to MC projects |
| **Effort** | Medium |
| **Value** | Medium — only relevant if Notion is actively used for task/project tracking |
| **Integration pattern** | Connector with read (poll database) + optional write-back (update status) |
| **Implementation** | Notion API (`POST https://api.notion.com/v1/databases/{id}/query`) returns pages with properties. Map properties → MC task fields (title, status, priority, due date). |
| **APIs** | Notion Integration API v1 — requires internal integration token + database sharing |
| **Challenges** | Notion's schema is user-defined (properties vary per database). Would need a field mapping UI similar to Custom REST connector. |
| **Notes** | Consider whether the Custom REST connector could handle this with proper config, or if Notion's auth/pagination patterns warrant a dedicated connector. |

---

### Google Calendar — Personal Calendar Sync

| | |
|---|---|
| **What it does** | Surfaces Google Calendar events as alerts alongside Outlook Calendar |
| **Effort** | Low-Medium |
| **Value** | Depends on usage — high if personal calendar is Google while work is Outlook |
| **Integration pattern** | Mirror the existing Outlook Calendar connector pattern |
| **Implementation** | Google Calendar API v3: `GET https://www.googleapis.com/calendar/v3/calendars/{id}/events`. OAuth2 with Google. Alert generation logic identical to Outlook Calendar connector. |
| **APIs** | Google Calendar API v3 + OAuth2 (`@googleapis/calendar` npm package) |
| **Challenges** | Google OAuth2 requires a GCP project + consent screen. More setup friction than MS Graph. |
| **Notes** | If only one Google Calendar, could also subscribe via iCal URL import (lower fidelity but zero auth). |

---

### Linear / Jira — Work Project Management

| | |
|---|---|
| **What it does** | Syncs work issues/tickets as MC tasks alongside personal GitHub issues |
| **Effort** | Medium |
| **Value** | Depends on work context — high if daily work involves Linear/Jira |
| **Integration pattern** | Similar to GitHub Issues connector — read issues, write-back status |

#### Linear
| | |
|---|---|
| **API** | GraphQL at `https://api.linear.app/graphql` with personal API key |
| **Features** | Issues, projects, cycles, labels. Clean API, good TypeScript SDK. |
| **Mapping** | Issue → Task, Project → Hub Project linkage, Labels → Tags |

#### Jira
| | |
|---|---|
| **API** | REST v3 at `https://{instance}.atlassian.net/rest/api/3/` |
| **Features** | Issues, boards, sprints, custom fields |
| **Mapping** | Issue → Task, Project → Hub Project, Sprint → source list |
| **Challenges** | Jira's data model is extremely complex (custom fields, workflows, schemes). Would need significant field mapping config. |

---

### Todoist — Cross-Platform Task Sync

| | |
|---|---|
| **What it does** | Syncs Todoist tasks for users who share lists with Todoist-using family/collaborators |
| **Effort** | Medium |
| **Value** | Low unless collaborative task sharing is needed |
| **Integration pattern** | Full CRUD connector (like Microsoft Todo) |
| **Implementation** | Todoist REST API v2: `GET https://api.todoist.com/rest/v2/tasks`. API token auth. Supports projects, labels, priorities, due dates, comments. |
| **APIs** | Todoist REST API v2 + Sync API (for real-time via webhooks) |
| **Notes** | Consider whether the "move task" feature (moving from Todoist → MS Todo) would be more useful than bidirectional sync. |

---

## Integration Architecture Patterns

All future connectors should follow one of these proven patterns:

### Pattern A: Full Connector (IConnector interface)
Best for: Sources that produce tasks/alerts AND support write-back.
Examples: Microsoft Todo, GitHub Issues, Linear, Todoist, Notion.

### Pattern B: Alert-Only Connector
Best for: Sources that produce alerts/notifications but don't accept write-back.
Examples: Outlook Calendar, Outlook Email, Home Assistant, RyMessage.

### Pattern C: Bridge Connector
Best for: Complex source systems where another app owns the intelligence and MC is the aggregation layer.
Examples: Finance Manager, Document Intelligence Hub.

### Pattern D: n8n Relay (Zero MC Code)
Best for: IoT events, webhooks from services without dedicated connectors, quick prototypes.
Examples: MQTT, Pushover/Ntfy outbound, one-off service integrations.

### Pattern E: Outbound Channel
Best for: Notification delivery to external systems (not data sources).
Examples: Pushover, Ntfy, Slack, Email digest, SMS.

---

## Decision Criteria for New Integrations

When evaluating whether to build a new connector:

1. **Daily use?** — Will you interact with this data source daily? (If not, n8n relay is fine)
2. **Write-back needed?** — Do you need to update the source from MC? (If yes, full connector)
3. **Custom REST sufficient?** — Can the generic REST connector handle it with field mapping?
4. **n8n available?** — Can n8n bridge this without MC code? (Preferred for low-frequency sources)
5. **Existing experiment?** — Is there already a dedicated app for this (like Finance Manager, Doc Intel)? If so, use Bridge pattern.

---

## See Also

- [SHIPMENT-TRACKING-DESIGN.md](./SHIPMENT-TRACKING-DESIGN.md) — Design for delivery tracking (implemented via HA connector)
- [WEBHOOK-SYNC-FUTURE.md](./WEBHOOK-SYNC-FUTURE.md) — Direct webhook receivers (deferred)
- `experiments/personal-automation/finance-management/docs/CROSS-SYSTEM-INTEGRATION.md` — Finance × Paperless × MC integration architecture
