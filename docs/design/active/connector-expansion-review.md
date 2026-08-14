---
title: "Connector Expansion — Status Review & Gap Analysis"
status: review
created: 2026-07-12
category: design
author: "@contributor + Copilot"
related:
  - "[Connector Settings](CONNECTOR-SETTINGS-DESIGN.md)"
  - "[Task Sync Integration](../reference/TASK-SYNC-INTEGRATION.md)"
  - "[Future Integrations](FUTURE-INTEGRATIONS.md)"
  - "[Kanban Column Mapping](KANBAN-COLUMN-MAPPING-DESIGN.md)"
mockups: []
---

# Connector Expansion — Status Review & Gap Analysis

---

## Overview

Mission Control's connector architecture is built on the `IConnector` interface with a `ConnectorRegistry` factory pattern. All connectors share a common lifecycle (initialize → testConnection → fetchTasks/fetchAlerts → optional write-back → sync tokens → webhooks), and are stored in the `connectorConfigs` Drizzle table.

This document reviews all existing connectors, maps them against the planned Connector Expansion roadmap (§4.4), identifies what's done vs outstanding, and provides a gap analysis for the Model Catalog integration.

---

## Connector Inventory

### Built & Registered (10 connectors)

| # | Connector | Type ID | Read | Write | Delete | Subtasks | Tags | Lists | Where It Surfaces |
|---|-----------|---------|:----:|:-----:|:------:|:--------:|:----:|:-----:|-------------------|
| 1 | Microsoft Todo | `microsoft-todo` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Kanban, My Day timeline (Substrate API), micro-status sync via `mc:*` category tags |
| 2 | GitHub Issues | `github-issues` | ✅ | ✅ | — | ✅ | ✅ | ✅ | Kanban, micro-status as `mc:*` labels, GitHub notifications → alerts |
| 3 | Outlook Calendar | `outlook-calendar` | ✅ | — | — | — | — | ✅ | **Today timeline: calendar meeting overlay** (amber `CalendarEventBlock`), `/api/calendar-events` |
| 4 | Outlook Email | `outlook-email` | ✅ | — | — | — | — | ✅ | Flagged/important emails → triage queue alerts |
| 5 | RyMessage | `rymessage` | ✅ | — | — | — | — | — | AI-extracted iMessage actions → alerts; webhook + REST + SQLite modes |
| 6 | Finance Manager | `finance-manager` | ✅ | ✅ | — | — | ✅ | — | Budget alerts, transaction triage, kid card rules; talks to `monarch-bridge` |
| 7 | Home Assistant | `home-assistant` | ✅ | — | — | — | — | — | Device state → triage alerts; rule engine with cooldowns |
| 8 | Document Intelligence | `document-intelligence` | ✅ | ✅ | — | — | — | — | Bill extraction → tasks; statement tracking → alerts; EOB matching |
| 9 | Custom REST | `custom-rest` | ✅ | cfg | cfg | — | — | cfg | Generic adapter: user-defined field mapping, status/priority maps, custom headers |
| 10 | n8n Webhook | _(route-level)_ | ✅ | — | — | — | — | — | Inbound at `/api/integrations/n8n/webhook`; any n8n workflow pushes alerts/tasks |

**Key:** ✅ = supported, cfg = user-configurable, — = not applicable/supported

### Special Surface: Calendar Meeting Overlay

The Outlook Calendar connector renders uniquely on the **Today view**:

- **Component:** `CalendarEventBlock` in `InteractiveTimeline.tsx`
- **API:** `GET /api/calendar-events?date=YYYY-MM-DD`
- Calendar events appear as **non-interactive amber blocks** on the day timeline
- Tasks render as **draggable cards** around/between calendar events
- Shows subject, start/end time, duration, and location
- Data source: Microsoft Graph API `calendarView`

---

## Expansion Roadmap — Status (§4.4)

### 1. ✅ Home Assistant Alerts — DONE

Fully implemented as `home-assistant` connector in `src/lib/connectors/home-assistant/index.ts`.

- Configurable entity patterns (`sensor.mail_*`, `binary_sensor.*_door*`, `sensor.*_battery`)
- Rule engine with conditions: `equals`, `above`, `below`, `changed`
- Built-in rules: door-open (high), low-battery (medium), motion (low), device-offline (medium)
- Per-rule cooldown support (prevents alert fatigue)
- **Surfaces:** Alerts panel, triage queue, notification badges

