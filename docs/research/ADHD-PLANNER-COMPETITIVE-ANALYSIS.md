---
title: "ADHD Life Admin Planner Competitive Analysis"
status: active
created: 2026-07-10
last_reviewed: 2026-07-10
category: research
related:
  - "[My Day Enhancements](../design/MY-DAY-ENHANCEMENTS.md)"
  - "[Wave Planning](../design/WAVE-PLANNING-DESIGN.md)"
---

# ADHD Life Admin Planner — Competitive Analysis & Feature Ideas for Mission Control

---

## Context

Assessment of the "ADHD Life Admin Planner" (a Notion-style digital planner shared on Reddit, targeting ADHD/life-admin users). The planner takes a fundamentally different design philosophy — gentle, low-pressure, forgiveness-first — compared to Mission Control's dense power-user approach. This analysis identifies features and design ideas worth adopting, adapting, or watching, mapped against our existing roadmap.

---

## Executive Summary

The ADHD planner is optimized for **emotional sustainability** — reducing guilt, overwhelm, and decision paralysis. Mission Control is optimized for **information throughput** — density, speed, and multi-source aggregation. These aren't opposing goals. Several of the planner's features address real gaps in MC's current design around **daily intentionality**, **habit/routine tracking**, **self-regulation awareness**, and **periodic reflection**. The best ideas can be adopted without compromising MC's power-user identity.

### Top 5 Takeaways

1. **Routines & Habits tracker** — a genuinely missing capability in MC (not just recurring tasks)
2. **Calm Mode / Focus Mode** — our planned Focus Mode should borrow the "reduced UI surface" pattern
3. **Weekly/Monthly Reset rituals** — structured reflection is absent from MC and high-value
4. **Dopamine Menu** — a novel reward-after-action mechanic that fits MC's completion animations vision
5. **Energy/Mood tracking** — validates and extends our "Energy-aware What's Next" roadmap item

---

## Feature-by-Feature Analysis

### 1. 🏆 Dopamine Menu — "Pick a Reward"

**What it is:** A widget showing pre-set micro-rewards (5-min dance break, fresh playlist, favorite drink, text a friend, 10-min walk). After completing a task, the user picks a reward.

**MC Status:** No equivalent. We have a planned "completion micro-animation" (particle burst) but nothing behavioral.

**Assessment: NEW — Consider adding as an optional widget**

This is clever behavioral design. It pairs well with our planned "daily completion counter" and micro-animation features. The idea is: the animation gives instant visual feedback, but the dopamine menu gives *behavioral* reinforcement.

**How it could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  🎉 Nice — 5 tasks done today                       │
│                                                      │
│  Pick a reward:                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ ☕ Coffee │ │ 🎵 Music │ │ 🚶 Walk  │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│  ┌──────────┐ ┌──────────┐                          │
│  │ 📱 Break │ │ 🎮 Game  │  [Edit rewards →]       │
│  └──────────┘ └──────────┘                          │
│                                                      │
│  Trigger: every N completions (configurable)         │
└──────────────────────────────────────────────────────┘
```

**Implementation idea:**
- User-configurable reward list stored in settings (simple string + emoji pairs)
- Trigger: after every N task completions (default: 3), show a toast/popover with reward options
- Selecting a reward logs it (optional analytics: "what rewards do I pick most?")
- **MC twist:** tie rewards to the completion counter badge — "✓ 5 today → reward unlocked"
- Keep it optional — power users can disable; it's there for days when motivation is low

**Verdict:** 💡 Consider — Optional widget, low effort, high delight potential. Fits naturally alongside our planned completion counter + micro-animation.

---

### 2. 📌 Top 3 Priorities (Today / This Week)

**What it is:** A constrained list forcing the user to pick only 3 priorities for today and 3 for the week. Not a task list — a *priority declaration*.

**MC Status:** We have My Day (unlimited items) and planned "AI triage" suggestions. No explicit priority cap.

**Assessment: ENHANCE — Add a "Focus 3" widget to My Day / Today view**

The constraint is the feature. MC's My Day can hold dozens of items — which is useful — but also enabling for overwhelm. A "Focus 3" pinned section at the top of My Day creates intentionality without limiting the full list below.

**How it could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  ⚡ FOCUS 3 — TODAY                    [This Week →] │
│  ─────────────────────────────────────────────────── │
│  1. ○ Ship triage queue PR                           │
│  2. ○ Reply to contractor about deck                 │
│  3. ○ Review 3D printer calibration results          │
│  ─────────────────────────────────────────────────── │
│  Drag from your task list below, or AI can suggest   │
└──────────────────────────────────────────────────────┘
```

