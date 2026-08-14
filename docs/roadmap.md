---
title: "Roadmap"
sidebar_label: Roadmap
sidebar_position: 5
status: active
created: 2026-07-10
last_reviewed: 2026-07-22
last_reviewed_note: "Consolidated from 3 overlapping plan docs; statuses verified against actual codebase"
category: planning
project_status: "MVP ~85% Complete | Phases 1-3 done, Phase 4 mostly done, Phase 5 open"
code_quality_score: 8/10
design_system_compliance: 9/10
production_readiness: "Core stable; PWA partially online"
related:
  - "[ADHD Planner Competitive Analysis](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md)"
  - "[Oriti/Anythings Competitive Analysis](../research/COMPETITIVE-ANALYSIS-ORITI-ANYTHINGS.md)"
---

---
  
## Executive Summary  
  
Mission Control is a **personal task & alert aggregation hub** — a dense, dark-first command center for managing 50+ active tasks across Microsoft Todo, GitHub, Outlook, and future connectors. The architecture is solid (Next.js 14 + Drizzle/SQLite + TanStack Query + Framer Motion), the design system is faithfully implemented, and core features (dashboard, kanban, triage, AI assistant, timeline, settings) are functional.  
  
### What's Working Well  
- ✅ Design token system perfectly implemented (colors, typography, spacing, motion)  
- ✅ 9 primary views built and functional (Dashboard, My Day, Kanban, AI, Triage, Settings, Portfolio, Project Detail, Timeline)  
- ✅ Multi-connector sync engine (MS Todo 90%, GitHub 95%, Outlook 80%)  
- ✅ AI chat with streaming + tool integration  
- ✅ Push-before-pull sync strategy with conflict resolution  
- ✅ Dark-first UI matching Linear/Raycast inspiration  
- ✅ Responsive mobile navigation  
- ✅ Keyboard shortcuts system  
  
### Top Concerns (as of July 2026)  
- ~~🔴 Webhook auth not implemented~~ ✅ Fixed  
- ~~🔴 Subtask templates stored in-memory only~~ ✅ Fixed — persisted in DB  
- ~~🔴 Schema mismatch on subtask creation~~ ✅ Fixed  
- ~~🟠 No error boundaries~~ ✅ Fixed  
- ~~🟠 Inline styles scattered across components~~ ✅ Migrated to Tailwind  
- ~~🟠 8+ designed mockup pages not yet built~~ ✅ Most now built  
- ~~🟠 Source list discovery not wired~~ ✅ Fixed  
- ~~🟠 No routines/habits tracking~~ ✅ Full routines system built  
- ~~🟠 No reflection/reset workflow~~ ✅ Weekly/Monthly Reset built  
- ~~🟡 No structured logging~~ ✅ Pino logger with correlation IDs  
- ~~🟡 Nav will overflow~~ ✅ "More ▾" dropdown implemented  
- 🟡 No undo/redo system (5-second undo window still unbuilt)  
- 🟡 Insights page not yet built (stats engine ready)  
- 🟡 Triage collections not yet implemented  
- ~~🟡 Multi-task splitting not yet implemented~~ ✅ NLP compound splitting, triage AI extraction, checklist-to-subtask sync  
- 🟡 No light theme or accent color customization  
- 🟡 Mobile PWA: offline page works but no push notifications
  
---  
  
## Current Coverage Matrix  
  
### Pages: Designed vs Built  
  
