---
title: "Dashboard KPI Customization"
status: implemented
created: 2026-06-25
last_reviewed: 2026-07-18
category: design
related:
  - "[Go-Forward Plan](../planning/GO-FORWARD-PLAN.md)"
  - "[My Day Enhancements](MY-DAY-ENHANCEMENTS.md)"
  - "[ADHD Planner Competitive Analysis](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md)"
  - "[Package Delivery Tracking](PACKAGE-DELIVERY-TRACKING.md)"
mockups:
  - "[mockup-dashboard.html](../mockups/mockup-dashboard.html)"
  - "[mockup-dashboard-enhanced.html](../mockups/mockup-dashboard-enhanced.html)"
  - "[mockup-dashboard-packages.html](../mockups/mockup-dashboard-packages.html)"
---

# Dashboard KPI Customization

## Problem Statement

The dashboard currently renders **4 hardcoded KPI stat cards** (Total Open, Overdue, Due This Week, Unread Alerts). The enhanced dashboard mockup proposes a **completely different** set of 5 progress-oriented cards (This Week %, Routines %, Streak, Focus 3, Daily Avg). The packages mockup adds a 5th "In Transit" card to the original 4.

This creates three issues:

1. **No bridge between layouts.** The current and enhanced dashboards are two independent mockups with no shared KPIs. There's no path from "basic dashboard" to "enhanced dashboard" — it's a full swap.
2. **Missing KPIs.** Useful metrics like **My Day count** (already computed by the API), **High Priority count**, and **routine completion rollups** have no way to surface.
3. **No user agency.** Different users at different stages want different signals. Someone onboarding cares about Total Open + Overdue. Someone deep in ADHD-optimized flow cares about Streak + Focus 3 + Routines. There's no way to configure this.

## Proposal: Configurable KPI Bar

Instead of maintaining parallel hardcoded dashboard mockups, **unify all KPI cards into a single configurable pool** and let the user select which 4-6 cards are visible.

### KPI Card Registry

Every KPI card is a self-contained widget with:
- A **slug** (unique key)
- A **label** (display name)
- A **data source** (API endpoint or derived computation)
- A **visual type** (counter, fraction, percentage, sparkline, dot-status)
- An **accent color** mapping
- An optional **click action** (quick-filter, navigate to view, etc.)

### Full KPI Catalog

| Slug | Label | Visual | Data Source | Click Action | Status |
|------|-------|--------|-------------|--------------|--------|
| `total-open` | Total Open | Counter | `stats.totalOpen` | — | ✅ Live |
| `overdue` | Overdue | Counter | `stats.overdue` | Filter: overdue | ✅ Live |
| `due-this-week` | Due This Week | Counter | `stats.dueThisWeek` | Filter: week | ✅ Live |
| `unread-alerts` | Unread Alerts | Counter | `alerts.unread.length` | Navigate: alerts | ✅ Live |
| `my-day` | My Day | Counter | `stats.myDay` | Navigate: /today | ⚡ Ready (API exists, no card) |
| `high-priority` | High Priority | Counter | `stats.highPriority` | Filter: priority=high | ⚡ Ready (API exists, no card) |
| `this-week-progress` | This Week | Fraction + bar | Completed/Total this week | — | 🔧 Needs API |
| `routines-kept` | Routines | Percentage + bar | Routine completions / targets | Navigate: /routines | 🔧 Needs API |
| `streak` | Streak | Counter + dots | Consecutive active days | — | 🔧 Needs API |
| `focus-3` | Focus 3 | Fraction + dots | Focus items completed today | Navigate: /today | 🔧 Needs API |
| `daily-avg` | Daily Avg | Counter + sparkline | 7-day rolling average | — | 🔧 Needs API |
| `in-transit` | Packages | Counter | Shipment tracker (future) | Navigate: /shipments | 🔧 Needs connector |
| `completed-today` | Done Today | Counter | Completions since midnight | — | 🔧 Needs API |
| `assigned-to-me` | Assigned to Me | Counter | `stats.assignedToMe` | Filter: assigned | ⚡ Ready (API exists, no card) |