**Implementation:**
- Pinned section at top of Today/My Day view
- 3-slot limit (strict) — must remove one to add another
- Can drag tasks from the full My Day list into Focus 3
- "This Week" toggle shows a separate 3-slot set for the week
- AI can pre-populate suggestions (extends our "AI triage" roadmap item)
- Persists to `focus_items` table (task_id, scope: 'today' | 'week', date)

**Verdict:** ✅ Add — Directly enhances My Day. Low effort, high signal. Natural extension of existing Today view.

---

### 3. 🔁 Routines & Habits Tracker (with Streaks)

**What it is:** A dedicated weekly grid where habits/routines (Take meds, Drink water, Move/walk, Wind-down by 11) are tracked via checkboxes per day-of-week. Streaks are calculated live. The messaging is "routines that forgive missed days" — no guilt on gaps.

**MC Status:** **No equivalent.** We have recurring tasks (via MS Todo integration), but those are fundamentally different:
- Recurring task = a specific task that regenerates on schedule
- Routine/habit = a pattern you track adherence to over time

Our roadmap has "Task & workflow templates" (medium-term) which covers reusable task patterns, but NOT habit tracking.

**Assessment: NEW — Add as a new view/widget**

This is the biggest gap the ADHD planner reveals. Habits and routines are a distinct data model from tasks. They need:
- A weekly check-in grid (not a task list)
- Streak calculation
- Historical trend view
- No "overdue" pressure — a missed day is just an unchecked box

**How it could work in MC (multi-cadence UI):**

Daily/specific-day routines get the weekly checkbox grid. Flexible routines get countdown bars:
```
┌──────────────────────────────────────────────────────────────┐
│  DAILY ROUTINES                        Week: Jul 7–13, 2026 │
│  Routine              M   T   W   T   F   S   S    Streak   │
│  ─────────────────────────────────────────────────────────── │
│  Take vitamins        ✓   ✓   ✓   ✓   ✓   ·   ·    18 🔥   │
│  Morning workout      ✓   ✓   ✓   ✓   ·   ·   ·    4       │
│                                                              │
│  SPECIFIC DAYS                                               │
│  Gym (M/W/F)          ✓   —   ✓   —   ·   —   —    8 🔥    │
│  Meal prep (Sun)      —   —   —   —   —   —   ·    3       │
│                                                              │
│  FLEXIBLE / TARGET-BASED                                     │
│  ─────────────────────────────────────────────────────────── │
│  Exercise 3x/week     ●●○  Done: 2/3            [+1]       │
│  Call Mom  (3-4 days)    Last: 2 days ago    ✓ On track     │
│  Clean bath (~weekly)    Last: 5 days ago    ⚡ Due soon     │
│  Budget review (monthly) Last: 12 days ago   ✓ On track     │
│  Quarterly goals         Last: 6 weeks ago   ✓ On track     │
│                                                              │
│  Over-completions this week: Exercise 5/3 (+2)              │
│  Week: 71% complete                    [+ Add routine]      │
└──────────────────────────────────────────────────────────────┘
```

Over-completion: when a target-based routine exceeds its goal, the system logs it. Over time, consistent over-completion triggers an AI suggestion: "Exercise is easy at 3x/week — adjust to 4x?" Conversely, consistent under-completion suggests relaxing the cadence rather than shaming.

**Data model (multi-cadence):**
```sql
CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  cadence_type TEXT NOT NULL,        -- daily | specific_days | x_per_week | every_n_days | weekly | monthly | quarterly
  cadence_days TEXT,                  -- JSON array: [1,3,5] for specific_days (1=Mon, 7=Sun)
  cadence_target INTEGER,            -- e.g. 3 for "3x/week", null for daily
  cadence_min_interval INTEGER,      -- min days between (for every_n_days)
  cadence_max_interval INTEGER,      -- max days before nudge (e.g. "don't go more than 4 days")
  cadence_preferred_day INTEGER,     -- preferred day for weekly/monthly (optional)
  sort_order INTEGER,
  created_at TIMESTAMP,
  archived_at TIMESTAMP
);

CREATE TABLE routine_completions (
  id TEXT PRIMARY KEY,
  routine_id TEXT REFERENCES routines(id),
  completed_date DATE NOT NULL,
  created_at TIMESTAMP
  -- NOTE: no UNIQUE constraint — allows multiple completions per day for over-completion tracking
);
```

**Cadence types explained:**