| View                     | Designed | Built | Status                                                |     |
| ------------------------ | -------- | ----- | ----------------------------------------------------- | --- |
| Dashboard                | ✅        | ✅     | Done                                                  |     |
| My Day                   | ✅        | ✅     | Done — duration field added                           |     |
| Kanban Board             | ✅        | ✅     | Done — WIP limits deferred (intentional)              |     |
| AI Assistant             | ✅        | ✅     | Done — dispatch panel + confirmation + tool display   |     |
| Triage Queue             | ✅        | ✅     | Done                                                  |     |
| Settings/Connectors      | ✅        | ✅     | Done — source list wired                              |     |
| Portfolio/Projects       | ✅        | ✅     | Done — epics removed                                  |     |
| Project Detail           | ✅        | ✅     | Done                                                  |     |
| Timeline/Calendar        | —        | ✅     | Done — bonus, not in original mockups                 |     |
| Wave Planning (Phases)   | ✅        | ✅     | Done — schema, AI suggestions, Gantt view             |     |
| Goals & Ideas            | ✅        | ✅     | Done — Goal→Project promotion                         |     |
| **Insights Feed**        | ✅        | ❌     | WIP — stats engine built, page not yet                |     |
| **Capture Multimodal**   | ✅        | ✅     | Done — multi-task splitting, NLP compound detection, triage AI extraction |     |
| Shipments                | ✅        | ❌     | Not started                                           |     |
| Smart Score List         | ✅        | ✅     | Done — via Zen Mode                                   |     |
| Dashboard Packages       | ✅        | ❌     | Not started                                           |     |
| Triage Gallery           | ✅        | ✅     | Done — TriageGalleryView component                    |     |
| Focus 3 Widget           | ✅        | ✅     | Done                                                  |     |
| "One Thing" Banner       | ✅        | ✅     | Done                                                  |     |
| Recent Wins              | ✅        | ✅     | Done                                                  |     |
| Routines & Habits        | ✅        | ✅     | Done — full system with streaks + heatmap             |     |
| Weekly/Monthly Reset     | ✅        | ✅     | Done — ResetView + AI summary                         |     |
| Energy Check-in          | ✅        | ✅     | Done — feeds AI suggestions                           |     |
| Calm Mode                | ✅        | ✅     | Done                                                  |     |
| Priority Entities        | ✅        | ✅     | Done                                                  |     |
| Priority Setup Wizard    | ✅        | ✅     | Done                                                  |     |
| Snooze + Score Animation | ✅        | ✅     | Done                                                  |     |
| Enhanced Dashboard       | ✅        | ✅     | Done — progress rollups + timer                       |     |
| Zen Mode                 | ✅        | ✅     | Done                                                  |     |
| Dopamine Menu            | —        | ✅     | Done                                                  |     |
  
### Connector Status  
  
| Connector | Read | Write | Lists | OAuth | Status |  
|-----------|------|-------|-------|-------|--------|  
| Microsoft Todo | ✅ | ✅ | ⚠️ | ✅ | 90% — list discovery not wired |  
| GitHub Issues | ✅ | ✅ | ✅ | ✅ | 95% |  
| Outlook Calendar | ✅ | ❌ | ✅ | ✅ | 80% |  
| Outlook Email | ✅ | ✅ | ✅ | ✅ | 80% |  
| Home Assistant | ✅ | ❌ | ❌ | N/A | New — alerts only |  
| RyMessage | ✅ | ❌ | ❌ | N/A | Webhook receiver |  
| Document Intelligence | ✅ | ❌ | ❌ | N/A | Alert provider |  
| Monarch Money | ✅ | ❌ | ❌ | N/A | Finance alerts |  
| Custom REST | ✅ | Cfg | Cfg | N/A | Template available |  
  
---  
  
## Phase 1: Stability & Security 🔴  
  
**Objective:** Fix critical bugs and security gaps so the app can run reliably.  
**Effort:** 3–5 days  
**Priority:** BLOCKING — do this before any new features  
  
### 1.1 Security Fixes  
  
| #   | Item                                   | File(s)                                       | Work                                                   |     |
| --- | -------------------------------------- | --------------------------------------------- | ------------------------------------------------------ | --- |
| 1   | Implement webhook secret validation    | `src/app/api/integrations/rymessage/route.ts` | HMAC-SHA256 validation using `MC_EVENT_SECRET` env var |     |
| 2   | Require triage capture key             | `src/app/api/triage/capture/route.ts`         | Return 401 if `MC_TRIAGE_CAPTURE_KEY` not set          |     |
| 3   | Add rate limiting to public API routes | API routes                                    | Basic rate limiter (e.g., `next-rate-limit`)           |     |
| 4   | Centralize env validation              | New: `src/lib/env.ts`                         | Zod schema validating all required env vars at startup |     |
  
### 1.2 Data Integrity Fixes  
  