### Default Configurations

Users shouldn't have to configure anything upfront. Provide sensible defaults that evolve:

**Default (current behavior, no action required):**
```
[ total-open, overdue, due-this-week, unread-alerts ]
```

**"Progress-focused" preset (replaces enhanced dashboard mockup):**
```
[ this-week-progress, routines-kept, streak, focus-3, daily-avg ]
```

**"Operations" preset (for heavy multi-source users):**
```
[ total-open, overdue, my-day, high-priority, unread-alerts ]
```

Users can also build custom layouts from the full catalog.

### Smart Auto-Surfacing

Some KPIs should auto-appear/disappear based on context:

| KPI | Auto-show when | Auto-hide when |
|-----|----------------|----------------|
| `my-day` | User has ≥1 My Day item today | User never uses My Day |
| `routines-kept` | User has ≥1 routine defined | No routines exist |
| `in-transit` | Shipment connector enabled + ≥1 active package | No shipment connector |
| `focus-3` | User has set Focus 3 items today | Feature not used |
| `streak` | User has ≥3 day streak | Streak = 0 |

Auto-surfaced KPIs append to the user's selected set (up to max 6). User can dismiss them.

---

## Settings UI

### Location: Settings → Dashboard

```
┌──────────────────────────────────────────────────────────┐
│ Dashboard KPIs                                           │
│                                                          │
│ Choose which stat cards appear at the top of the         │
│ dashboard. Drag to reorder. Maximum 6 cards.             │
│                                                          │
│ ┌────────────────────────────────────────────────┐       │
│ │ ☰  Total Open          ▣                       │       │
│ │ ☰  Overdue             ▣  (click → filter)     │       │
│ │ ☰  Due This Week       ▣  (click → filter)     │       │
│ │ ☰  Unread Alerts       ▣                       │       │
│ └────────────────────────────────────────────────┘       │
│                                                          │
│ [+ Add KPI]    Presets: [Default ▾]                      │
│                                                          │
│ ☐ Auto-surface relevant KPIs                             │
│   Shows cards like My Day, Routines, or Packages when    │
│   they become relevant. You can dismiss them anytime.    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### "+ Add KPI" Popover

Shows the full catalog minus already-selected cards. Grouped by category:

```
┌───────────────────────────────────┐
│ Add KPI Card                      │
├───────────────────────────────────┤
│ TASK COUNTS                       │
│   ○ My Day (12)          [Add]    │
│   ○ High Priority (3)   [Add]    │
│   ○ Assigned to Me (8)  [Add]    │
│   ○ Done Today (4)      [Add]    │
│                                   │
│ PROGRESS & HABITS                 │
│   ○ This Week (12/30)   [Add]    │
│   ○ Routines (71%)      [Add]    │
│   ○ Streak (7 days)     [Add]    │
│   ○ Focus 3 (2/3)       [Add]    │
│   ○ Daily Avg (4.2)     [Add]    │
│                                   │
│ INTEGRATIONS                      │
│   ○ Packages (5)        [Add]    │
└───────────────────────────────────┘
```

### Presets Dropdown

Quick-switch between predefined layouts:

- **Default** — Total Open, Overdue, Due This Week, Unread Alerts
- **Progress-focused** — This Week, Routines, Streak, Focus 3, Daily Avg
- **Operations** — Total Open, Overdue, My Day, High Priority, Unread Alerts
- **Custom** — (shown when user has manually edited)

Selecting a preset replaces the current selection. "Custom" is read-only — it just indicates the user has diverged from a preset.

---

## Data Model

### `user_preferences` Table (existing)

Store KPI configuration as a JSON preference:

```typescript
// Key: 'dashboard_kpis'
// Value (JSON):
{
  cards: ['total-open', 'overdue', 'due-this-week', 'unread-alerts', 'my-day', 'routines-kept', 'streak', 'focus-3'],
  pinned: ['total-open', 'overdue'],       // Always-visible, never rotate out
  visibleSlots: 4,                          // How many cards show at once (max 6)
  rotationInterval: 8,                      // Seconds between card swaps
  pauseOnHover: true,                       // Freeze rotation on mouse hover
  autoPinOnFilter: true,                    // Auto-pin cards when user clicks to filter
  autoSurface: true,
  preset: 'default'    // 'default' | 'progress' | 'operations' | 'custom'
}
```

Falls back to the default 4-card layout if no preference is set.

### API Changes

**New endpoint: `GET /api/dashboard/kpis`**

Returns computed values for all KPI slugs the user has selected, plus any auto-surfaced ones:

```json
{
  "cards": [
    { "slug": "total-open", "value": 611, "type": "counter", "accent": "blue" },
    { "slug": "overdue", "value": 0, "type": "counter", "accent": null },
    { "slug": "my-day", "value": 12, "type": "counter", "accent": "cyan" },
    { "slug": "routines-kept", "value": 71, "max": 100, "type": "percentage", "accent": "green" }
  ],
  "autoSurfaced": [
    { "slug": "streak", "value": 7, "type": "counter", "accent": "orange", "reason": "7-day streak active" }
  ]
}
```

This replaces the current pattern of computing all stats in the tasks API and lets the KPI bar be independent of the task list fetch.

---

## Grid Layout

The current `grid-cols-4` is hardcoded. Switch to a responsive approach:

| Card Count | Grid | Behavior |
|------------|------|----------|
| 1–3 | `grid-cols-3` | Cards stretch wider |
| 4 | `grid-cols-4` | Current layout (default) |
| 5 | `grid-cols-5` | Cards narrower, still readable |
| 6 | `grid-cols-6` | Compact cards — hide subtitle text below `md` |
| 7+ | — | Not allowed (max 6) |

On mobile (`< md`), always 2 columns with horizontal scroll.

---

## Animated KPI Rotation

When the number of **applicable** KPI cards exceeds the visible slot count (e.g., 8 applicable but only 4–6 slots), the bar **rotates cards in and out** on a timer rather than hiding the overflow entirely.

### Core Behavior

- **Visible slots:** Fixed at user's configured count (default 4, max 6)
- **Rotation pool:** All applicable KPIs minus any that are currently **pinned**
- **Cycle interval:** Every 8 seconds, one non-pinned slot transitions to the next card in the pool
- **Animation:** Crossfade with vertical slide — outgoing card exits upward (opacity 1→0, translateY 0→-12px, 200ms), incoming card enters from below (opacity 0→1, translateY 12px→0, 300ms, 50ms delay). Use Motion's `AnimatePresence` with `mode="popLayout"` for smooth layout shifts.
- **Round-robin order:** Cards cycle in priority order (see ordering below), looping back to the start

### Pinning Rules

A card is **pinned** (exempt from rotation) when:

1. **Active filter** — User has clicked a KPI card to apply a quick-filter (e.g., "Overdue" is filtering the task list). The card gets a ring indicator and stays locked in position.
2. **Hover** — While the user hovers over any card in the bar, **all rotation pauses**. Resumes 3 seconds after mouse leaves the bar.
3. **User-pinned** — In Settings, user can mark specific cards as "Always show" (pin icon). These never rotate out.

### Rotation Priority Order

When deciding which cards to show and in what order to rotate:

| Priority | Criteria | Example |
|----------|----------|---------|
| 1 (highest) | User-pinned cards | Cards marked "Always show" |
| 2 | Cards with non-zero "attention" values | Overdue: 3, Unread Alerts: 12 |
| 3 | Cards with active data | My Day: 8 items, Streak: 7 days |
| 4 | Cards with zero/neutral values | Overdue: 0, Due This Week: 0 |
| 5 (lowest) | Cards with no data source connected | Packages (no connector) |

Cards at priority 1–2 get shown first; remaining slots rotate through priority 3–4. Priority 5 cards are excluded from rotation entirely.

### Visual Indicator

A subtle dot indicator below the KPI bar shows rotation state:

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│Total Open│  │ Overdue 🔒│  │  My Day  │  │  Streak  │
│   611    │  │    3     │  │    12    │  │  7 days  │
└──────────┘  └──────────┘  └──────────┘  └──────────┘
                                ●  ●  ○  ○
```