| Type | Example | UI | Streak Logic |
|------|---------|-----|-------------|
| `daily` | Take vitamins | Weekly checkbox grid | Consecutive days completed |
| `specific_days` | Gym (M/W/F) | Grid with non-scheduled days dimmed | Consecutive scheduled-day completions |
| `x_per_week` | Exercise 3x/week | Dot progress (●●○) + [+1] button | Consecutive weeks where target met |
| `every_n_days` | Call Mom (every 3-4 days) | Countdown bar (fills as days pass) | Consecutive completions within max_interval |
| `weekly` | Meal prep | Single checkbox per week | Consecutive weeks completed |
| `monthly` | Budget review | Single checkbox per month | Consecutive months completed |
| `quarterly` | Goals review | Single checkbox per quarter | Consecutive quarters completed |

**Over-completion tracking:**
- For `x_per_week`: completing beyond target (e.g., 5x when target is 3x) logs extra completions
- Over time, consistent over-completion triggers an AI suggestion to increase the cadence target
- Conversely, consistent under-completion suggests decreasing or switching cadence type (e.g., "daily" → "weekdays only")
- The system adapts to the user's actual behavior rather than shaming them for not meeting arbitrary targets

**Streak calculation varies by type:**
- `daily` / `specific_days` → consecutive scheduled-day completions
- `x_per_week` → consecutive weeks where target was met
- `every_n_days` → consecutive completions that stayed within the max_interval window
- `weekly` / `monthly` / `quarterly` → consecutive periods with at least one completion

**Dashboard widget:** A "Routine Snapshot" card (like the ADHD planner shows) on the main dashboard showing today's routines with quick check-off + streak counts.

**Verdict:** ✅ Add — New view + dashboard widget. This is genuinely missing from MC and high-value for the "solo operator" persona.

---

### 4. 🧘 Calm Mode / Reduced UI Mode

**What it is:** A global toggle that strips the interface to essentials: today's focus, next small action, top tasks, and a "gentle reset" link. Hides all widgets, metrics, budgets, and tracking. The messaging: "Just the essentials — for low-energy or overwhelmed days."

**MC Status:** We have a planned "Focus Mode" (near-term roadmap) — hide sidebar + alerts, full-width task list.

**Assessment: ENHANCE — Expand Focus Mode design to include a "Calm" tier**

Our planned Focus Mode is about *distraction reduction* (hide chrome, go full-width). The ADHD planner's Calm Mode is about *cognitive load reduction* (show less information entirely). These are complementary:

| Mode | What's hidden | Purpose |
|------|---------------|---------|
| Normal | Nothing | Full power-user density |
| Focus | Sidebar, alerts panel | Distraction-free work session |
| **Calm** | Sidebar, alerts, metrics, charts, secondary widgets | Low-energy day, just show what to do next |

**How Calm Mode could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  Mission Control              Thu, Jul 10   [Calm ●] │
│  ──────────────────────────────────────────────────── │
│                                                      │
│  YOUR FOCUS TODAY                                    │
│  Ship the triage queue PR and reply to contractor    │
│                                                      │
│  ──────────────────────────────────────────────────── │
│                                                      │
│  NEXT SMALL ACTION                                   │
│  Review the triage PR diff                           │
│  [Go there →]                                        │
│                                                      │
│  ──────────────────────────────────────────────────── │
│                                                      │
│  TOP TASKS                                           │
│  ○ Ship triage queue PR                              │
│  ○ Reply to contractor                               │
│  ○ Order filament                                    │
│                                                      │
│  ──────────────────────────────────────────────────── │
│                                                      │
│  ✓ 2 done today — that counts.                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Implementation:**
- Global toggle in header (persisted in user preferences)
- Calm mode renders a simplified layout component that only shows:
  - Today's focus text (free-form, user-written)
  - "Next small action" (AI-picked or manually set — the single most important next step)
  - Top 3-5 tasks (from My Day / Focus 3)
  - Completion count with encouraging copy
- All other widgets, charts, sidebar items are hidden via CSS/conditional render
- Keyboard shortcut: `Ctrl+Shift+C` to toggle

**MC-specific twist:** "Next small action" could be AI-powered — analyzing your task list for the shortest/easiest item to build momentum. This aligns with our "Energy-aware What's Next" roadmap item.

**Verdict:** ✅ Add — Expands our planned Focus Mode into a two-tier system. Especially valuable on days when the full MC dashboard feels like too much.

---

### 5. 🔄 Weekly Reset / Monthly Reset

**What it is:** Structured reflection pages. Weekly Reset asks "What went okay?" and "What needs a reset?" with free-text answers. Monthly Reset presumably covers broader review. The copy: "Look back with kindness. Decide what to carry forward."

**MC Status:** **No equivalent.** No reflection, retrospective, or reset mechanism exists or is on the roadmap.

**Assessment: NEW — Add as a periodic workflow**