| #   | Item                                    | File(s)                                         | Work                                                                 |      |
| --- | --------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- | ---- |
| 5   | Fix schema mismatch on subtask creation | `src/app/api/subtask-templates/route.ts`        | Remove `syncStatus: 'local_only'` or add column to schema            | done |
| 6   | Persist subtask templates in DB         | `src/db/schema.ts` + route                      | Create `subtask_templates` table, migrate from in-memory array       | done |
| 7   | Wire source list discovery              | Sync engine                                     | Call `fetchSourceLists()` during sync; populate `source_lists` table | done |
| 8   | Fix mojibake icon                       | `src/lib/connectors/microsoft-todo/index.ts:66` | Replace `'Ã¢Å"â€¦'` with correct emoji/icon                          | done |
  
### 1.3 Error Resilience  
  
| #   | Item                                | File(s)                               | Work                                                               |      |
| --- | ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | ---- |
| 9   | Add React error boundaries          | App layout + major views              | Wrap Dashboard, Kanban, AI, Portfolio in `<ErrorBoundary>`         | done |
| 10  | Replace `.catch(() => {})` patterns | Multiple API routes                   | Log errors properly in all catch blocks                            | done |
| 11  | Standardize error response shape    | API routes                            | Create shared `ApiError` helper: `{ error: string, code: string }` | done |
| 12  | Fix `any` type in health route      | `src/app/api/sync/health/route.ts:65` | Type as `IConnector`                                               | done |
  
---  
  
## Phase 2: UI Completion & Polish 🟠  
  
**Objective:** Complete the designed-but-unbuilt features and eliminate inline styles.  
**Effort:** 2–3 weeks  
**Priority:** HIGH — delivers the most visible user value  
  
### 2.1 Wave Planning (Highest-Value Missing Feature)  
  
Per the design spec, Waves are now **Phases within Projects** (2026-07-08 decision).  
  
| #   | Step                 | Work                                                                  |      |
| --- | -------------------- | --------------------------------------------------------------------- | ---- |
| 1   | Schema & API         | Add `project_phases` and `phase_items` tables; CRUD endpoints         | done |
| 2   | Manual Phase UI      | Drag-to-organize list within project detail; phase header + task list | done |
| 3   | AI Phase Suggestions | Endpoint that suggests grouping of unphased tasks into phases         | done |
| 4   | Proposal/Approval UI | Show AI suggestions with accept/reject/modify                         | done |
| 5   | Timeline/Gantt View  | Visual horizontal timeline showing phases + dependencies              | done |
| 6   | Drag & Drop          | Phases can move and tasks can move to/from phases                     | done |
| 7   | AI Refine            | AI to refine the plan                                                 | done |
  
### 2.2 Goals & Ideas Smart View  
  
| #   | Step                     | Work                                                                   |      |
| --- | ------------------------ | ---------------------------------------------------------------------- | ---- |
| 1   | Create `/goals` page     | Tag-filtered view showing tasks tagged `#goal`, `#idea`, `#brainstorm` | done |
| 2   | "Develop" AI feature     | Button that expands an idea into a project proposal via AI             | done |
| 3   | Goal → Project promotion | Convert a mature goal into a full project with phases                  | done |
  
### 2.3 Inline Style Migration  
  
| #   | Step                            | Work                                                             |      |
| --- | ------------------------------- | ---------------------------------------------------------------- | ---- |
| 1   | Audit all `style={{` usage      | Grep and catalog all inline styles                               | done |
| 2   | Replace with Tailwind utilities | Convert `style={{ backgroundColor: X }}` to `bg-[token]` classes | done |
| 3   | Extract shared patterns         | Create utility classes for repeated patterns                     | done |
  
### 2.4 Quick-Add Improvements  
  
| #   | Step                    | Work                                          |      |
| --- | ----------------------- | --------------------------------------------- | ---- |
| 1   | Add duration field      | Estimated duration input in quick-add modal   | done |
| 2   | Add recurrence selector | Basic repeat options (daily, weekly, custom)  | done |
| 3   | Template quick-select   | Choose from saved task templates in add modal | done |
  
### 2.5 AI Assistant Completion  

| #   | Step                    | Work                                                                    |      |
| --- | ----------------------- | ----------------------------------------------------------------------- | ---- |
| 1   | Agent dispatch UI       | Run/stop/status panel for AI agent actions                              | done |
| 2   | Confirmation dialog     | Before AI executes destructive actions (delete, bulk move)              | done |
| 3   | Tool result display     | Show structured results of AI tool calls in chat                        | done |