- Filled dots (●) = cards currently visible in rotating slots
- Empty dots (○) = cards queued in the rotation pool
- 🔒 on the Overdue card = pinned because it's actively filtering
- Dots only appear when rotation is active (pool > visible slots)
- Clicking the dots area pauses rotation and reveals a mini-carousel nav (← →)

### Pause & Manual Navigation

- **Click dots** → Rotation pauses, left/right arrows appear for manual browsing
- **Pause timeout** → After 30 seconds of no interaction, rotation auto-resumes
- **Keyboard** → When KPI bar is focused, arrow keys navigate through rotation pool

### Settings Integration

```
┌──────────────────────────────────────────────────────────┐
│ Dashboard KPIs                                           │
│                                                          │
│ Visible slots: [4 ▾]  (max 6)                           │
│                                                          │
│ ┌────────────────────────────────────────────────┐       │
│ │ 📌 Total Open         ▣  (always show)         │       │
│ │ 📌 Overdue            ▣  (always show)         │       │
│ │ ↻  Due This Week      ▣  (rotates)            │       │
│ │ ↻  Unread Alerts      ▣  (rotates)            │       │
│ │ ↻  My Day             ▣  (rotates)            │       │
│ │ ↻  Routines           ▣  (rotates)            │       │
│ │ ↻  Streak             ▣  (rotates)            │       │
│ │ ↻  Focus 3            ▣  (rotates)            │       │
│ └────────────────────────────────────────────────┘       │
│                                                          │
│ Rotation speed: [8 seconds ▾]                            │
│ ☑ Pause rotation on hover                                │
│ ☑ Auto-pin cards with active filters                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Users drag cards between "📌 Always show" (pinned, never rotates out) and "↻ Rotates" (participates in cycling). Pinned cards fill slots first; remaining slots rotate through the pool.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| All cards pinned | No rotation — behaves like static grid |
| Only 1 rotating slot | That single slot cycles through all non-pinned cards |
| Pool has 0 extra cards | No rotation needed — dots hidden, all applicable cards fit |
| Card value changes during rotation | Updated in-place if visible; if in pool, shows new value when rotated in |
| User clicks a rotating card to filter | Card immediately pins (stops rotating), filter applies, remaining slots re-balance |
| User clears a filter | Card un-pins, returns to rotation pool on next cycle |

### Animation Spec (Motion)

```tsx
// KPI card rotation animation
const kpiRotationVariants = {
  enter: {
    opacity: 0,
    y: 12,
    filter: 'blur(4px)',
  },
  center: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.3, ease: [0.32, 0.72, 0, 1] },
  },
  exit: {
    opacity: 0,
    y: -12,
    filter: 'blur(2px)',
    transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] },
  },
};
```

---

## Visual Types

Each KPI card type has a distinct secondary visual:

| Type | Example | Secondary Element |
|------|---------|-------------------|
| **Counter** | Total Open: `611` | Icon only |
| **Fraction** | This Week: `12/30` | Progress bar |
| **Percentage** | Routines: `71%` | Progress bar |
| **Counter + dots** | Streak: `7 days` | 7 green dots (day indicators) |
| **Fraction + dots** | Focus 3: `2/3` | 3 dots (2 green, 1 gray) |
| **Counter + sparkline** | Daily Avg: `4.2` | 7-point SVG sparkline |

All types share the same card shell (consistent border, padding, label, icon, accent color).

---

## Implementation Phases

### Phase 1: Quick Wins (Low effort)

Add **My Day** and **High Priority** as additional stat cards using already-available API data. No settings UI needed — just wire them into the existing `StatCard` grid.

| Step | Work |
|------|------|
| 1 | Add My Day stat card using `stats.myDay` with `Sun` icon and cyan accent |
| 2 | Optionally add High Priority card using `stats.highPriority` |
| 3 | Switch grid to `grid-cols-5` or `grid-cols-6` |
| 4 | Make My Day card clickable → navigates to `/today` |

### Phase 2: KPI Configuration (Medium effort)

| Step | Work |
|------|------|
| 1 | Create KPI card registry (slug → component mapping) |
| 2 | Add `dashboard_kpis` user preference |
| 3 | Build Settings → Dashboard section with drag-to-reorder |
| 4 | Implement preset quick-switch |
| 5 | Dynamic grid column count based on card count |

### Phase 3: Progress KPIs (Medium effort)

Build the "enhanced dashboard" KPI cards — these need new API endpoints:

| Step | Work |
|------|------|
| 1 | `this-week-progress` — query completed vs. total tasks this week |
| 2 | `routines-kept` — aggregate routine completions / targets |
| 3 | `streak` — compute consecutive days with ≥1 completion |
| 4 | `focus-3` — query focus_items completion for today |
| 5 | `daily-avg` — 7-day rolling completion average + sparkline data |
| 6 | `completed-today` — count completions since midnight |

### Phase 4: Animated Rotation

| Step | Work |
|------|------|
| 1 | Rotation engine — timer-based cycling through pool, round-robin order |
| 2 | AnimatePresence crossfade animation (exit up, enter from below, blur) |
| 3 | Pin logic — auto-pin on filter click, un-pin on filter clear |
| 4 | Hover pause — freeze all rotation while mouse is over KPI bar |
| 5 | Dot indicator — show rotation state below the bar |
| 6 | Manual navigation — click dots to pause + browse with arrows |
| 7 | Priority ordering — attention values surface high-signal cards first |

### Phase 5: Auto-Surfacing & Polish

| Step | Work |
|------|------|
| 1 | Implement auto-surface logic (context-based card appearance) |
| 2 | Dismissable auto-surfaced cards |
| 3 | Responsive mobile layout (2-col scroll) |
| 4 | Animate card add/remove (stagger + slide) |

---

## Relationship to Existing Mockups

This design doc **supersedes** the hardcoded KPI sections in:

- `mockup-dashboard.html` — becomes the "Default" preset
- `mockup-dashboard-enhanced.html` — becomes the "Progress-focused" preset
- `mockup-dashboard-packages.html` — `in-transit` becomes an available KPI card

The mockups remain as visual references but the implementation should follow the configurable approach described here.

---

## Design Decisions

1. **Max 6 cards.** Beyond 6, cards become too narrow to read comfortably. The "enhanced dashboard" mockup has 5, which is the practical sweet spot.

2. **Presets over builder.** Most users won't want to hand-pick KPIs. Presets give immediate value; manual customization is the escape hatch.

3. **Auto-surface is opt-in by default.** Enabled on first install but dismissable. Avoids dashboard clutter for users who prefer a fixed layout.

4. **Separate KPI API.** Decoupling KPI computation from the task list API avoids over-fetching. The task list fetches tasks + pagination; the KPI bar fetches aggregated stats.

5. **My Day should be a KPI, not just a nav item.** The count is already computed (`stats.myDay`). Surfacing it as a stat card creates a natural "pull" to check and plan the day — aligns with ADHD-focused design goals.

6. **Routine rollup KPI complements the Routine Snapshot widget.** The KPI card shows "71% kept" at a glance; the full Routine Snapshot widget below shows the individual routine checklist. They serve different cognitive needs (summary vs. actionable list).