This is high-value for the "solo operator" persona. Without a team doing retrospectives, personal reflection is the only feedback loop. The ADHD planner gets the UX right: guided prompts, not blank journals.

**How it could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  Weekly Reset                      Week of Jul 7–13  │
│  ──────────────────────────────────────────────────── │
│                                                      │
│  📊 THIS WEEK'S STATS (auto-populated)               │
│  Tasks completed: 12 │ Created: 8 │ Carried fwd: 3   │
│  Routines kept: 71% │ Focus 3 hit rate: 4/5 days     │
│                                                      │
│  ──────────────────────────────────────────────────── │
│                                                      │
│  ✅ WHAT WENT WELL?                                  │
│  ┌──────────────────────────────────────────────┐    │
│  │ Shipped triage queue, stayed on top of email  │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  🔧 WHAT NEEDS ADJUSTMENT?                           │
│  ┌──────────────────────────────────────────────┐    │
│  │ 3D print projects keep getting bumped. Need   │    │
│  │ to block dedicated time on weekends.          │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  🎯 CARRY FORWARD TO NEXT WEEK                      │
│  Auto-populated from incomplete Focus 3 items:       │
│  ○ Deck contractor follow-up                         │
│  ○ Calibrate printer                                 │
│  [+ Add manually]                                    │
│                                                      │
│  🧹 CLEAN UP                                        │
│  3 tasks have been on your list 14+ days:            │
│  ○ Organize garage shelving    [Keep] [Archive]      │
│  ○ Research smart locks        [Keep] [Archive]      │
│  ○ Fix leaky faucet            [Keep] [Archive]      │
│                                                      │
│  ──────────────────────────────────────────────────── │
│  [Complete Reset →]                                   │
└──────────────────────────────────────────────────────┘
```

**Data model:**
```sql
CREATE TABLE resets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'weekly' | 'monthly'
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  went_well TEXT,
  needs_adjustment TEXT,
  notes TEXT,
  stats JSON,                   -- auto-calculated snapshot
  completed_at TIMESTAMP,
  created_at TIMESTAMP
);
```

**MC-specific enhancements vs. the ADHD planner:**
- **Auto-populated stats** — we have the data (task completions, sources, projects). The ADHD planner doesn't aggregate anything.
- **Stale task surfacing** — during reset, surface tasks >14 days old with no activity. Offer archive/keep/reschedule.
- **AI summary** — "This week you focused mostly on [home improvement] and [development]. [3D printing] got no attention." Leverage existing AI layer.
- **Carry-forward automation** — incomplete Focus 3 items auto-populate next week's candidates.

**Monthly Reset** extends this with:
- Month-over-month completion trends
- Project health changes
- Routine streak summaries
- Goal progress check-in (ties to Goals Smart View)

**Verdict:** ✅ Add — New view with weekly/monthly cadence. High value, moderate effort. The auto-populated stats differentiate MC's version significantly.

---

### 6. 💭 Brain Dump / Quick Capture

**What it is:** A zero-friction text input. "Capture now, sort later. No categories required." Items land in an inbox and can be sorted into tasks/plans later. The flow: Dump → Sort → Done.

**MC Status:** We have the **Triage Queue** which serves a similar purpose but is oriented toward *external* content (Reddit saves, GitHub stars, share-sheet captures). We also have a "quick-add" in the Kanban and a planned keyboard command palette.

**Assessment: ENHANCE — Add an "Inbox" / Quick Capture mode to the Triage Queue**

The Triage Queue already does "capture → sort → act" but for external content. Brain Dump is the same pattern for *internal thoughts*. Rather than a separate view, this could be a new input mode on the Triage Queue or a persistent quick-capture widget.

**How it could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  Quick Capture                          [⌘+K → "q"] │
│  ┌──────────────────────────────────────────────┐    │
│  │ Type a thought, press Enter...               │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Recent captures:                                    │
│  — Look into home assistant voice integration   3m   │
│  — Deck stain color: "Redwood Natural"         1h   │
│  — Ask Mike about the router jig               2h   │
│                                                      │
│  [Sort captures →] opens Triage Queue filtered       │
└──────────────────────────────────────────────────────┘
```

