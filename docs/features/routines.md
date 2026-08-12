---
title: Routines
sidebar_label: Routines
sidebar_position: 8
route: /routines
---

# Routines

Habit and routine tracking with flexible scheduling, streak tracking, and behavioral insights.

## Purpose

Recurring habits and routines need different treatment than one-off tasks. This view provides purpose-built tracking with weekly grids, completion heatmaps, and cadence insights — making it easy to maintain consistency without cluttering your task list.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Tabs: [Routines] [Reset] [Insights]                        │
│  Week Navigation: ← Week of Jul 20 →                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Weekly Grid                                                 │
│  ┌──────────────┬───┬───┬───┬───┬───┬───┬───┐             │
│  │ Routine      │ M │ T │ W │ T │ F │ S │ S │             │
│  ├──────────────┼───┼───┼───┼───┼───┼───┼───┤             │
│  │ Morning run  │ ✓ │ ✓ │ ✓ │   │ ✓ │   │   │             │
│  │ Read 30min   │ ✓ │ ✓ │ ✓ │ ✓ │ ✓ │ ✓ │ ✓ │             │
│  │ Meditate     │ ✓ │   │ ✓ │   │ ✓ │   │   │             │
│  └──────────────┴───┴───┴───┴───┴───┴───┴───┘             │
│                                                              │
│  Routine Cards (expanded detail per routine)                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ 🏃 Morning run     Streak: 4 days    Best: 12 days     ││
│  │ Schedule: Mon, Wed, Fri   Cadence: 3x/week             ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Key Behaviors

### Tabs

#### Routines (default)
- **Weekly Grid** — 7-column grid showing completion status per day per routine
- **Routine Cards** — Detailed cards with streak info, schedule, and quick-complete
- **Toggle completion** — Click any day cell to mark complete/incomplete
- **Add routine** — Form to create new routines with name, schedule, cadence

#### Reset
- **Reset View** — A dedicated interface for resetting/restarting routines
- Useful for "starting over" after a break without losing historical data

#### Insights
- **Behavior Heatmap** — GitHub-style heatmap (28 weeks) showing completion density
- **Cadence Insights** — Analysis of actual vs. target frequency
- **Over-completion Log** — When you exceed your target cadence

### Routine Properties
- **Name** — Routine title
- **Schedule** — Which days of the week (or flexible cadence like "3x/week")
- **Cadence target** — Expected completions per period
- **Streak** — Current consecutive completions
- **Best streak** — All-time record

### Flexible Scheduling
- Fixed days (Mon, Wed, Fri) OR flexible cadence (3x/week, any days)
- Flexible routines show progress toward weekly target without dictating specific days

### Week Navigation
- Browse historical weeks to review past performance
- Current week highlighted with today indicator

## Data Sources

- Routines table (local database)
- Completions table (date + routine ID)
- Heatmap data fetched for 28-week window via `/api/routines/completions`

## Related

- [Product: Routines](../../PRODUCT.md) — Product context