### 2. ✅ Document Intelligence — DONE

Fully implemented as `document-intelligence` connector in `src/lib/connectors/document-intelligence/index.ts`.

- Three modules: action queue, statement tracking, EOB matching
- Action types: `pay`, `respond`, `file`, `review`, `sign`, `schedule`
- Bill extraction creates tasks with urgency → MC priority mapping
- Missing statement alerts for overdue recurring documents
- Integrates with Paperless-ngx via sidecar API at `localhost:8200`
- **Surfaces:** Tasks (actionable items), alerts (overdue/missing statements), triage queue

### 3. ✅ Monarch Money — DONE

Fully implemented as `finance-manager` connector (dual-registered as `monarch-money`) in `src/lib/connectors/monarch-money/index.ts`.

- Budget alerts → review tasks via Finance Management bridge app (`monarch-bridge`)
- Kid profiles + card rules + merchant rules in DB schema
- Transaction triage with category management
- **Surfaces:** Finance alerts panel, transaction review in Settings
- **Tests:** `tests/monarch-connector.test.ts`

### 4. ⚠️ Capabilities Enforcement — PARTIALLY DONE

**What exists:**

- `ConnectorCapabilities` type with `read`, `write`, `delete`, `sync`, `subtasks`, `lists`, `tags`, `tagWriteBack` booleans
- Every connector declares its capabilities correctly
- Settings UI renders editable capability checkboxes (Shield icon section)
- Capabilities persisted to DB in `connectorConfigs` table
- Permission probe API at `GET /api/connectors/[id]/permissions`

**What's missing:**

- **No runtime enforcement** — the sync engine (`src/lib/sync/index.ts`) reads capabilities but does not gate write operations against them
- Write-back API routes (`/api/tasks/[id]`, move, complete, delete) do not check `config.capabilities.write` before calling the connector
- UI does not disable write actions (complete button, edit, drag-to-column) when `write: false` is set

**Decision required:** Where to enforce — API route level, sync engine level, UI level, or all three?

### 5. 🔴 Model Catalog — NOT STARTED

