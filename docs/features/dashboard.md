---
title: Dashboard
sidebar_label: Dashboard
sidebar_position: 1
route: /
---

# Dashboard

The main view and default landing page. A unified task list that aggregates all tasks from connected sources into a single filterable, sortable, groupable interface.

## Purpose

Replace tab-switching between task apps. See everything in one dense, keyboard-driven list — filter down to exactly what matters, act inline, and move on.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  KPI Bar (counts, streaks, progress)                        │
├────────────┬────────────────────────────────────────────────┤
│            │  Toolbar (group, sort, filter pills, density)  │
│  Sidebar   ├────────────────────────────────────────────────┤
│  Filters   │                                                │
│            │  Task List (virtualized, grouped sections)      │
│  - Sources │                                                │
│  - Lists   │  ─── Group Header ───────────────────────      │
│  - Tags    │  ☐ Task row                                    │
│  - Projects│  ☐ Task row                                    │
│  - Views   │  ☐ Task row                                    │
│            │                                                │
├────────────┼────────────────────────────────────────────────┤
│            │  Widgets: Recent Wins, Routines, Triage Queue  │
└────────────┴────────────────────────────────────────────────┘
```

## Key Behaviors

### Filtering
- **Source filter** — Show tasks from a single connector (Microsoft Todo, GitHub, etc.)
- **List filter** — Drill into a specific source list
- **Tag filter** — Multi-select tag filtering (AND logic)
- **Project filter** — Scope to tasks within a hub project
- **Quick filter** — Shared desktop/mobile smart filters for My Day, Inbox, overdue,
  due today, next seven days, high priority, assigned, waiting/blocked, recent
  activity, and tasks without a date
- **Quick filter visibility** — Show each filter always, only when non-empty, or
  hide it; active filters remain available when their count reaches zero
- **Saved views** — User-created filter+sort presets

### Grouping & Sorting
- **Group by** — Source, list, priority, due date, project, status, tags
- **Sort by** — Due date, priority, smart score, created date, title
- **Sort direction** — Ascending or descending
- **Collapsible groups** — Click to expand/collapse; counts shown in header

### View Density
- **Comfortable** — More padding, larger tap targets
- **Compact** — Tighter rows for maximum information density

### Task Interactions
- **Inline complete** — Click checkbox for optimistic completion with undo
- **Context menu** — Right-click for move, tag, priority, delete, template save
- **Detail panel** — Click task to open slide-over with full editing
- **Drag to reorder** — Within groups (when applicable)

## Widgets

Bottom of the page includes contextual widgets:

- **KPI Bar** — Task counts, completion streak, overdue count, daily completions
- **Recent Wins** — Last completed tasks as positive reinforcement
- **Routine Snapshot** — Today's routine progress at a glance
- **Triage Queue Widget** — Pending triage items count with quick link
- **Progress Rollup** — Project completion percentages
- **One Thing Banner** — AI-suggested single focus task

## Data Sources

- All enabled connectors feed into this view
- Tasks refresh on sync events (automatic via `useSyncStream`)
- Show/hide completed tasks toggle

## Related

- [Architecture: Frontend](../architecture/frontend.md) — Component hierarchy
- [Design: Dashboard KPI Customization](../design/active/dashboard-kpi-customization.md)