### 2.6 Focus 3 Widget *(ADHD analysis — High priority, Low effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §2](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-focus3-calm-energy.html`  

| #   | Step                   | Work                                                              |      |
| --- | ---------------------- | ----------------------------------------------------------------- | ---- |
| 1   | `focus_items` table    | Schema: `task_id`, `scope` (today/week), `date`; max 3 per scope  | done |
| 2   | Focus 3 pinned section | Top of My Day view — 3-slot constrained list, drag from task list | done |
| 3   | "This Week" toggle     | Separate 3-slot set for weekly priorities                         | done |
| 4   | AI pre-population      | AI suggests Focus 3 candidates from task list (extends AI triage) | done |

### 2.7 "This Week, One Thing" Banner *(ADHD analysis — High priority, Low effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §11](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-focus3-calm-energy.html`  

| #   | Step                           | Work                                                                    |      |
| --- | ------------------------------ | ----------------------------------------------------------------------- | ---- |
| 1   | Dashboard banner widget        | Prominent card: "If you only get one thing done, make it this"          | done |
| 2   | AI selection logic             | Pick based on: highest priority + nearest due + most blocked downstream | done |
| 3   | Manual override                | User can swap the "one thing"; persists for the week                    | done |
| 4   | Special completion celebration | Completing it triggers enhanced animation (ties to dopamine menu later) | done |

### 2.8 Recent Wins Dashboard Widget *(ADHD analysis — Medium priority, Low effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §14](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-dashboard-enhanced.html`  

| #   | Step                | Work                                                                 |      |
| --- | ------------------- | -------------------------------------------------------------------- | ---- |
| 1   | Recent Wins section | Dashboard widget showing last 7 days' completed tasks as green pills | done |
| 2   | Encouraging framing | "Proof you're making progress" — no sterile "completed" language     | done |

### 2.9 Nav Category Grouping *(ADHD analysis — Medium priority, Low effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §C](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-design-enhancements.html`  

| #   | Step                   | Work                                                                              |      |
| --- | ---------------------- | --------------------------------------------------------------------------------- | ---- |
| 1   | "More ▾" dropdown      | Add grouped dropdown to top nav (Radix DropdownMenu)                              | done |
| 2   | Category headers       | Group items: TRACK (Routines, Goals, Energy), REVIEW (Resets), TOOLS (Triage, AI) | done |
| 3   | Primary tabs hardcoded | Dashboard, My Day, Tasks, Kanban stay as top-level tabs                           | done |

### 2.10 Micro-copy Audit *(ADHD analysis — Medium priority, Low effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §A](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-design-enhancements.html`  

| #   | Step                                           | Work                                                                     |      |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| 1   | Audit all empty states                         | Grep for empty/zero-data messages across all views                       | done |
| 2   | Replace with encouraging, action-oriented copy | Per principles: direct but warm, no shame language, celebrate completion | done |
| 3   | Update overdue language                        | "3 slipped — pick one to start fresh" instead of "3 overdue"             | done |
  
---  
  
## Phase 3: Production Hardening 🟡  
  
**Objective:** Make the system reliable for daily unattended use.  
**Effort:** 2–3 weeks  
**Priority:** MEDIUM — needed before relying on it as daily driver  
  
### 3.1 Observability  
  
| #   | Item                        | Work                                                           |      |
| --- | --------------------------- | -------------------------------------------------------------- | ---- |
| 1   | Structured logging          | Replace `console.*` with `pino` logger; JSON output for Docker | done |
| 2   | Request correlation IDs     | Middleware that adds trace ID to all logs within a request     | done |
| 3   | Sync audit trail            | Log all sync operations with source, count, errors             | done |
| 4   | Health endpoint enhancement | Add DB connectivity check, connector status, last sync times   | done |
  
### 3.2 Performance  
  
