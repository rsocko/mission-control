---
title: "My Day Enhancements"
status: proposed
created: 2026-07-08
last_reviewed: 2026-07-08
category: design
related:
  - "[Radial Clock View](RADIAL-CLOCK-VIEW-DESIGN.md)"
  - "[Energy System](../../docs/ENERGY-SYSTEM-DESIGN.md)"
  - "[Status & Decisions](../reference/STATUS-AND-DECISIONS.md)"
  - "[Dashboard KPI](DASHBOARD-KPI-CUSTOMIZATION.md)"
mockups:
  - "[mockup-myday.html](../mockups/mockup-myday.html)"
---

# My Day — Enhancement Design

## Summary

Enhancements to the My Day view covering two areas:

1. **Timeline interaction improvements** — drag-to-schedule, drag-to-resize, stacking, calendar ghosting, and inline completion
2. **Suggestion panel improvements** — smart grouping of suggested items beyond just "Overdue"

---

## 1. Timeline Interaction Enhancements

### Current State

- Tasks can be time-blocked via a modal (pick time + duration)
- Calendar events fetched and rendered in the same timeline
- Unscheduled tasks sit in a separate list
- Drag-to-reorder exists for the unscheduled list (dnd-kit)

### Proposed Enhancements

#### 1.1 Drag-to-Schedule

**Behavior:** Drag an unscheduled task from the left panel directly onto the timeline grid. Task snaps to the nearest 15-minute increment. Default duration: 30min (user preference configurable).

**UX:**
- Drop zone highlights on the timeline as user drags over
- Ghost preview shows the block size before drop
- Snapping grid: 15-minute increments (7:00, 7:15, 7:30, 7:45, etc.)
- If dropped on an occupied slot, stack below the existing item (see 1.3)

#### 1.2 Drag-to-Resize

**Behavior:** Pull the bottom edge of a scheduled task block to extend or shrink its duration in 15-minute increments.

**UX:**
- Bottom edge shows a subtle grab handle on hover (2px line)
- While dragging, duration label updates in real-time ("45min", "1h", "1h 15min")
- Minimum: 15 minutes
- Maximum: 4 hours (prevents accidental full-day blocks)
- Persists via PATCH to `/api/schedule`

#### 1.3 Multiple Tasks Per Time Slot (Stacking)

**Behavior:** Allow 2+ tasks to occupy the same time slot. Visually renders as stacked cards within the slot, implying "in this time block I want to get these X things done."

**UX:**
- Stacked tasks show side-by-side or vertically within the slot (max 3 visible, "+N more" overflow)
- Slot height grows slightly to accommodate stacking
- Each stacked item is independently completable
- Drag a task onto another task's slot to stack them

**Data model:** The `task_schedules` table already supports this (multiple rows with same `scheduledTime`). Just needs UI rendering.

#### 1.4 Calendar Events as Ghosted Blocks

**Behavior:** Calendar events from Outlook/Google render as semi-transparent "unavailable" blocks that the user plans around but cannot interact with directly.

**UX:**
- Distinct visual: lower opacity (40%), diagonal stripe pattern or solid muted fill, no grab handles
- Shows event title + time but no checkboxes or drag affordances
- Color: use a neutral gray or the calendar source color at reduced opacity
- Cannot drop tasks onto calendar event slots (or can, but shows warning "conflicts with: Team Standup")
- Toggle: "Show/hide calendar" button in toolbar

**Current state:** CalendarEvent interface exists, events are fetched — just needs distinct "ghost" styling.

#### 1.5 Complete from Timeline View

**Behavior:** Each scheduled task block has a small completion affordance visible without opening a modal.

**UX options (pick one):**
- **Option A:** Small checkbox on the left edge of the time block (consistent with list view)
- **Option B:** Click-and-hold the block → completion animation (more gesture-based)
- **Option C:** Swipe-right on the block (mobile-friendly, like iOS Reminders)