**Implementation options:**
1. **Command palette extension** — `Ctrl+K` → type "q" or "capture" → inline text input → saves to triage queue with source="brain_dump"
2. **Persistent widget** — small expandable input on the dashboard (like the ADHD planner's "Quick capture" box)
3. **Triage Queue tab** — add a "Brain Dump" filter/source type to existing triage queue

**Verdict:** 💡 Consider — Useful but partially covered by Triage Queue. Best approach: add `source: "brain_dump"` to triage items + a quick-capture hotkey in the command palette.

---

### 7. 📈 Energy / Mood Tracking

**What it is:** A dedicated view for logging daily energy and mood levels. The ADHD planner includes this under "Self-Care" — specific details aren't visible in the screenshots but the nav item exists.

**MC Status:** On the **longer-term roadmap** as "Energy-aware What's Next" — AI factors in energy level for task suggestions. But no tracking UI is designed yet.

**Assessment: ENHANCE — Design the tracking UI that feeds the Energy-aware AI**

The ADHD planner validates that energy/mood tracking belongs in a planner app. For MC, the value isn't the tracking itself — it's the data it provides to the AI suggestion engine.

**How it could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  How's your energy right now?          [Skip today]  │
│                                                      │
│   🔋          ⚡          ☕          🔥             │
│   Low     Medium      Good        High               │
│                                                      │
│  Optional: what's affecting it?                      │
│  [Bad sleep] [Stressed] [Good workout] [Custom...]   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Implementation:**
- Quick prompt when opening My Day (skippable, one-tap)
- Stored in `energy_logs` table (date, level 1-4, tags, timestamp)
- Feeds into AI triage: low energy → suggest short/easy tasks; high energy → suggest deep work
- Weekly Reset shows energy trend chart
- NOT a full mood journal — keep it to 1-tap entry, max 2 taps with optional tags

**Verdict:** ✅ Add — Accelerates the "Energy-aware What's Next" roadmap item by building the data collection UI first. Simple, low-effort, high-value for AI features.

---

### 8. 💸 Budget & Bills Tracker

**What it is:** Track subscriptions, recurring bills, and spending categories. Shows "This month / Paid / To pay" breakdown. Recurring bills auto-appear each month.

**MC Status:** Not on roadmap. MC is scoped to tasks, projects, and alerts.

**Assessment: OUT OF SCOPE — Do not add**

This is a personal finance feature that doesn't align with MC's core mission of task/project aggregation. If anything, bill *reminders* could come through as tasks from a future integration (e.g., a bills connector that creates tasks for unpaid bills). But building a budget tracker inside MC would dilute the product.

**Verdict:** ❌ Skip — Out of scope. Bills-as-tasks via a connector is the MC-native approach if ever needed.

---

### 9. 📅 Appointments & Documents Views

**What it is:** Separate views for upcoming appointments (with calendar) and saved documents/files.

**MC Status:** We already have Outlook Calendar integration surfacing events in My Day. Documents aren't tracked.

**Assessment: ALREADY COVERED (calendar) / OUT OF SCOPE (documents)**

Calendar events are already integrated into the My Day timeline. A separate "Appointments" view isn't needed — the calendar ghosting feature (in MY-DAY-ENHANCEMENTS.md Phase 2) handles this better by showing events in context. Documents storage is out of scope.

**Verdict:** ❌ Skip — Calendar already integrated; documents out of scope.

---

### 10. 🎯 Goals View

**What it is:** Separate goals page (not visible in detail in screenshots, but listed in nav).

**MC Status:** On the **near-term roadmap** as "Goals & Ideas Smart View" — tag-based filtered page for `#goal`, `#idea`, `#brainstorm`.

**Assessment: ALREADY PLANNED — Validate approach**

Our planned approach (tag-based, no new schema entity, AI "Develop" feature to evolve ideas into projects) is more sophisticated than what the ADHD planner likely offers. The planner validates that users want a distinct goals space, which confirms our roadmap item.

**One thing to borrow:** The ADHD planner's emphasis on "If you do 1 thing this week, make it X" could enhance our Goals view — surface the single most impactful goal-aligned task as a prominent banner.

**Verdict:** ✅ Already planned — Add the "This week, one thing" banner to the Goals Smart View design.

---

### 11. 🌊 "This Week, One Thing" Banner

**What it is:** A prominent card on the dashboard: "If you only do one admin thing this week, make it this. Everything else is a bonus." Shows a single, clear priority.

**MC Status:** No equivalent. We have My Day suggestions and AI triage but nothing that distills to ONE thing.

**Assessment: NEW — Add as a dashboard widget**

This is excellent for reducing decision paralysis. It's different from "Focus 3" (which is about today's top tasks) — this is about the *one thing that matters most this week* even if you do nothing else.