| #   | Item                    | Work                                                           |      |
| --- | ----------------------- | -------------------------------------------------------------- | ---- |
| 1   | Memoize computed arrays | Add proper `useMemo` deps for `groupedSourceLists` and similar | done |
| 2   | Virtual scrolling audit | Ensure virtualizer is used for all lists >50 items             | done |
| 3   | Bundle analysis         | Run `next-bundle-analyzer`; identify large imports             | done |
| 4   | DB query optimization   | Add missing indexes; reduce N+1 patterns in list endpoints     | done |
| 5   | DB transactions         | Wrap multi-step operations in explicit transactions            | done |
  
### 3.3 Testing  
  
| #   | Item                                      | Work                                                             |      |
| --- | ----------------------------------------- | ---------------------------------------------------------------- | ---- |
| 1   | API route tests                           | Test critical paths: sync, triage, task CRUD, AI                 | done |
| 2   | Connector unit tests                      | Mock external APIs; test sync logic, conflict resolution         | done |
| 3   | Component tests                           | Key interactions: kanban drag-drop, quick-add, filters           | done |
| 4   | E2E smoke test                            | Playwright: login → view tasks → complete task → verify          | done |
| 5   | Target: >60% coverage on critical paths   | Focus on data integrity                                          | done |
  
### 3.4 Async Pattern Cleanup  
  
| #   | Item                            | Work                                                         |      |
| --- | ------------------------------- | ------------------------------------------------------------ | ---- |
| 1   | Standardize on async/await      | Replace `.then().then()` chains with async/await + try/catch | done |
| 2   | Remove fire-and-forget patterns | Ensure all promises are awaited or explicitly backgrounded   | done |
| 3   | Add timeout handling            | Configurable timeouts on all external API calls              | done |
  
### 3.5 Epic Removal Migration  
  
| #   | Item                                   | Work                                            |      |
| --- | -------------------------------------- | ----------------------------------------------- | ---- |
| 1   | Drop `hub_epics` table                 | Migration to remove epic entity                 | done |
| 2   | Drop `epic_tags` table                 | Clean up related junction table                 | done |
| 3   | Remove Epic UI references              | Clean up any remaining UI that references epics | done |
| 4   | Verify Category field covers use cases | Ensure project grouping still works             | done |
  
---  
  
## Phase 4: Extended Features 🔵  
  
**Objective:** Build out the medium-term roadmap items that add significant value.  
**Effort:** 4–6 weeks  
**Priority:** LOW — nice-to-have after core is solid  
  
### 4.1 Insights & Analytics  

| #   | Item                                      | Work                                                                                                                                                                                                                                   |     |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1   | `/insights` page                          | AI-generated weekly summary: completed, overdue, patterns                                                                                                                                                                              | wip |
| 2   | Completion trends chart                   | Tasks completed per day/week over time                                                                                                                                                                                                 | wip |
| 3   | Source breakdown                          | Which connectors generate most tasks/alerts                                                                                                                                                                                            | wip |
| 4   | Daily completion counter                  | Badge showing "✓ N today" (resets at midnight)                                                                                                                                                                                         | wip |
| 5   | Progress rollup widgets *(ADHD analysis)* | Dashboard cards: tasks this week (N/M), routines kept (%), streak days, Focus 3 hit rate. See `mockups/mockup-dashboard-enhanced.html`. **Note:** Shares stats computation engine with Weekly Reset (4.7.2) — build shared query layer | wip |
  
### 4.2 Multi-Modal Capture  
  
| #   | Item                                       | Work                                                                                                                                                                                                           |      |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Capture endpoint                           | Accept screenshots, URLs, text blobs                                                                                                                                                                           |      |
| 2   | iOS Share Sheet integration                | Via Shortcuts → webhook to triage capture                                                                                                                                                                      |      |
| 3   | Browser extension                          | Quick-save from any page → triage queue                                                                                                                                                                        | done |
| 4   | AI classification                          | Auto-tag and route captured content                                                                                                                                                                            | done |
| 5   | Quick Capture hotkey *(ADHD analysis §6)*  | `Ctrl+K` offers local task creation using the shared Quick Add parser. Triage-specific `source: "brain_dump"` capture remains separate.                                                                      | done |
| 6   | NLP date parsing *(Oriti analysis §6)*     | `chrono-node` powers explicit `/due:` commands and safe trailing-date suggestions across Quick Add, Ctrl+K creation, Triage extraction, and inline date editing.                                              | done |
| 7   | Multi-task splitting *(Oriti analysis §5)* | Detect compound tasks in Quick Add input (split on "and" / semicolons / line breaks). Also enable multi-action detection in Triage Queue AI extraction and checklist-to-subtask conversion from synced sources | done |
  
