---
title: Timeline
sidebar_label: Timeline
sidebar_position: 7
route: /timeline
---

# Timeline

A calendar-based view showing tasks plotted by their due dates.

## Purpose

Visualize workload distribution across time. See which days are overloaded, which weeks are light, and spot deadline clusters before they become emergencies.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Month Navigation: ← July 2026 →                            │
├─────┬─────┬─────┬─────┬─────┬─────┬─────┐                 │
│ Sun │ Mon │ Tue │ Wed │ Thu │ Fri │ Sat │                 │
├─────┼─────┼─────┼─────┼─────┼─────┼─────┤                 │
│     │  1  │  2  │  3  │  4  │  5  │  6  │                 │
│     │ ●●  │     │ ●   │     │ ●●● │     │                 │
├─────┼─────┼─────┼─────┼─────┼─────┼─────┤                 │
│  7  │  8  │  9  │ 10  │ 11  │ 12  │ 13  │                 │
│     │ ●   │     │     │ ●●  │     │     │                 │
└─────┴─────┴─────┴─────┴─────┴─────┴─────┘                 │
                                                               │
│  Today's indicator highlighted                               │
│  Priority dots colored by level                              │
└─────────────────────────────────────────────────────────────┘
```

## Key Behaviors

### Calendar Navigation
- Month-by-month navigation with arrow buttons
- Today highlighted with distinct styling
- Pinned dates (overdue) shown with warning indicators

### Task Indicators
- Colored dots on calendar cells representing tasks due that day
- Dot color maps to priority: critical (red), high (orange), medium (yellow), low (blue), none (gray)
- Multiple dots stack to show volume

### Connector Icons
- Tasks display their source connector icon (Todo, GitHub, Email, Calendar, etc.)
- Quick visual for which system the deadline originates from

### Data Scope
- Shows parent tasks only (not subtasks) to avoid noise
- All connected sources included
- No limit on task count (full dataset)

## Data Sources

- All tasks with a `dueDate` from connected connectors
- Fetched via `/api/tasks?parentOnly=true&limit=0`

## Future Enhancements

- Click a day to see task list for that date
- Week view option
- Gantt-style timeline for projects (see Wave Planning design)
- Drag tasks between days to reschedule

## Related

- [Design: Wave Planning](../design/active/wave-planning.md) — Gantt-style timeline visualization