**How it could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  THIS WEEK, ONE THING                                │
│  ──────────────────────────────────────────────────── │
│  Ship the triage queue PR                            │
│                                                      │
│  If you only get one thing done this week,           │
│  make it this. Everything else is a bonus.           │
│                                                      │
│  [Change →]                 auto-selected by AI      │
└──────────────────────────────────────────────────────┘
```

**Implementation:**
- AI-selected based on: highest priority task + nearest due date + most blocked downstream work
- User can override manually
- Persists for the week (doesn't change daily)
- Shows on dashboard + Today view header
- Completing it triggers a special celebration (ties to dopamine menu / completion animation)

**Verdict:** ✅ Add — Dashboard widget. Minimal effort, high clarity value. AI-powered selection leverages existing infrastructure.

---

### 12. 📊 Progress Overview / Rollup Dashboard Widgets

**What it is:** The ADHD planner dashboard shows rollup cards: "Tasks this week — 20%", "Routines kept — 38%", "Bills paid — 5%". Plus a "Momentum" row: "You showed up 7 of 7 days this week."

**MC Status:** We have project health detection and portfolio progress, but no *personal progress* rollups on the dashboard.

**Assessment: ENHANCE — Add personal progress widgets to the dashboard**

Our dashboard currently shows task lists and project status. Adding personal progress metrics creates a "command center" feel that aligns with MC's identity.

**Suggested dashboard widgets:**

```
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ This Week   │ │ Routines    │ │ Streak      │ │ Focus 3     │
│ ■■■□□ 12/30 │ │ ■■■■□ 71%  │ │ 🔥 7 days   │ │ ✓✓○ 2/3    │
│ tasks done  │ │ kept        │ │ showing up  │ │ today       │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