### 4.3 Advanced UX

| #   | Item                        | Work                                                                                                                                                                                                                                                                        |      |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Focus mode                  | Hide sidebar + alerts; show only current task                                                                                                                                                                                                                               | done |
| 2   | Calm mode *(ADHD analysis)* | Extends Focus Mode — reduced UI showing only: today's focus text, "next small action" (AI-picked), top 3-5 tasks, completion count with encouraging copy. Toggle via `Ctrl+Shift+C`.                                                                                        | done |
| 3   | Undo last action            | 5-second undo window for completions, moves, deletes                                                                                                                                                                                                                        |      |
| 4   | Bulk operations             | Multi-select tasks → batch move/tag/complete/delete                                                                                                                                                                                                                         | done |
| 5   | Completion micro-animation  | Scale + particle burst on task check (per design spec). Feeds completion counter which gates Dopamine Menu                                                                                                                                                                   | done |
| 6   | Two-mode timer system       | **Deadline timer:** visible red countdown for procrastination-prone tasks (pressure-based). **Focus timer** *(ADHD analysis §13):* gentle 25-min "just begin" session (encouragement-based). Toggle between modes in timer UI.                                               | done |
| 7   | Zen Mode *(Oriti analysis §7)* | Single flat list, score-sorted, hide all chrome (sidebar + alerts panel). One-key toggle (`Ctrl+Shift+Z`). Complementary to Focus/Calm — this is about information density, not cognitive load.                                                                              | done |
  
### 4.4 Connector Expansion

| #   | Item                     | Work                                              |     |
| --- | ------------------------ | ------------------------------------------------- | --- |
| 1   | Home Assistant alerts    | Device state changes → triage queue alerts        |     |
| 2   | Document Intelligence    | Bill extraction → task creation                   |     |
| 3   | Monarch Money            | Budget alerts → review tasks                      |     |
| 4   | Capabilities enforcement | Respect `read: false` / `write: false` checkboxes |     |
| 5   | Model Catalog            | Custom - Projects \| Tasks                        |     |
| 6   | PROJECT import/sync      | GitHub, others - sync projects?                   |     |

### 4.5 Routines & Habits Tracker *(ADHD analysis — High priority, Medium effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §3](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-routines-reset.html`  
> **Key insight:** Habits ≠ recurring tasks. Routines need a weekly grid, streak tracking, and zero "overdue" pressure.  

| #   | Item                                      | Work                                                                                             |      |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| 1   | `routines` + `routine_completions` tables | Multi-cadence schema: daily, specific_days, x_per_week, every_n_days, weekly, monthly, quarterly | done |
| 2   | `/routines` page                          | Weekly checkbox grid (daily/specific-day), countdown bars (flexible), dot progress (x_per_week)  | done |
| 3   | Streak calculation engine                 | Per-cadence logic: consecutive days, consecutive weeks meeting target, etc.                      | done |
| 4   | Dashboard "Routine Snapshot" widget       | Today's routines with quick check-off + streak counts                                            | done |
| 5   | My Day integration                        | "Today's Routines" section in My Day view with inline check-off                                  | done |
| 6   | Over-completion tracking                  | Log completions beyond target; AI suggests cadence adjustments over time                         | done |
| 7   | Behavior heatmap                          | Historical view of routine adherence (GitHub contribution graph style)                           | done |

### 4.6 Energy/Mood Tracking *(ADHD analysis — Medium priority, Low effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §7](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-focus3-calm-energy.html`  
> **Key insight:** The value isn't the tracking — it's the data it feeds to AI task suggestions.  

| #   | Item                  | Work                                                                                       |      |
| --- | --------------------- | ------------------------------------------------------------------------------------------ | ---- |
| 1   | `energy_logs` table   | Schema: date, level (1-4), optional tags (JSON), timestamp                                 |      |
| 2   | Quick-entry prompt    | One-tap energy check when opening My Day (skippable). 4 levels: Low / Medium / Good / High | done |
| 3   | Optional context tags | Quick-select: "Bad sleep", "Stressed", "Good workout", custom                              |      |
| 4   | AI integration        | Low energy → suggest short/easy tasks; high energy → suggest deep work                     |      |
| 5   | Weekly energy trend   | Chart in Weekly Reset view showing energy pattern across the week                          |      |

