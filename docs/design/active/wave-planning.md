---
title: "Wave Planning & Goals Smart View"
status: partially-implemented
created: 2026-06-20
last_reviewed: 2026-07-10
category: design
related:
  - "[Goal Promotion](GOAL-PROMOTION-DESIGN.md)"
  - "[Kanban Backlog](../planning/KANBAN-BACKLOG.md)"
  - "[Go-Forward Plan](Mission%20Control%20—%20Go-Forward%20Plan.md)"
mockups:
  - "[mockup-wave-planning.html](../mockups/mockup-wave-planning.html)"
---

# Wave Planning & Goals Smart View — Feature Design Spec

## Summary

Two new capabilities for Mission Control:

1. **Wave/Phase Planning** — a dedicated workflow for grouping tasks into ordered phases ("waves"), with AI-assisted or manual curation. Supports within-project planning and cross-project planning. Three visual surfaces: ordered list, Gantt-style timeline, and kanban swim lanes.

2. **Goals/Ideas Smart View** — a tag-based filtered page that surfaces items tagged `#goal`, `#idea`, or `#brainstorm`, providing a lightweight brainstorming and aspiration-tracking layer without adding new schema entities.

---

## Use Case 1: Wave/Phase Planning

### Problem

The user often needs to:
- Select a subset of tasks (from one project or across all projects)
- Group them into sequential phases based on theme, feature area, dependencies, or logical sequencing
- Visualize the plan as an ordered sequence or timeline
- Get AI help with grouping, ordering, gap detection, and stale-task identification

Currently, this is done manually via external tools (Copilot chat, notes) with no persistent, visual representation in Mission Control.

### User Stories

| # | As a... | I want to... | So that... |
|---|---------|-------------|-----------|
| 1 | Power user | Select tasks and group them into ordered phases | I can see what I'm working on in what order |
| 2 | Power user | Ask AI to propose a phased plan from my backlog | I don't have to manually sort 50+ tasks |
| 3 | Power user | View my plan as a Gantt-style timeline | I can see dependencies and sequencing visually |
| 4 | Power user | Have AI identify missing tasks in my plan | Gaps in my workflow are caught early |
| 5 | Power user | Plan within a single project OR across all projects | Both focused and broad planning are supported |
| 6 | Power user | Approve/reject AI suggestions before they take effect | I stay in control of my task set |

### Interaction Modes

#### Mode 1: AI Suggests (Collaborative)
1. User selects a scope (project or "all tasks")
2. User clicks "Plan Waves" or types in AI chat: "plan next sprint for Mission Control"
3. AI analyzes tasks by:
   - Semantic similarity (feature area, technology, domain)
   - Dependencies (task A blocks task B)
   - Effort estimation (group small tasks together)
   - Due dates and urgency
   - Common tags/categories
4. AI presents a proposed plan with named phases
5. User reviews: can reorder, move tasks between phases, rename phases
6. User approves → plan is saved

#### Mode 2: Manual Curate
1. User opens Wave Planner
2. Multi-selects tasks from a filterable list (same filters as Dashboard)
3. Drags tasks into phase buckets (or creates new phases)
4. Optionally clicks "AI Refine" to get ordering/grouping suggestions within their selections
5. Saves the plan

#### Mode 3: AI Autonomous (with Review)
1. User triggers: "Plan my next 2 weeks" or "Organize the backlog for Kitchen Reno"
2. AI generates a full plan including:
   - Phase groupings with labels and descriptions
   - Suggested new tasks (marked as proposals)
   - Suggested closures for stale/duplicate tasks (marked as proposals)
   - Effort estimates and dependency arrows
3. Presented as a "Plan Proposal" — read-only until approved
4. User can accept all, accept with modifications, or reject

### Visual Surfaces