**Verdict:** ✅ Add — Natural dashboard enhancement. Depends on Routines feature (#3) for some metrics. Task completion stats can be built immediately.

---

### 13. 🏠 "Body Double" Timer

**What it is:** A 25-minute Pomodoro-style timer embedded in the dashboard. The framing is "body double" — the idea that just starting is the hardest part, so set a timer and begin. "Camera optional. Starting is the whole battle."

**MC Status:** We have a planned "Focus countdown timer" (medium-term) — a "Mission Impossible" countdown for procrastinated tasks.

**Assessment: REPLACE / MERGE — Reframe our timer feature**

Our planned timer is pressure-based ("turns red, pulses in final minutes, stressful by design"). The ADHD planner's timer is encouragement-based ("just begin, starting is the whole battle"). These serve different needs:

| Timer type | When to use | Tone |
|-----------|-------------|------|
| **Focus timer** (ADHD planner style) | Starting a work session | Encouraging — "you've got this" |
| **Pressure timer** (MC's current plan) | Task you keep avoiding | Urgent — "do it now" |

**Recommendation:** Keep both. Rename our planned feature to "Deadline timer" and add a separate "Focus session" timer that's gentler.

**Verdict:** 💡 Consider — Two timer modes instead of one. Focus timer = gentle start aid; Deadline timer = pressure mechanic for procrastinated tasks.

---

### 14. 🏅 "Recent Wins" Section

**What it is:** A section at the bottom of the dashboard showing recently completed tasks as green pill badges. Framing: "proof you're fine."

**MC Status:** No equivalent. Completed tasks disappear from view.

**Assessment: NEW — Add as a dashboard widget**

This is a simple, high-impact feature. Showing completed tasks as "wins" provides positive reinforcement and combats the feeling that your task list never shrinks.

**How it could work in MC:**

```
┌──────────────────────────────────────────────────────┐
│  Recent Wins — last 7 days                           │
│  ✓ Shipped triage queue  ✓ Fixed CORS  ✓ Paid rent  │
│  ✓ Organized 3D files  ✓ Called electrician          │
└──────────────────────────────────────────────────────┘
```

**Verdict:** ✅ Add — Dashboard widget. Trivial to implement (query completed tasks), nice morale boost.

---

## UI / Design Ideas Worth Borrowing

### A. Encouraging Copy / Micro-copy Tone

The ADHD planner uses gentle, encouraging language throughout:
- "You are not behind. There is only the next small thing."
- "Missing a day is normal." — built into the planner
- "No shame-based copy — ever"
- "Tasks without the guilt trip"

**MC application:** Our voice is "direct, no filler" which is good. But we should ensure our empty states and edge cases aren't sterile. The key insight: **every empty state is a moment where the user might disengage.** Warm, action-oriented copy keeps them in the flow.

| Scenario | Current MC | Proposed MC | Why |
|----------|-----------|-------------|-----|
| No tasks due today | "No tasks for today" | "Your day is open. What matters most?" | Turns a dead-end into a prompt |
| All tasks complete | "All tasks completed" | "Everything done. That's a good day. ✓" | Celebrates instead of just stating |
| Overdue tasks | Red badge: "3 overdue" | "3 slipped — pick one to start fresh." | Action-oriented, no shame |
| Empty Routines | "No routines configured." | "Start with one small routine. That's enough." | Lowers the bar to entry |
| Broken streak | "Streak reset to 0." | "Streak paused — you'll pick it back up." | No guilt framing |
| No Focus 3 set | "No focus items selected." | "Pick your top 3 for today. The rest can wait." | Guides the next action |

**Micro-copy Principles for MC:**
1. **Direct but warm** — no filler, but no harshness either
2. **Action-oriented** — every empty state suggests what to do next
3. **No shame language** — never use "failed", "missed", "behind" in system copy
4. **Celebrate completion** — make finishing things feel good

This does NOT change our core brand ("focused, capable, efficient") — it extends it to the edges where users are most vulnerable to disengagement.

**See mockup:** `mockups/mockup-design-enhancements.html` (Tab 2) — 6 before/after comparisons.

**Verdict:** ✅ Adopt — Audit all empty states, error messages, and zero-data screens. Low effort, high retention impact.

### B. Theme Switcher (Color Accents)

The ADHD planner has 5+ color themes (visible as colored dots in the header). Users can switch the entire UI's accent color.

**MC application:** We're dark-first with blue (`#3b82f6`) as the sole accent. The design system already uses accent tokens (`colors.accent`, `colors.accent-hover`, `colors.accent-muted`) — these are one CSS custom property swap away from supporting multiple colors.

**Proposed accent palette (5 options):**

| Name | Hex | HSL | Personality |
|------|-----|-----|-------------|
| Blue (default) | `#3b82f6` | 217° 91% 60% | Professional, focused |
| Green | `#10b981` | 160° 84% 39% | Calm, natural |
| Purple | `#8b5cf6` | 258° 90% 66% | Creative, playful |
| Amber | `#f59e0b` | 38° 92% 50% | Warm, energetic |
| Rose | `#f43f5e` | 347° 77% 50% | Bold, urgent |

**Implementation approach:**
1. Define CSS custom properties on `:root`: `--accent`, `--accent-light`, `--accent-hover`, `--accent-muted`
2. Replace all hardcoded `blue-600` / `blue-50` Tailwind classes with custom property references in key components (nav active state, buttons, checkboxes, focus rings, progress bars)
3. Store preference in `user_preferences` table (key: `accent_color`)
4. Render 5 swatches in Settings → Appearance section + optionally in the header (like the ADHD planner)

This is purely cosmetic — no functional changes. Estimated effort: ~2 hours to refactor accent references + add the picker.

**See mockup:** `mockups/mockup-design-enhancements.html` (Tab 3) — live-switching theme demo.

**Verdict:** 💡 Consider — Low effort via CSS custom properties. Nice personalization without design system compromise.

### C. Navigation Category Grouping (Top-Nav Compatible)

The ADHD planner groups sidebar nav items into sections: COMMAND, DO, TRACK, REVIEW, REFERENCE. This creates clear mental models for where things live.

**MC application:** Our navigation is **top horizontal tabs** (Dashboard, My Day, Kanban, AI Assistant), with the left sidebar reserved for filtering/sources within a view. As we add Routines, Goals, Weekly Reset, Monthly Reset, and Energy Log, the top nav will overflow beyond 5-6 items.

**Approach: Hybrid (phased)**

**Phase 1 (now):** Top nav keeps primary views visible + a "More ▾" dropdown that groups secondary views by category:

```
[Dashboard] [My Day] [Tasks] [Kanban] [More ▾]
                                        ┌─────────────────┐
                                        │ TRACK            │
                                        │   Routines       │
                                        │   Goals          │
                                        │   Energy Log     │
                                        │ REVIEW           │
                                        │   Weekly Reset   │
                                        │   Monthly Reset  │
                                        │ TOOLS            │
                                        │   Triage Queue   │
                                        │   Wave Planner   │
                                        │   AI Assistant   │
                                        └─────────────────┘
```

**Phase 2 (later, once command palette is mature):** Migrate to pinnable top tabs. Users choose their 4-5 most-used views as persistent tabs; everything else is accessed via `Ctrl+K` command palette, which uses the same COMMAND → DO → TRACK → REVIEW → TOOLS categories for organization.

```
[Dashboard] [My Day] [Kanban] [Routines] [+]   ← user-pinnable
                                          └─ palette with categorized views
```

**Why this grouping model works (regardless of where it renders):**
- **Maps to a workflow loop:** Command (orient) → Do (execute) → Track (measure) → Review (reflect)
- **Mental model:** users learn the categories once, then know where new features will slot in
- **Scales:** the "More" dropdown absorbs new views without cluttering the top bar
- **Left sidebar stays focused:** continues to serve as contextual filtering for the active view (Sources, Quick Filters, Projects) — not as global navigation

**Implementation (Phase 1):**
- Add a "More" dropdown button to the top nav bar (Radix DropdownMenu or similar)
- Group items with category headers inside the dropdown (same `text-[10px] uppercase tracking-widest` style)
- Primary tabs stay hardcoded: Dashboard, My Day, Tasks, Kanban
- Dropdown items: everything else, grouped by TRACK / REVIEW / TOOLS

**See mockup:** `mockups/mockup-design-enhancements.html` (Tab 1) — shows the category structure (note: mockup currently uses sidebar layout for comparison purposes; actual implementation uses top-nav + dropdown as described here).

**Verdict:** ✅ Adopt — Add "More ▾" grouped dropdown as we ship the first new view (Routines). Evolve to pinnable tabs later.

---

## Proposed Bottom Tab Bar (Mobile / Compact Layout)

The ADHD planner's bottom tabs are interesting: `Home | Today | Daily Plan | Weekly Plan | Task Hub | Brain Dump | Habits | Self-Care | Energy | Appointments | Goals`

For MC on smaller viewports or a future mobile PWA, a condensed tab bar could work:

```
[ Dashboard ] [ Today ] [ Tasks ] [ Routines ] [ Triage ] [ More... ]
```

**Verdict:** 💡 Consider — Future mobile/responsive enhancement.

---

## Summary Matrix

| # | Feature | Status vs MC | Action | Priority | Effort |
|---|---------|-------------|--------|----------|--------|
| 1 | Dopamine Menu | New | Consider as optional widget | Low | Low |
| 2 | Focus 3 (Top 3 Today/Week) | Enhances My Day | **Add** | High | Low |
| 3 | Routines & Habits Tracker | New capability | **Add** | High | Medium |
| 4 | Calm Mode | Extends Focus Mode | **Add** | Medium | Low |
| 5 | Weekly/Monthly Reset | New capability | **Add** | Medium | Medium |
| 6 | Brain Dump / Quick Capture | Enhances Triage Queue | Consider | Low | Low |
| 7 | Energy/Mood Tracking | Accelerates roadmap | **Add** | Medium | Low |
| 8 | Budget & Bills | Out of scope | Skip | — | — |
| 9 | Appointments/Documents | Already covered | Skip | — | — |
| 10 | Goals View | Already planned | Validate | — | — |
| 11 | "One Thing This Week" | New widget | **Add** | High | Low |
| 12 | Progress Rollup Widgets | Enhances dashboard | **Add** | Medium | Low |
| 13 | Body Double Timer | Merges with planned timer | Consider | Low | Low |
| 14 | Recent Wins | New widget | **Add** | Medium | Low |
| A | Encouraging micro-copy | Design enhancement | **Adopt** | Medium | Low |
| B | Theme/accent switcher | Design enhancement | Consider | Low | Low |
| C | Nav category grouping (More ▾ dropdown) | Design enhancement | **Adopt** | Medium | Low |

---

## Recommended Implementation Order

### Phase 1: Quick Wins (low effort, immediate value)
1. Focus 3 widget on Today view
2. "This Week, One Thing" dashboard banner
3. Recent Wins dashboard widget
4. Nav category grouping ("More ▾" dropdown)
5. Encouraging micro-copy audit

### Phase 2: Core New Features
6. Routines & Habits tracker (new view + dashboard snapshot widget)
7. Energy/mood quick-entry (feeds AI suggestions)
8. Progress rollup dashboard widgets

### Phase 3: Reflection & Modes
9. Weekly Reset view (with auto-stats)
10. Monthly Reset view
11. Calm Mode (extends Focus Mode)

### Phase 4: Delight & Polish
12. Dopamine Menu (ties to completion counter)
13. Focus session timer
14. Quick Capture hotkey in command palette
15. Accent color themes

---

## Mockup Reference

| Mockup | Features Shown | File |
|--------|---------------|------|
| My Day Enhancements | Focus 3, One Thing This Week, Calm Mode, Energy Check-in | `mockups/mockup-focus3-calm-energy.html` |
| Routines & Weekly Reset | Habits tracker with streaks, Weekly Reset with auto-stats | `mockups/mockup-routines-reset.html` |
| Enhanced Dashboard | Progress rollups, Recent Wins, Quick Capture, Timer, Dopamine Menu | `mockups/mockup-dashboard-enhanced.html` |
| Design Enhancements | Sidebar categories, Micro-copy before/after, Accent color themes | `mockups/mockup-design-enhancements.html` |

Open any mockup in a browser to interact with tabs, toggles, and theme switching.