### 4.7 Weekly/Monthly Reset *(ADHD analysis — Medium priority, Medium effort)*  

> **Source:** [ADHD-PLANNER-COMPETITIVE-ANALYSIS.md §5](../research/ADHD-PLANNER-COMPETITIVE-ANALYSIS.md) · **Mockup:** `mockups/mockup-routines-reset.html`  
> **Key insight:** Without a team doing retrospectives, structured personal reflection is the only feedback loop.  

| # | Item | Work |  
|---|------|------|  
| 1 | `resets` table | Schema: type (weekly/monthly), period dates, went_well, needs_adjustment, notes, stats (JSON snapshot) |  
| 2 | Weekly Reset view | Auto-populated stats (tasks completed/created/carried-forward, routine %, Focus 3 hit rate). **Note:** Reuses shared stats engine from Progress rollup widgets (4.1.5) |  
| 3 | Guided prompts | "What went well?" + "What needs adjustment?" free-text fields |  
| 4 | Carry-forward automation | Incomplete Focus 3 items auto-populate next week's candidates |  
| 5 | Stale task surfacing | During reset, surface tasks >14 days with no activity → Keep / Archive / Reschedule |  
| 6 | AI summary | "This week you focused on [X] and [Y]. [Z] got no attention." |  
| 7 | Monthly Reset extension | Month-over-month trends, project health changes, routine streak summaries, goal progress |  

### 4.8 Priority Entities *(New — Medium priority, Low effort)*  

> **Mockup:** `mockups/mockup-priority-entities.html`  
> **Key insight:** Rank people and topics by importance tier so the AI scoring engine can boost/deprioritize accordingly.  

| #   | Item                                         | Work                                                                                                                                                                                                                                                                                                                                                                            |     |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1   | `priority_entities` table                    | Schema: name, type (person/topic/project), tier (mission-critical/high/important/default), notes                                                                                                                                                                                                                                                                                |     |
| 2   | Priority Entities settings page              | Tiered list with drag-to-reorder within tiers                                                                                                                                                                                                                                                                                                                                   |     |
| 3   | AI score integration                         | Factor entity matches into task smart-score calculations                                                                                                                                                                                                                                                                                                                        |     |
| 4   | Score-informed Kanban *(Oriti analysis §12)* | Auto-sort cards within Kanban columns by smart score. Show score badge on each card. Depends on scoring engine from items 1-3                                                                                                                                                                                               |     |
| 5   | Snooze + score animation *(Oriti analysis)*  | "Snooze" quick action (keyboard shortcut `S`) applies temporary score penalty (-20 for 24h, -10 for 48h, then recovers). Score badge animates down (Number Flow counter tick), task slides to new sorted position with spring animation. Snooze indicator (clock icon + "snoozed until tomorrow") on row. 5-second undo toast. See `mockups/mockup-snooze-score-animation.html` |     |
| 6   | Priority Setup Wizard *(Oriti analysis §8)*  | First-launch onboarding flow: 4-step wizard (Rank Sources → Rank Projects → Add Key People → Review & Launch). Makes scoring engine useful from minute one. See `mockups/mockup-priority-setup-wizard.html`                                                                                                                                                                     |     |
  
---  
  
## Phase 5: Ecosystem & Scale ⚪  
  
**Objective:** Long-term vision items for full personal OS experience.  
**Effort:** 2–3 months  
**Priority:** FUTURE  
  
