---
title: "Energy System"
status: active
created: 2026-07-10
last_reviewed: 2026-07-18
category: design
issues: ["#137", "#138"]
related:
  - "[My Day Enhancements](design/MY-DAY-ENHANCEMENTS.md)"
  - "[Dashboard KPI Customization](design/DASHBOARD-KPI-CUSTOMIZATION.md)"
  - "[Wave Planning](design/WAVE-PLANNING-DESIGN.md)"
mockups:
  - "[mockup-focus3-calm-energy.html](mockups/mockup-focus3-calm-energy.html)"
---

# Energy System — Design Document

## Summary

The Energy system adds energy-awareness to Mission Control's AI task recommendations. Users report their energy level when opening My Day, and all AI-powered features (What's Next, Plan Day, Focus 3 suggestions) adapt their recommendations to match.

Tasks are also classified by energy demand via AI-inferred tags (`Energy: High`, `Energy: Medium`, `Energy: Low`), enabling the system to match task demands to user capacity.

---

## Architecture

### Data Model

**User energy check-ins** — stored per-day in the `energy_checkins` table:

| Column | Type | Description |
|--------|------|-------------|
| id | text PK | `energy-{date}-{timestamp}` |
| date | text | YYYY-MM-DD |
| level | text | `high` \| `medium` \| `low` |
| note | text? | Optional context |
| created_at | text | ISO timestamp |

**Task energy demand** — uses existing `tags` + `task_tags` system (no schema extension):

| Tag Slug | Tag Name | Color |
|----------|----------|-------|
| `energy-high` | Energy: High | `#10b981` (emerald) |
| `energy-medium` | Energy: Medium | `#f59e0b` (amber) |
| `energy-low` | Energy: Low | `#ef4444` (red) |

Tags have `type: 'ai-inferred'` and `source: 'energy-system'`. The AI classify endpoint auto-creates these tags on first use.

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/energy` | GET | Fetch today's energy check-in |
| `/api/energy` | POST | Save/update energy check-in |
| `/api/ai/suggest-energy-tags` | POST | AI-infer energy demand for tasks |
| `/api/ai/whats-next` | POST | Now includes energy context |
| `/api/ai/plan-day` | POST | Now includes energy context |
| `/api/ai/suggest-focus` | POST | Now scores with energy matching |

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `EnergyCheckIn` | `components/today/EnergyCheckIn.tsx` | Prompt shown on My Day open |
| `EnergyIndicator` | `components/today/EnergyCheckIn.tsx` | Compact badge in stats bar |

---

## How Energy Flows Through the System

```
User opens My Day
       │
       ▼
┌─────────────────────┐
│ Energy Check-In     │──── User picks High/Medium/Low
│ (if not set today)  │     Saved via POST /api/energy
└─────────────────────┘
       │
       ▼
┌─────────────────────┐     ┌──────────────────────────┐
│ Stats Bar shows     │     │ AI endpoints receive     │
│ EnergyIndicator     │     │ energy level:            │
│ (clickable to       │     │ • whats-next             │
│  change)            │     │ • plan-day               │
└─────────────────────┘     │ • suggest-focus          │
                            └──────────────────────────┘
                                       │
                                       ▼
                            ┌──────────────────────────┐
                            │ Energy tags on tasks:    │
                            │ energy-high/medium/low   │
                            │ (AI-inferred via         │
                            │  suggest-energy-tags)    │
                            └──────────────────────────┘
                                       │
                                       ▼
                            ┌──────────────────────────┐
                            │ Scoring adjustments:     │
                            │ +25 if energy matches    │
                            │ -15 if opposite mismatch │
                            │ ±0 if adjacent levels    │
                            └──────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Energy Check-In ✅ (Shipped)
- `energy_checkins` table + migration
- `/api/energy` GET/POST endpoint
- `EnergyCheckIn` prompt component on My Day open
- `EnergyIndicator` in stats bar
- Energy passed to What's Next and Plan Day AI calls

### Phase 2: Task Energy Tagging + Focus 3 ✅ (Shipped)
- AI energy tag inference (`suggestEnergyTags` in `lib/ai`)
- `/api/ai/suggest-energy-tags` endpoint with `autoApply` option
- `getEnergyTagsForTasks` helper for bulk tag lookup
- Energy tags included in What's Next AI context
- Focus 3 (`suggest-focus`) scoring adjusted for energy matching
- Energy demand tags use existing tag system (`Energy: High/Medium/Low`)

### Phase 3: Time-of-Day Heuristics (Deferred)
- Auto-adjust recommendations based on time of day
- Configurable time→energy mappings in settings
- Manual check-in always overrides
- **Deferred rationale:** Energy varies unpredictably; heuristics would erode trust

### Phase 4: Energy History & Trends (Deferred)
- Weekly/monthly energy pattern visualization
- Day-of-week averages, heatmaps
- **Deferred rationale:** Needs 30+ days of data; doesn't drive task completion today

### Phase 5: AI-Inferred Energy (Deferred)
- Predict today's energy from historical patterns
- Pre-fill check-in with prediction + confidence
- **Deferred rationale:** Requires significant history; ~1s manual check-in is already low-friction

---

## Design Decisions

1. **Tags over schema extension** — Energy demand uses existing `tags`/`task_tags` rather than adding a column to `tasks`. Keeps the schema lean and makes the feature optional/removable. Tag slugs: `energy-high`, `energy-medium`, `energy-low`.

2. **Check-in is dismissible** — The energy prompt can be dismissed without answering. Default fallback is `'medium'`. We never block the user from their tasks.

3. **Scoring not gating** — Energy matching adjusts scores (±25/15 points) rather than hiding tasks. A critical overdue task still surfaces even if it's high-energy and the user is low-energy.

4. **AI-inferred tags, not manual-only** — The `/api/ai/suggest-energy-tags` endpoint classifies tasks by analyzing titles/descriptions. Can be run in bulk (`autoApply: true`) or as suggestions for user confirmation.

5. **One check-in per day** — The upsert model replaces previous check-ins for the same date. Users can change their energy mid-day via the `EnergyIndicator`.

6. **Hub-only tags, no write-back** — Energy demand tags are Mission Control-internal (`type: 'ai-inferred'`, `source: 'energy-system'`) and are never synced back to source connectors. Rationale: (a) source systems like Microsoft Todo have no native energy concept — writing `Energy: High` as a category would pollute the user's source data; (b) these tags are AI-inferred and potentially incorrect, so pushing unconfirmed classifications upstream would erode trust; (c) energy demand is a MC planning concern used for recommendation scoring, not a task property the user manages in their source system.