No connector exists in Mission Control. See [§ Model Catalog Gap Analysis](#model-catalog--custom-rest-connector-gap-analysis) below.

### 6. ⚠️ PROJECT Import/Sync — PARTIALLY DESIGNED

**What exists:**

- `ProjectProgress` type with task counting and health tracking
- `ProjectPhase` system with AI-suggested phase breakdowns
- Hub projects group tasks from any connector via `hubProjectIds` on `TaskItem`
- GitHub connector syncs GitHub Projects v2 as source lists
- AI refinement routes: `/api/project-phases/ai-suggest`, `/api/project-phases/ai-refine`

**What's missing:**

- No bi-directional project sync (MC project ↔ GitHub Project board)
- No project import wizard ("import from GitHub Project #X")
- No cross-connector project linking UI/workflow
- Model Catalog projects aren't connected

---

## Additional Connectors (Not in §4.4)

| Connector | Status | Notes |
|-----------|--------|-------|
| **Custom REST** | ✅ Built | Generic adapter — field mapping, status/priority maps, custom headers. "Escape hatch" for any REST API. |
| **RyMessage** | ✅ Built | AI-extracted iMessage actions → alerts. Webhook + REST + SQLite modes. Full lifecycle tracking. |
| **n8n Webhook** | ✅ Built | Route-level integration (not a factory connector). Inbound + outbound webhook support. |

---

## Model Catalog ↔ Custom REST Connector: Gap Analysis

### Source System

The Model Catalog sidecar (`hass-bambulab-config/sidecars/model_catalog/`) is a mature FastAPI application with:

- **Unified Queue:** Print queue with 7-state workflow (backlog → up_next → preparing → ready → in_progress → blocked → done)
- **Projects:** Status tracking (evaluating/planning/active/backlog/completed/archived), member states, task backends
- **Intake:** Upload review pipeline (queued → uploading → uploaded_unverified → verified → cleanup_done)
- **Models/Collections:** Full catalog with search, custom fields, keyword tags
- ~60+ test files, no authentication (CORS `*`)

### Can We Use Custom REST Today?

**Almost.** The Unified Queue API is a strong fit for MC's Custom REST connector. The mapping is ~85% ready out of the box.

### Field Mapping: Unified Queue → MC Tasks

| Custom REST Config | Model Catalog API | Status |
|---|---|---|
| `baseUrl` | `http://<homelab>:8200` | ✅ Ready |
| `tasksEndpoint` | `/api/unified-queue/entries` | ✅ Ready |
| `responseTasksPath` | `"entries"` | ✅ Response wraps in `{ "entries": [...] }` |
| `taskMapping.id` | `"queue_entry_id"` | ✅ UUID |
| `taskMapping.title` | `"title"` | ✅ Present |
| `taskMapping.description` | `"queue_notes"` | ✅ Present (nullable) |
| `taskMapping.status` | `"state"` | ✅ 7-value enum |
| `taskMapping.priority` | `"rank"` | ⚠️ Integer sort order, not priority level |
| `taskMapping.dueDate` | _(none)_ | ❌ No native due date fields |
| `taskMapping.createdAt` | `"created_at"` | ✅ ISO 8601 |
| `taskMapping.updatedAt` | `"updated_at"` | ✅ ISO 8601 |
| `listField` | `"source_kind"` | ⚠️ Available but not a traditional list name |
| `headers` | _(none needed)_ | ✅ No auth currently |
| `createEndpoint` | `POST /api/unified-queue/entries` | ✅ Ready |
| `updateEndpoint` | `PATCH /api/unified-queue/entries/:id` | ✅ Ready |
| `deleteEndpoint` | `DELETE /api/unified-queue/entries/:id` | ✅ Ready |

### Status Mapping: Queue State → MC TaskStatus

```
backlog      → todo
up_next      → todo
preparing    → in_progress
ready        → todo
in_progress  → in_progress
blocked      → todo (micro-status: blocked_external)
done         → done
```

### Gaps

| # | Gap | Severity | Resolution |
|---|-----|----------|------------|
| 1 | **No `?updated_since=` filter** | 🟡 Should fix | Add query param to `GET /api/unified-queue/entries` — enables MC incremental sync |
| 2 | **No API key auth** | 🟡 Should fix | Add optional `X-API-Key` header check (env-var gated) for cross-network access |
| 3 | **No alerts endpoint** | 🟡 Nice-to-have | Add `/api/mc/alerts` surfacing blocked items, failed prints, stale intake uploads |
| 4 | **No source lists endpoint** | 🟡 Nice-to-have | Add `/api/mc/lists` returning projects + queue as enumerable lists |
| 5 | **Priority is rank (int)** | 🟢 Acceptable | Use `priorityMap` in Custom REST config: `{ "1": "critical", "2": "high", ... }` |
| 6 | **No due dates** | 🟢 Acceptable | Queue is rank-ordered, not date-driven; `dueDate` stays null |
| 7 | **No pagination** | 🟢 Acceptable | Queue typically <100 items; full fetch is fine |

### Recommended API Additions (Model Catalog Side)

#### Priority 1: `?updated_since=` filter (LOW effort)

```
GET /api/unified-queue/entries?updated_since=2026-07-12T00:00:00Z
```

Filter entries by `updated_at >= param`. Enables MC incremental sync without fetching all entries every poll.

#### Priority 2: Optional API key auth (LOW effort)

```python
# In middleware or FastAPI dependency
API_KEY = os.getenv("MODEL_CATALOG_API_KEY", None)

async def check_api_key(request: Request):
    if API_KEY and request.headers.get("X-API-Key") != API_KEY:
        raise HTTPException(401, "Invalid API key")
```

Only enforced when the env var is set. MC passes the key via Custom REST connector `headers` config.

#### Priority 3: `/api/mc/tasks` — MC-friendly task projection (MEDIUM effort)

A dedicated endpoint combining queue entries + project tasks into MC-compatible flat list:

```json
{
  "tasks": [
    {
      "id": "qe-xxx",
      "title": "Print Benchy",
      "description": "Test print for new filament",
      "status": "up_next",
      "priority": "high",
      "source_list": "Print Queue",
      "created_at": "2026-07-12T10:00:00Z",
      "updated_at": "2026-07-12T14:30:00Z"
    }
  ]
}
```

Eliminates Custom REST field mapping entirely — MC consumes this directly.

#### Priority 4: `/api/mc/alerts` — MC-friendly alerts (MEDIUM effort)

Surfaces actionable conditions:

- Queue items stuck in `blocked` state
- Failed print attempts (`last_attempt_outcome: "failed"`)
- Stale intake uploads awaiting review (>N days)
- Project candidates pending decision (>N days in `candidate` state)

#### Priority 5: `/api/mc/lists` — Source list enumeration (LOW effort)

```json
[
  { "id": "queue", "name": "Print Queue", "type": "board", "count": 12 },
  { "id": "proj-1", "name": "Kitchen Organizers", "type": "project", "count": 5 },
  { "id": "intake", "name": "Intake Review", "type": "folder", "count": 3 }
]
```

### Quick-Start Config

With gap #1 (`updated_since`) addressed, this Custom REST config works immediately:

```json
{
  "type": "custom-rest",
  "name": "Model Catalog — Print Queue",
  "settings": {
    "baseUrl": "http://homelab:8200",
    "tasksEndpoint": "/api/unified-queue/entries",
    "responseTasksPath": "entries",
    "headers": {},
    "taskMapping": {
      "id": "queue_entry_id",
      "title": "title",
      "description": "queue_notes",
      "status": "state",
      "priority": "rank",
      "createdAt": "created_at",
      "updatedAt": "updated_at"
    },
    "statusMap": {
      "backlog": "todo",
      "up_next": "todo",
      "preparing": "in_progress",
      "ready": "todo",
      "in_progress": "in_progress",
      "blocked": "todo",
      "done": "done"
    },
    "priorityMap": {
      "1": "critical",
      "2": "high",
      "3": "medium",
      "4": "low",
      "5": "none"
    },
    "listField": "source_kind",
    "updateEndpoint": "PATCH /api/unified-queue/entries/:id",
    "deleteEndpoint": "DELETE /api/unified-queue/entries/:id",
    "createEndpoint": "POST /api/unified-queue/entries"
  }
}
```

### Dedicated Connector vs Custom REST

| Approach | Pros | Cons |
|----------|------|------|
| **Custom REST (quick-start)** | Zero MC code; works today with 1 sidecar change | Limited to flat task mapping; no rich print queue UX; no alerts without sidecar changes |
| **Dedicated `model-catalog` connector** | Rich entity mapping; print-specific UI (plates, files, estimates); project sync; alerts | More code; needs entity mapping design decisions |
| **Hybrid: Custom REST now → dedicated later** | Ship fast; learn from real usage; graduate when patterns stabilize | Two integration paths to maintain temporarily |

**Recommendation:** Start with Custom REST + `updated_since` filter to validate the integration. Graduate to a dedicated connector when richer features (plate-level tracking, print-specific kanban columns, project sync) are needed.

---

## Future Integration Candidates

_See also: `docs/design/FUTURE-INTEGRATIONS.md`_

| Tier | Integration | Pattern | MC Effort |
|------|------------|---------|-----------|
| 1 | Pushover / Ntfy mobile push | Outbound notification channel | Low |
| 1 | Grocy (grocery/inventory) | Extend HA connector with `sensor.grocy_*` entities | Low |
| 1 | MQTT via n8n | Zero MC code — n8n workflow templates | None |
| 2 | Notion | Connector or Custom REST with field mapping UI | Medium |
| 2 | Google Calendar | Mirror of Outlook Calendar connector | Low-Medium |

---

## Open Decisions

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Capabilities enforcement layer | API routes / sync engine / UI / all three | All three (defense in depth) |
| 2 | Model Catalog entity mapping | Queue → tasks, projects → projects, intake → triage | Start with queue → tasks only |
| 3 | Model Catalog write-back | Read-only vs two-way sync | Two-way via Custom REST (CRUD endpoints exist) |
| 4 | Project sync direction | MC→GitHub / GitHub→MC / bidirectional | GitHub→MC first (import), bidirectional later |
| 5 | Model Catalog: connector approach | Dedicated / Custom REST / Hybrid | Hybrid: Custom REST now, dedicated later |
| 6 | Cross-connector project linking | `hubProjectIds` exists — needs UI workflow | Design a project linking dialog |
| 7 | Model Catalog API additions | `/api/mc/*` projection endpoints | Add `updated_since` + API key first (Priority 1-2) |
