---
title: Insights
sidebar_label: Insights
sidebar_position: 9
route: /insights
---

# Insights

An analytics dashboard showing patterns, trends, and AI-generated observations about your productivity.

## Purpose

Move beyond "how many tasks did I complete?" to understand behavioral patterns. Insights surfaces trends in completion rates, source distribution, task aging, and routine consistency — plus AI observations that connect the dots.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Insights       Period: [7 days] [30 days] [90 days]│
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  AI Observations                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ 💡 "You complete 40% more tasks on Tuesdays"            ││
│  │ 🔥 "3-day completion streak — longest this month"       ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  Charts Grid                                                 │
│  ┌──────────────────────┐  ┌──────────────────────┐        │
│  │ Completion Trend     │  │ Source Breakdown      │        │
│  │ (line chart)         │  │ (donut chart)         │        │
│  └──────────────────────┘  └──────────────────────┘        │
│  ┌──────────────────────┐  ┌──────────────────────┐        │
│  │ Task Age             │  │ Routine Heatmap       │        │
│  │ (histogram)          │  │ (calendar heatmap)    │        │
│  └──────────────────────┘  └──────────────────────┘        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Project Velocity (bar chart per project)              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Key Behaviors

### Period Selection
- **7 days** — Recent snapshot (default)
- **30 days** — Monthly trends
- **90 days** — Quarterly patterns

### Charts

| Chart | What it shows |
|-------|--------------|
| **Completion Trend** | Tasks completed per day over the period (line chart) |
| **Source Breakdown** | Proportion of tasks by connector source (donut) |
| **Task Age** | Distribution of open tasks across <1, 1–7, 8–30, 31–60, 61–90, and >90 day buckets |
| **Routine Heatmap** | Daily routine completion density (calendar grid) |
| **Project Velocity** | Completion rate per project (bar chart) |
| **Planning Friction** | Later due-date moves, days deferred, and recurring task, list, and tag patterns |

### AI Observations
- Automatically generated insights about your patterns
- Examples: streak records, day-of-week patterns, source imbalances, velocity changes
- Fetched from `/api/insights/observations`
- Displayed as actionable cards with icons (💡 insight, 🔥 streak, ⚠️ warning)

### Trend Indicators
- Up/down arrows showing change vs. previous period
- Color-coded: green (improving), red (declining)

## Data Sources

- Aggregated from task completion events across all connectors
- Routine completion data
- Project progress snapshots
- AI observation engine (background analysis)
- Due-date push events. Events retain task ID, previous/new dates, timestamp, and delay days; list and tag rankings are resolved from current task organization rather than copied into every event.

### Planning Friction Semantics
- A push is recorded only when an existing due date moves to a later calendar date
- `pushCount` is a lifetime task-level total for fast sorting and My Day suggestions
- Task history events provide period-aware trends and preserve the magnitude of each move
- Insights show top tasks, lists, and tags; title keyword extraction is intentionally deferred because it adds noisy derived data without a clear action
- Three or more pushes in a reporting period can produce a deterministic AI observation with the strongest current list or tag pattern
- No push notification is generated. The My Day suggestion is the actionable surface; Insights is the reflective surface.

## Related

- [Design: Insights Page](../design/proposed/insights-page.md)