#### 1. Ordered List View (Primary editing surface)
```
┌─────────────────────────────────────────────────────────────┐
│ Wave Plan: Mission Control v1 Launch          [AI Suggest ▾] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ▼ Phase 1: Core Infrastructure                    4 tasks   │
│   ┃ ○ Source list discovery                    P1  ◌ 2d    │
│   ┃ ○ MS Todo token stability                  P1  ◌ 1d    │
│   ┃ ○ AI agent dispatch UI                     P2  ◌ 3d    │
│   ┃ ○ Recurrence display                       P2  ◌ 1d    │
│                                                             │
│ ▼ Phase 2: Polish & Completeness              5 tasks       │
│   ┃ ○ Add task: duration field                 P3  ◌ 0.5d  │
│   ┃ ○ Calendar events in My Day                P2  ◌ 2d    │
│   ┃ ○ WIP limits for Kanban                    P3  ◌ 1d    │
│   ┃ ○ Motion audit                             P4  ◌ 1d    │
│   ┃ ○ Demo mode data                           P4  ◌ 0.5d  │
│                                                             │
│ ▼ Phase 3: AI & Intelligence                  3 tasks       │
│   ┃ ○ AI Plan My Day full planner              P2  ◌ 3d    │
│   ┃ ○ Smart priority v2                        P3  ◌ 2d    │
│   ┃ ○ Gap: Deploy/release automation ⚡NEW     P3  ◌ 2d    │
│                                                             │
│ ─── AI Suggestions ──────────────────────────────────────── │
│ 💡 Consider closing: "Emoji sweep" (90% done, stale 14d)   │
│ 💡 Missing step: "E2E test pass" between Phase 2 & 3       │
│                                                             │
│              [Save Plan]  [Export]  [Discard]                │
└─────────────────────────────────────────────────────────────┘
```

#### 2. Gantt-Style Timeline View
```
┌──────────────────────────────────────────────────────────────────────┐
│ Timeline: Mission Control v1 Launch                    Week 1─4      │
├──────────────────────────────────────────────────────────────────────┤
│                    W1        W2        W3        W4                   │
│                  ├─────────┼─────────┼─────────┼─────────┤           │
│ Phase 1          ████████████░░░░░░                                  │
│  └ Source list   ██████░░░░                                          │
│  └ Token fix     ███░░                                               │
│  └ Dispatch UI        ████████░                                      │
│  └ Recurrence         ███░                                           │
│                                                                      │
│ Phase 2                    ██████████████░░                           │
│  └ Duration field          ██░                                       │
│  └ Calendar events         ██████░                                   │
│  └ WIP limits                  ████░                                 │
│  └ Motion audit                    ███░                              │
│                                                                      │
│ Phase 3                                  ████████████░░              │
│  └ Plan My Day                           █████████░                  │
│  └ Smart priority v2                           █████░                │
│                                    ───→                               │
│                         (dependency arrow Phase 1→3)                  │
└──────────────────────────────────────────────────────────────────────┘
```

#### 3. Kanban Swim Lanes (Phase per column)
- Reuses existing kanban UI patterns
- Each column = one phase/wave
- Drag between columns to reassign phase
- Column header shows phase name, task count, total effort

### Schema