**Recommendation:** Option A — checkbox on left edge. Keeps it consistent with the dashboard task rows. On completion: block fades to 50% opacity + strikethrough text, stays in place (doesn't collapse) so the timeline remains stable.

---

## 2. Suggestion Panel Enhancements

### Current State

The right sidebar shows suggested tasks to add to My Day. Currently limited to basic "Overdue" items and "What's Next" AI recommendation.

### Proposed Smart Groups

| Group | Logic | Icon | Sort |
|-------|-------|------|------|
| **Yesterday** | Items that were on My Day yesterday but not completed | ⏪ | By priority |
| **Overdue** | Tasks past due date | 🔴 | By how overdue (oldest first) |
| **Due Soon** | Due within next 3 days | ⏰ | By due date ASC |
| **AI Recommended** | AI picks based on priority, energy level, available time gaps | ✨ | By AI confidence score |
| **Recently Added** | Tasks created in last 48 hours (not yet on any day) | 🆕 | By creation date DESC |
| **Carried Forward** | Items on My Day for 3+ consecutive days without completion | 🔁 | By streak length |

#### "Yesterday" Group (MS Todo parity)

**Implementation:**
- Track which tasks were on My Day yesterday via `my_day_items` table (check `date` = yesterday)
- Filter to only items with status != 'done'
- Show with a "These didn't get done yesterday" subheading
- One-click "Add all back" button + individual "+" buttons

#### "AI Recommended" Group

**Implementation:**
- Call existing `/api/ai/whats-next` or expand it to return multiple recommendations
- Factors: priority, due date proximity, estimated effort vs. available time gaps, energy curve preferences, task dependencies
- Show confidence: "High fit" / "Good fit" indicator
- Brief AI reasoning shown as tooltip or subtitle ("High priority + due tomorrow + short task")

#### "Carried Forward" Group

**Implementation:**
- Query `my_day_items` for tasks appearing on 3+ consecutive dates
- Surface as "stuck" items — maybe they need to be broken down, delegated, or removed
- Subtle amber indicator: "On My Day for 4 days"

### Suggestion Panel UX

```
┌─────────────────────────────────┐
│ Suggestions         [Refresh 🔄] │
├─────────────────────────────────┤
│                                 │
│ ⏪ YESTERDAY (3)               │
│   ○ Fix CORS headers       [+] │
│   ○ Update deploy script   [+] │
│   ○ Review PR #42          [+] │
│   [Add all back →]             │
│                                 │
│ 🔴 OVERDUE (2)                 │
│   ○ Submit Q2 report       [+] │
│   ○ Pay invoice #1847      [+] │
│                                 │
│ ✨ AI RECOMMENDED (3)          │
│   ○ Source list discovery   [+] │
│     "Critical blocker, ~2h"    │
│   ○ Write unit tests       [+] │
│     "Good focus task, ~1h"     │
│   ○ Respond to Jim's msg   [+] │
│     "Quick win, ~10min"        │
│                                 │
│ ⏰ DUE SOON (2)               │
│   ○ File taxes extension   [+] │
│     Due in 2 days              │
│   ○ Dentist reminder       [+] │
│     Due tomorrow               │
│                                 │
│ 🆕 RECENTLY ADDED (2)         │
│   ○ Explore voice control  [+] │
│   ○ Research Tauri         [+] │
│                                 │
└─────────────────────────────────┘
```

### Priority of Smart Groups (display order)

1. Yesterday (highest signal — these were explicitly chosen before)
2. Overdue (urgency)
3. AI Recommended (intelligent selection)
4. Due Soon (approaching deadlines)
5. Recently Added (awareness)
6. Carried Forward (nudge for stuck items, lowest priority)

Each group is collapsible. Empty groups are hidden. Maximum 5 items per group with "Show more" expand.

---

## Implementation Phases

### Phase 1: Suggestion Panel Smart Groups
- Add "Yesterday" group (query my_day_items for previous day's incomplete)
- Add "Due Soon" group (tasks due within 3 days)
- Add "Recently Added" group (created_at within 48h, not on any day)
- Collapsible group UI with counts

### Phase 2: Calendar Ghosting + Completion
- Distinct ghost styling for calendar events in timeline
- "Show/hide calendar" toggle
- Checkbox on scheduled task blocks for inline completion
- Completion animation (fade + strikethrough, block stays in place)

### Phase 3: Drag Interactions
- Drag-to-schedule from suggestion panel / unscheduled list onto timeline
- 15-minute snap grid
- Drop zone highlighting
- Persist via existing schedule API

### Phase 4: Resize + Stacking
- Drag-to-resize bottom edge (15min increments)
- Multiple tasks per slot (stack rendering)
- Slot height growth for stacked items

### Phase 5: AI + Carried Forward
- "AI Recommended" group leveraging existing AI endpoints
- "Carried Forward" detection (3+ consecutive days)
- AI reasoning subtitles

---

## Design Decisions (Resolved)

1. **Yesterday items** → Show prominently in suggestions panel but require **manual re-add**. Items due today auto-add to My Day; yesterday's incomplete items are surfaced for explicit choice.

2. **Stacking limit** → **No limit.** User can pile as many tasks as they want into a single time slot. UI handles overflow gracefully (show first 3-4 visible, "+N more" expand).

3. **Calendar toggle** → **Per-calendar toggle.** User can show/hide individual calendars (e.g., show work calendar, hide personal). Stored as a preference.

4. **Drag-to-unschedule** → **Both.** Drag a task from the timeline back to the unscheduled pool to remove its time slot, AND provide an explicit "Unschedule" button in context menu/task actions. **Important:** unscheduling removes only the scheduled time slot — it does NOT clear the task's estimated duration. The task returns to the unscheduled list with its duration intact, ready to be re-scheduled elsewhere.