| Feature                              | Description                                                                                                                                                        | Status |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **Micro-Statuses**                   | "Waiting on someone," "Started but stuck," "Need to think" — AI auto-suggest                                                                                       | done   |
| **Task Templates**                   | Reusable patterns for trip packing, 3D prints, home reno                                                                                                           | done   |
| **Triage Queue v2**                  | Reddit, Instagram, GitHub Stars, X/Twitter saved content                                                                                                           | wip    |
| **Package Tracking**                 | Email inference → tracking numbers → HA integration                                                                                                                |        |
| **n8n Cross-Source Workflows**       | Move tasks between systems, tag-based routing, Slack/Notion bridges                                                                                                | wip    |
| **Notion/Jira/Linear Connectors**    | Tier 2 integrations                                                                                                                                                |        |
| **Webhook Inbound Sync**             | Public endpoint for external system pushes                                                                                                                         | done   |
| **Light Theme Option**               | Design tokens support it; just needs toggle + alternate values                                                                                                     |        |
| **Mobile PWA Enhancements**          | Offline queue, push notifications, native feel. See [mobile-remaining-gaps.md](design/proposed/mobile-remaining-gaps.md)                                           | wip    |
| **iOS Native Wrapper**               | WKWebView Swift shell → App Store distribution + APNs push + Share Sheet. Phase 3 of mobile strategy. See [mobile-ios-wrapper-distribution.md](design/proposed/mobile-ios-wrapper-distribution.md) |        |
| **iOS Home Screen Widget**           | WidgetKit small/medium widget showing Today tasks (Phase 4 of mobile strategy)                                                                                     |        |
| **Dopamine Menu** *(ADHD)*           | After every N task completions, show reward picker (user-configurable). Ties to completion counter.                                                                | done   |
| **Accent Color Themes** *(ADHD)*     | 5 accent colors (Blue/Green/Purple/Amber/Rose) via CSS custom property swap.                                                                                       |        |
| **Bottom Tab Bar (Mobile)** *(ADHD)* | Condensed mobile tab bar: Dashboard, Today, Tasks, Routines, Triage, More                                                                                          |        |
| **Pinnable Top Tabs**                | User-chosen 4-5 persistent tabs + command palette for the rest (Phase 2 of nav evolution)                                                                          |        |
  
---  
  
## Key Decisions Already Made (Preserve These)  
  
| Decision | Date | Rationale |  
|----------|------|-----------|  
| Remove Epics entity | 2026-07-08 | Category + Wave Planning + Tags sufficient |  
| Merge Waves into Projects as Phases | 2026-07-08 | Simpler hierarchy: Project → Phase → Task |  
| Integrate ADHD planner features | 2026-07-10 | Competitive analysis revealed gaps in routines, reflection, emotional sustainability |  
| Routines ≠ Recurring Tasks | 2026-07-10 | Habits need grid tracking + streaks, not regenerating task entities |  
| Two-tier Focus/Calm modes | 2026-07-10 | Focus = distraction reduction; Calm = cognitive load reduction. Complementary |  
| Nav: top-nav + "More ▾" dropdown | 2026-07-10 | Scales as views grow; avoids sidebar creep; evolves to pinnable tabs later |  
| No shame language in UI copy | 2026-07-10 | "Slipped" not "overdue"; action-oriented empty states; celebrate completions |  
| Integrate Oriti/Anythings features | 2026-07-13 | Competitive analysis: AI scoring, NLP dates, multi-task splitting, snooze, setup wizard, Zen mode |  
| Dark-first design | — | Professional density; matches Linear/Raycast |  
| Native connectors over n8n-first | — | Simpler, faster, fewer dependencies |  
| Push-before-pull sync | — | Minimizes conflicts; immediate write-through |  
| SQLite + Drizzle | — | Local-first, zero infra, single-user optimal |  
| CSS custom properties everywhere | — | Unified theming; no inline hex |  
| DB-backed AI config | — | User-configurable via Settings UI |  
  
---  
  
## Success Metrics  
  
| Phase | Gate Criteria |  
|-------|--------------|  
| Phase 1 | Zero critical security issues; no data loss bugs; error boundaries prevent white-screens |  
| Phase 2 | Wave Planning usable; Focus 3 on My Day; "One Thing" banner live; inline styles <10 instances; micro-copy audit complete |  
| Phase 3 | >60% test coverage on critical paths; structured logs in Docker; <200ms p95 for task list |  
| Phase 4 | Insights page live; Routines view with streaks; Weekly Reset functional; Energy check-in feeding AI; capture from iOS working; completion animation delightful |  
  
---  
  
*Document Version: 2.0 | Generated: July 10, 2026 | Updated: July 22, 2026 — Consolidated from 3 overlapping docs; all statuses verified against codebase*