```sql
-- Wave Plans (top-level container)
CREATE TABLE wave_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  project_id TEXT,                    -- nullable = cross-project plan
  status TEXT DEFAULT 'draft',       -- draft | active | completed | archived
  created_by TEXT DEFAULT 'user',    -- user | ai
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Phases within a plan
CREATE TABLE wave_phases (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES wave_plans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT,                        -- optional accent color for timeline
  estimated_days REAL,
  target_start TEXT,                 -- optional: ISO date for Gantt view
  target_end TEXT,                   -- optional: ISO date for Gantt view
  start_after_phase_id TEXT,         -- dependency: starts after this phase
  status TEXT DEFAULT 'pending',     -- pending | in_progress | completed
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Tasks assigned to phases
CREATE TABLE wave_phase_items (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES wave_phases(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  estimated_effort_hours REAL,
  is_proposed INTEGER DEFAULT 0,     -- 1 = AI suggestion awaiting approval
  proposal_type TEXT,                -- 'new_task' | 'close' | 'split' | null
  proposal_description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- AI plan proposals (before user approval)
CREATE TABLE wave_proposals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES wave_plans(id) ON DELETE CASCADE,
  proposal_json TEXT NOT NULL,       -- full AI-generated plan as JSON
  status TEXT DEFAULT 'pending',     -- pending | accepted | rejected | partially_accepted
  ai_reasoning TEXT,                 -- AI's explanation of grouping logic
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);
```

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/wave-plans` | List all wave plans (filter by project_id, status) |
| POST | `/api/wave-plans` | Create a new wave plan |
| GET | `/api/wave-plans/[id]` | Get plan with phases and items |
| PATCH | `/api/wave-plans/[id]` | Update plan metadata |
| DELETE | `/api/wave-plans/[id]` | Delete plan |
| POST | `/api/wave-plans/[id]/phases` | Add a phase |
| PATCH | `/api/wave-plans/[id]/phases/[phaseId]` | Update phase |
| DELETE | `/api/wave-plans/[id]/phases/[phaseId]` | Delete phase |
| POST | `/api/wave-plans/[id]/phases/[phaseId]/items` | Add task to phase |
| POST | `/api/wave-plans/[id]/ai-suggest` | AI generates plan proposal |
| POST | `/api/wave-plans/[id]/ai-refine` | AI refines existing plan |
| POST | `/api/wave-plans/[id]/proposals/[propId]/accept` | Accept AI proposal |
| POST | `/api/wave-plans/[id]/proposals/[propId]/reject` | Reject AI proposal |

### AI Prompt Strategy

The AI grouping/sequencing considers:

1. **Semantic clustering** — NLP embedding similarity to group tasks by theme (e.g., all "UI polish" tasks, all "infrastructure" tasks)
2. **Tag/category overlap** — tasks sharing tags/categories likely belong together
3. **Project affinity** — tasks from the same project often sequence together
4. **Dependency inference** — if task B references concepts from task A, A likely comes first
5. **Effort balancing** — distribute effort roughly evenly across phases (avoid one massive phase)
6. **Due date awareness** — urgent items pulled into earlier phases
7. **Location/context** — tasks requiring same physical location or tool grouped for efficiency

### Navigation & Access Points

- New sidebar nav item: "Waves" (between Timeline and Portfolio)
- AI Chat: "Plan waves for [project]" triggers wave planning
- Portfolio page: "Plan next phase" button per project
- Kanban: "Create wave plan from board" action

---

## Use Case 2: Goals/Ideas Smart View

### Problem

The user wants a space to capture aspirational ideas, long-term goals, and brainstorm items without cluttering the active task list. These are not immediately actionable but need to be surfaced, developed, and eventually converted to projects/tasks.

### Solution: Tag-Based Smart View

No new schema entities. Uses existing tags system with reserved tag names.

### Reserved System Tags

| Tag | Purpose | Icon |
|-----|---------|------|
| `goal` | Long-term outcome/aspiration | 🎯 |
| `idea` | Raw idea, not yet developed | 💡 |
| `brainstorm` | Collection of related thoughts | 🧠 |
| `aspiration` | Stretch goal / dream | ⭐ |

### Page: `/goals`

**Layout:**
- Grouped sections by tag type (Goals, Ideas, Brainstorms)
- Each item shows: title, linked project (if any), age, related tags
- Quick-add bar at top with auto-tag based on section
- "Develop" button per item → AI expands into potential tasks/projects (propose-only)
- "Convert to Project" action → creates a Hub Project from the goal

**Filtering:**
- By tag type (goal, idea, brainstorm)
- By linked project
- By age (fresh vs. aging)
- By source (if captured from triage queue, social saves, etc.)

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│ Goals & Ideas                              [+ Add Goal] [AI]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 🎯 GOALS (4)                                                │
│ ┃                                                           │
│ ┃ ■ Automate entire home end-to-end         → Home Auto    │
│ ┃   Added 3w ago · #home #automation                        │
│ ┃   [Develop ▸] [→ Project]                                │
│ ┃                                                           │
│ ┃ ■ Ship Mission Control as standalone app  → MC           │
│ ┃   Added 1w ago · #dev #mission-control                   │
│ ┃   [Develop ▸] [→ Project]                                │
│ ┃                                                           │
│ ┃ ■ Build personal finance automation       → Finance      │
│ ┃   Added 2w ago · #finance #automation                    │
│ ┃                                                           │
│ ┃ ■ Create 3D printing workflow pipeline                    │
│ ┃   Added 5w ago · #3dprint                                │
│ ┃                                                           │
│ 💡 IDEAS (6)                                                │
│ ┃                                                           │
│ ┃ ■ Voice-controlled task creation via HA                  │
│ ┃   Added 2d ago · #home #voice                            │
│ ┃                                                           │
│ ┃ ■ Ambient display showing today's focus                  │
│ ┃   Added 4d ago · #hardware #vobot                        │
│ ┃                                                           │
│ ┃ ■ AI agent that triages email into tasks                 │
│ ┃   Added 1w ago · #ai #email                              │
│ ┃   ...                                                    │
│ ┃                                                           │
│ 🧠 BRAINSTORMS (2)                                          │
│ ┃                                                           │
│ ┃ ■ How should MC handle multi-user someday?               │
│ ┃   Added 3w ago · #architecture                           │
│ ┃                                                           │
│ ┃ ■ Cross-device sync strategy options                     │
│ ┃   Added 2w ago · #sync #architecture                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### AI "Develop" Feature

When user clicks "Develop" on a goal/idea:
1. AI reads the goal title + any linked context (project, tags)
2. Generates a structured proposal:
   - 3-5 potential tasks that would advance this goal
   - Suggested project to house them (existing or new)
   - Estimated effort range
   - Dependencies on other goals/projects
3. User reviews and can "Apply" (creates tasks as proposals in wave plan or directly)

---

## Implementation Phases

### Phase 1: Schema + API Foundation ✅
- Add `project_phases`, `project_phase_items` tables (done — replaces original `wave_plans` concept)
- Basic CRUD API endpoints (done)
- Drizzle migrations (done)
- Added `start_after_phase_id` for dependency tracking
- Added `plan_name` and `plan_status` for named plan containers

### Phase 2: Manual Wave Planning UI ✅
- `/waves` page with plan listing and creation
- Cross-project wave plans (phases with null projectId)
- Plan lifecycle management via `/api/wave-plans`
- "Plan next phase" button on portfolio cards
- Dependency selector on phase action bar

### Phase 3: AI Integration ✅
- AI suggest endpoint (grouping + ordering) — `/api/project-phases/ai-suggest`
- AI refine endpoint (improve existing plan) — `/api/project-phases/ai-refine`
- Proposal review UI (PhaseProposalReview component)
- AI chat integration — `planWaves` and `getWavePlans` tools wired into AI assistant
- Chat supports: "Plan waves for [project]" triggers wave planning

### Phase 4: Timeline/Gantt View ✅
- Horizontal timeline visualization (in project detail page)
- Dependency arrows (SVG overlay with curved paths between dependent phases)
- Phase duration bars with task sub-bars
- Zoom levels (day/week/month)
- Today marker

### Phase 5: Goals Smart View ✅ (Separate)
- `/goals` page (already implemented)
- Reserved tag seeding
- Grouped display by tag type
- AI "Develop" feature

---

## Competitive References

- **Linear Cycles** — time-boxed sprints with auto-assignment and progress tracking
- **Notion Roadmaps** — timeline view with drag-to-schedule and dependency arrows
- **Height.app** — AI-powered task grouping and sprint planning
- **Plane.so Cycles** — open-source sprint/cycle management with Gantt
- **Things 3 Areas** — lightweight aspiration containers (similar to our goals view)

---

## Design Decisions (Resolved)

1. **Time dimension** → **Optional per phase.** Phases are primarily sequential (ordering matters), but each phase can optionally have `target_start` and `target_end` dates. When dates are set, the Gantt view becomes calendar-aware; without them, it estimates based on effort. This keeps the default experience lightweight while enabling time-bound planning when needed.

2. **Completed phases** → **Auto-collapse, remain visible.** Completed phases collapse to a single summary row (phase name + "✓ 4/4 tasks done") but remain in the plan for reference. A "Show completed" toggle controls visibility. No hard deletion — phases are archived alongside the plan when the full plan is marked complete.

3. **Entry points** → **Equal: page + AI chat.** Both `/waves` and AI chat are first-class entry points. AI chat can create plans via natural language ("plan my next sprint for MC") and opens the `/waves` page for review. The `/waves` page has direct creation + AI assist buttons. Portfolio page also has "Plan next phase" per project.

4. **Task limit** → **Soft warning at 30+ tasks.** No hard cap. When a plan exceeds 30 tasks, show an informational banner: "Large plans (30+ tasks) work best when split into focused phases — consider breaking this into multiple plans." AI suggestions automatically split large backlogs into separate plans when it makes sense.
