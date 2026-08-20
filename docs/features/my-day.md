---
title: My Day
sidebar_label: My Day
sidebar_position: 2
route: /today
---

# My Day

A focused daily planner that combines auto-populated tasks with manual curation and AI-powered scheduling.

## Purpose

Answer "what should I work on today?" without scanning every list. My Day surfaces the tasks that matter today — by due date, calendar context, and AI suggestion — then lets you schedule and focus on them one at a time.

## Layout

```
┌─────────────────────────────────────────┬───────────────────┐
│  Main Panel                             │  Sidebar           │
│                                         │                    │
│  Energy Level Selector                  │  AI Suggestions    │
│  ─────────────────────                  │  - "Add to Day"    │
│                                         │                    │
│  Scheduled Timeline (time blocks)       │  What's Next       │
│  ─────────────────────                  │  (AI recommend)    │
│                                         │                    │
│  My Day Tasks (reorderable list)        │  Time remaining    │
│  ☐ Task with estimated duration         │  estimate          │
│  ☐ Task with estimated duration         │                    │
│                                         │                    │
│  Calendar Events (read-only context)    │                    │
└─────────────────────────────────────────┴───────────────────┘
```

## Key Behaviors

### Auto-Population
Tasks appear in My Day automatically when:
- Due today (or overdue)
- Completed during that day, even if they were not previously added
- Manually pinned via "Add to My Day" from any view
- Part of a recurring routine scheduled for today

Cancelled tasks already associated with the day appear in a separate collapsed section. They are not treated as open or complete, are not auto-added from due-today tasks, and do not affect the completion percentage.

### Energy Level
- Selector at top: Low / Medium / High / Peak
- Influences AI suggestions ("What's Next" adjusts for energy)
- Persists for the day

### Scheduling
- **Schedule modal** — Assign a time slot and duration to any task
- **Timeline view** — Visual time blocks showing scheduled tasks alongside calendar events
- **Drag to resize** — Adjust scheduled task duration directly on timeline
- **Unschedule** — Remove time assignment, keep in day list

### AI Features
- **What's Next** — AI analyzes remaining tasks, energy level, and time to suggest the optimal next task
- **Plan My Day** — AI generates a full day plan with time allocations and ordering
- **Day Plan** — Rendered as an actionable plan you can accept or modify

### Planning Friction
- **Repeatedly Rescheduled** surfaces open tasks whose due date has moved later at least twice
- A compact reschedule count appears on affected task rows
- Initial due-date assignment, removing a date, and moving a date earlier do not count
- This stays in the planning surface rather than creating interruptive notifications

### Focus Mode
- **Start Focus** — Select a task to enter focus mode with timer
- **Focus Timer** — Countdown timer for the active task
- **Complete from focus** — Mark done without leaving focus mode

### Task Actions
- **Reorder** — Drag to prioritize within the day
- **Remove from Day** — Remove without completing
- **Complete** — Optimistic completion with animation
- **Set priority / status / due date** — Inline modifications
- **Move to list** — Reassign to a different source list
- **Save as template** — Capture task structure for reuse

### Quick Add Context
When on My Day, the global quick-add bar automatically sets `addToMyDay: true` so new tasks are immediately added to today's list.

## Data Sources

- Tasks: Filtered from all connected sources (due today + manually added)
- Calendar events: Microsoft Graph calendar connector
- Suggestions: AI engine using priority, due date, energy, and behavioral patterns
- Planning friction: lifetime `pushCount` plus immutable task-history signals for later due-date moves, missed My Day and Focus commitments, elapsed time blocks, overdue transitions, and snooze extensions
- Microsoft To Do commitments: current My Day state plus a bounded three-day historical observation window when the Substrate response confirms the requested `CommittedDay`
- Replanning: open tasks with recent planning-friction signals appear in the **May Need Replanning** suggestion group, which links to the Planning friction report in Insights

## Related

- [Design: My Day Enhancements](../design/proposed/my-day-enhancements.md)
- [Architecture: AI Engine](../architecture/ai-engine.md)
