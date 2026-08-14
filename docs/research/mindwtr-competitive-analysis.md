# Mindwtr — Competitive Analysis & Feature Inspiration

> **Source**: [dongdongbh/Mindwtr](https://github.com/dongdongbh/Mindwtr) (AGPL-3.0, TypeScript, 1,541 ★)
> **Date**: July 28, 2026
> **Triggered by**: Issue #432 — "Review GH Mindwtr for possible ideas and integration"
> **Method**: Deep code analysis of repo (types.ts, ai/prompts.ts, quick-add.ts, CONTEXT.md, server-validation.ts, package.json, MCP server docs) + MC feature audit

---

## Executive Summary

Mindwtr is a full-stack open-source GTD task manager built with Tauri (desktop), React Native/Expo (mobile), and a Bun cloud server. It is a monorepo with a `packages/core` shared library, `apps/desktop`, `apps/cloud`, `apps/mobile`, and `apps/mcp-server`. The data model is extraordinarily rich — far beyond typical task apps — and the architecture reveals sophisticated patterns for AI integration, sync conflict resolution, offline-first data, and progressive-disclosure UX.

**Mindwtr's biggest advantage is philosophical, not technical.** It enforces GTD semantics at the data model level — statuses mean something, transitions are guided, and the system actively prevents "inbox sprawl." Mission Control has more features and more integrations, but its workflow is more freeform. The highest-ROI adoption path is to **bake GTD semantics into the existing data model** and **guide users through capture → clarify → organize**, while keeping MC's existing strengths in multi-source aggregation and AI.

---

## What MC Already Does Better Than Mindwtr

- ✅ **Multi-source aggregation** — MC pulls from GitHub, Microsoft Todo, Outlook, etc. Mindwtr is single-source/local-only.
- ✅ **Finance tracking** — MC has Monarch Money integration. Mindwtr has nothing.
- ✅ **Smart prioritization** — MC has multi-factor smart score. Mindwtr uses manual priority only.
- ✅ **AI assistant breadth** — Houston has multi-mode (Chat, Agents, Insights). Mindwtr has 4 scoped AI tools.
- ✅ **Notification system** — MC has unified notifications with snooze, promotion engine, cross-surface sync.
- ✅ **Energy tracking** — MC already tracks user energy (daily check-in) + AI-inferred energy tags per task.
- ✅ **Kanban board** — MC has full drag-and-drop kanban with project columns.
- ✅ **Weekly/monthly resets** — MC has structured reflection with AI summaries.

---

## Repositories/Files Referenced

| Source | Description |
|--------|-------------|
| `dongdongbh/Mindwtr:README.md` | Feature overview, comparison table, philosophy |
| `dongdongbh/Mindwtr:CONTEXT.md` | Internal vocabulary spec (domain language) |
| `dongdongbh/Mindwtr:packages/core/src/types.ts` | Complete data model (Task, Project, Area, Person, Settings) |
| `dongdongbh/Mindwtr:packages/core/src/ai/types.ts` | AI provider interfaces |
| `dongdongbh/Mindwtr:packages/core/src/ai/prompts.ts` | AI prompt construction (Clarify, Breakdown, Review, Copilot) |
| `dongdongbh/Mindwtr:packages/core/src/ai/catalog.ts` | AI model catalog + retirement remapping |
| `dongdongbh/Mindwtr:packages/core/src/ai-config.ts` | BYOK config builder |
| `dongdongbh/Mindwtr:packages/core/src/quick-add.ts` | NLP quick-add parser (chrono-node + token grammar) |
| `dongdongbh/Mindwtr:packages/core/src/analytics-heartbeat.ts` | Anonymous telemetry |
| `dongdongbh/Mindwtr:apps/cloud/src/server-validation.ts` | AppData validation (schema) |
| `dongdongbh/Mindwtr:apps/cloud/src/server.ts` | REST API server (full CRUD) |
| `dongdongbh/Mindwtr:apps/desktop/package.json` | Dependencies |
| `https://www.npmjs.com/package/mindwtr-mcp` | MCP server documentation |

---

## Feature Area 1: The Full GTD Workflow Loop

### What It Is
A complete, guided 5-phase workflow: **Capture → Clarify → Organize → Engage → Reflect**. Not just task statuses — each phase has dedicated UI affordances.

### How It Works (from code)
The `TaskStatus` type (`types.ts:1`) defines the exact states each item can be in:
```typescript
type TaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'reference' | 'done' | 'archived';
```

- **Inbox**: raw capture zone — items land here before being processed
- **Next**: actionable items ready to do
- **Waiting**: delegated, blocked on another person/event (`waiting_for` pattern)
- **Someday**: deferred, not now, not never
- **Reference**: non-actionable information (read-later equivalent)
- **Done/Archived**: completed

The system enforces workflow rules: e.g., adding a `isFocusedToday` star to an unprocessed inbox item *automatically clarifies it to `next`* (from `CONTEXT.md`). This prevents "focus list full of unprocessed inbox noise."

### Why It's Unique
Most task apps treat status as purely cosmetic (Todoist's priority flags, GitHub's "open/closed"). Mindwtr bakes GTD semantics directly into the data model with enforced transitions that guide the user toward better thinking, not just data entry.

### MC Adaptation
MC's existing micro-statuses partially cover this. The key insight to adopt: **make status semantically meaningful, not just a label**. Consider adding `waiting`, `someday`, and `reference` statuses to the existing task model, each with different display/filter behavior.

**Issue**: #1312

---

## Feature Area 2: The Focus Star / Today's Focus System

### What It Is
A per-task "commit to doing today" mechanism — the `isFocusedToday` flag — separate from priority. Combined with a configurable cap (`focusTaskLimit`) so the focus list never bloats.

### How It Works (from code)
```typescript
interface Task {
    isFocusedToday?: boolean;  // Marked as today's focus list
    focusOrder?: number;       // Manual ordering within Today's Focus; cleared when task leaves Focus
}
interface GtdSettings {
    focusTaskLimit?: number;    // Max tasks in focus list
    focusGroupBy?: FocusGroupBy; // none | context | project | area | energy | priority | person | tag
}
```

The focus view shows: **today's scheduled tasks (agenda) + starred next-actions in one combined view**. From `CONTEXT.md`:
> **Focus star**: The per-task mark that commits a task to Today's Focus. Removing a star is always allowed; adding one is gated by focus eligibility and the focus cap. Starring an unprocessed inbox task clarifies it to next.

### Why It's Unique
Solves the "everything is urgent" problem. The focus cap forces deliberate prioritization (WIP limit for daily attention). The separation of "focus" from "priority" is philosophically important: a low-priority task can be today's focus if it's been waiting too long.

### MC Adaptation
MC has My Day with auto-include rules. The cap enforcement is the key addition — prevents "50 tasks on My Day."

**Issue**: #1309

---

## Feature Area 3: Rich Task Data Model

### What It Is
A task schema with ~40+ fields covering every productivity concept without being cluttered in the UI (progressive disclosure hides unused fields).

### Key Fields (from `types.ts:180-250`)
```typescript
interface Task {
    // Core
    id, title, status: TaskStatus,
    
    // Prioritization dimensions
    priority?: 'low' | 'medium' | 'high' | 'urgent',
    energyLevel?: 'low' | 'medium' | 'high',
    timeEstimate?: TimeEstimate,  // '5min'|'10min'|'15min'|'30min'|'1hr'|'2hr'|'3hr'|'4hr'|'4hr+'|`custom:${number}`
    
    // Scheduling (3 distinct dates!)
    startTime?: string,           // When to START working on it
    dueDate?: string,             // When it's DUE
    reviewAt?: string,            // Tickler: when to RE-EXAMINE it
    relativeStartOffset?: RelativeStartOffset, // "start 3 days before due"
    
    // Tracking
    timeSpentMinutes?: number,    // Pomodoro + manual
    pushCount?: number,           // How many times due date was pushed back
    completedAt?: string,
    
    // Organization
    contexts: string[],           // ['@home', '@work']
    tags: string[],
    location?: string,
    assignedTo?: string,
    projectId, sectionId, areaId,
    
    // UI state
    isFocusedToday, focusOrder,
    boardOrder,                   // Kanban column position
    taskMode?: 'task' | 'list',   // Task vs checklist mode
    checklist?: ChecklistItem[],
    
    // Recurrence
    recurrence?: Recurrence,
    showFutureRecurrence?: boolean, // Calendar preview without creating real task
    
    // Sync
    rev?: number, revBy?: string,
    deletedAt, purgedAt,
}
```

### Notable design decisions
- **Three separate date concepts** — `startTime` (when to begin), `dueDate` (deadline), `reviewAt` (tickler/revisit)
- **`pushCount`** — silently tracks procrastination. A task pushed 7x is behaviorally different from one pushed 0x.
- **`energyLevel`** — enables context-aware work: show only "low energy" tasks in the afternoon slump
- **`relativeStartOffset`** — "auto-compute startTime as 3 days before due"

### MC Adaptation
**Issues**: #1310 (pushCount), #1311 (three-date model)

---

## Feature Area 4: Projects, Sections, Areas — Three-Level Hierarchy

### What It Is
**Areas** (life domains) → **Projects** (multi-step outcomes) → **Sections** (project subdivisions).

```typescript
interface Project {
    status: 'active' | 'someday' | 'waiting' | 'archived',
    isSequential?: boolean,         // Only show FIRST incomplete task in Next Actions
    sequentialScope?: 'project' | 'section',
    isFocused?: boolean,            // Priority project flag (max 5)
    supportNotes?: string,          // Context/notes for the project itself
    dueDate?, reviewAt?,
    areaId?,
}
```

- **Sequential Projects** (`isSequential: true`) only surface the *first* incomplete task in Next Actions — core GTD
- **`isFocused` on projects** (max 5) = project-level WIP limit
- **`supportNotes`** = scratch pad for "why this project exists"

### MC Adaptation
**Issue**: #1315 (Sequential projects)

---

## Feature Area 5: AI Features — Deeply Integrated, BYOK, Multi-Provider

### What It Is
Four distinct AI capabilities, each with specific prompt design, plus a Copilot for real-time typing suggestions. All BYOK (user's own API key).

### AI Capabilities (from `ai/prompts.ts`)

**1. Clarify Task** (`buildClarifyPrompt`):
```
System: "You are a strict GTD coach. You do not decide for the user..."
Input: task title + contexts + project context + schedule dates
Output: { question: string, options: [{label, action}], suggestedAction?: {title, timeEstimate, context, isProject} }
```

**2. Break Down Task** (`buildBreakdownPrompt`):
```
Input: task title + description + project context
Output: { steps: [string] }  // 3-8 actionable next steps
```

**3. Review Analysis** (`buildReviewAnalysisPrompt`):
```
Input: up to 16 stale items (>14 days untouched)
Output: { suggestions: [{id, action: 'someday|archive|breakdown|keep', reason: ≤12 words}] }
```

**4. Copilot** (`buildCopilotPrompt`) — real-time typing suggestions:
```
Input: task title + existing contexts + tags
Output: { context: "@phone", tags: ["#creative"], timeEstimate: "15min" }
```
Uses `COPILOT_REASONING_EFFORT = 'minimal'` and a fast model for sub-100ms latency.

**5. Audio Capture** with `smart_parse | transcribe_only` mode.

### Notable patterns
- **Two-tier model config**: fast/cheap for copilot, smart/expensive for analysis
- **Retired model ID remapping** (`ai/catalog.ts`): critical for long-lived settings
- **BYOK**: OpenAI, Anthropic, Gemini, local self-hosted

### MC Adaptation
**Issue**: #1313 (AI Review Analysis)

---

## Feature Area 6: Quick-Add Natural Language Parser

### What It Is
Single-line task creation with NLP dates + custom token grammar. Uses `chrono-node`.

| Token | Meaning | Example |
|-------|---------|---------|
| `@context` | Assign context | `@home`, `@work/meetings` |
| `#tag` | Add tag | `#creative` |
| `+Project` | Assign project | `+Website Redesign` |
| `/due:` | Set due date | `/due:next friday` |
| `/start:` | Set start time | `/start:tomorrow 9am` |
| `/review:` | Set review date | `/review:next month` |
| `/waiting` | Status = waiting | |
| `!` | Priority marker | |
| `%person` | Assign to person | |

### Notable UX details
- **`detectTrailingDate`**: "Buy gift for mom next Saturday" → offers date as suggestion, doesn't silently apply
- **`naturalLanguageDates` toggle**: prevents "python 3.12" from parsing as a date
- **Bulk paste**: newline-separated multi-task creation

### MC Adaptation
**Issue**: #1317 (NLP quick-add), #433 (Audio quick entry)

---

## Feature Area 7: Fluid Recurrence System

### What It Is
Two recurrence strategies: **strict** (calendar-fixed) and **fluid** (recalculate from completion date).

```typescript
interface Recurrence {
    rule: 'daily' | 'weekly' | 'monthly' | 'yearly',
    strategy?: 'strict' | 'fluid',
    byDay?: RecurrenceByDay[],
    count?: number,
    until?: string,
    completedOccurrences?: number,
    seriesId?: string,
    rrule?: string,  // RFC 5545 fragment
}
```

**Fluid recurrence**: "Clean the bathroom every week" (fluid) = 7 days after you last cleaned. Not calendar-fixed every Monday.

`showFutureRecurrence: boolean` creates calendar *preview* ghost events.

### MC Adaptation
**Issue**: #436

---

## Feature Area 8: Saved Filters with Full Predicate System

```typescript
interface FilterCriteria {
    contexts?: string[],
    contextMatchMode?: 'any' | 'all',
    excludedContexts?: string[],     // NEGATIVE filter
    excludedTags?: string[],
    energy?: TaskEnergyLevel[],
    dueDateRange?: DateRange,         // preset (today/this_week/overdue/no_date) OR from/to
    timeEstimateRange?: { min?: number; max?: number },
    isStarred?: boolean,
}
interface SavedFilter {
    id, name, icon?,
    view: 'focus' | 'next' | 'waiting' | 'someday' | 'contexts' | 'all',
    criteria: FilterCriteria,
    sortBy?, sortOrder?, groupBy?,
}
```

Key: `excludedContexts/Tags` for negative filtering, semantic date presets that resolve at query time.

### MC Adaptation
**Issue**: #1316

---

## Feature Area 9: Weekly Review Wizard

Guided step-by-step review: process inbox → review someday/maybe → review waiting for → review active projects → review contexts → capture loose ends.

```typescript
inboxProcessing?: {
    defaultMode?: 'guided' | 'quick',
    twoMinuteEnabled?: boolean,
    twoMinuteFirst?: boolean,
    projectFirst?: boolean,
    contextStepEnabled?: boolean,
}
```

Daily Digest has **morning briefing** AND **evening review** — two distinct modes with separate enable/time settings.

### MC Adaptation
MC has weekly reset. The guided wizard with AI-suggested actions at each step would enhance it.

**Issue**: #1319 (Daily Digest)

---

## Feature Area 10: Pomodoro + Time Tracking

```typescript
pomodoro?: {
    customDurations?: { focusMinutes?: number; breakMinutes?: number },
    linkTask?: boolean,       // Link running Pomodoro to current task
    autoStartBreaks?: boolean,
}
timeSpentMinutes?: number,   // Accumulates across sessions + manual edits
```

Time tracking integrated at the data model level — filterable, reportable, synced.

### MC Adaptation
Already tracked at **#1249** (Focus Timer: per-task session history).

---

## Feature Area 11: People / Contact System

```typescript
interface Person {
    id, name, note?, referenceLink?,
    rev?, revBy?,
    createdAt, updatedAt, deletedAt,
}
// On Task: assignedTo?: string
```

Enables "Waiting For Alice" filtered view. `referenceLink` for GitHub/LinkedIn profiles.

### MC Adaptation
**Issue**: #1314

---

## Feature Area 12: MCP Server

Published as `mindwtr-mcp` on npm. Tools: `mindwtr_list_tasks`, `mindwtr_add_task` (with `quickAdd` NLP input), CRUD for tasks/projects/areas/people/sections.

HTTP transport mode for remote AI clients. Read-only by default; `--write` flag enables mutations.

### MC Adaptation
MC already has MCP server concept. Key enhancement: `quickAdd` NLP input for AI agents.

---

## Feature Area 13: Search Operators

```
status:waiting          → filter by status
context:@work           → filter by context
assigned:alice          → filter by assignee
due:<=7d               → due within 7 days
-id:abc-123            → exclude specific task
```

### MC Adaptation
**Issue**: #1320

---

## Feature Area 14: Progressive Disclosure / Feature Flags

```typescript
interface FeatureSettings {
    priorities?: boolean,
    timeEstimates?: boolean,
    pomodoro?: boolean,
}
interface TaskEditorSettings {
    order?: TaskEditorFieldId[],
    hidden?: TaskEditorFieldId[],
    presentation?: 'inline' | 'modal',
    defaultsVersion?: number,  // Upgrade defaults without breaking customizations
}
```

### MC Adaptation
**Issue**: #1318

---

## Feature Area 15: pushCount — Procrastination Tracking

```typescript
pushCount?: number,  // Tracks how many times dueDate was pushed later
```

Silent counter, no UI friction. Surface as "↷5" badge. Use in AI triage as staleness signal.

### MC Adaptation
**Issue**: #1310

---

## Feature Area 16: Additional Minor Features

| Feature | Description | MC Relevance |
|---------|-------------|--------------|
| **Context nesting** | `@work/meetings` under `@work`, prefix-match filtering | Scales context system for power users |
| **Text direction per task** | `textDirection: 'auto' \| 'ltr' \| 'rtl'` | RTL language support |
| **`showFutureRecurrence`** | Calendar ghost events for next occurrence | Great calendar UX |
| **Board order clearing** | `boardOrder` resets on status change | Prevents ghost ordering |
| **`statusBeforeProjectArchive`** | Preserves task state when project archived | Enables project unarchive |
| **Schema-driven sync** | Single field descriptor generates SQL, TypeScript, cloud allowlists | Prevents sync drift |
| **Settings sync by group** | Sync appearance without overwriting GTD config | Per-category sync |

---

## Issues Created from This Analysis

### Promoted from #432 subtasks (standalone):
- **#433** — [Mindwtr] Audio or Text Quick Entry (with tips / shortcuts)
- **#434** — Inbox > Vague into Action (like a triage)
- **#435** — Context (WHERE you do them)
- **#436** — Fluid Recurrence (not on fixed schedule but when you finish)
- **#439** — Calendar + Tasks on right pane
- **#440** — GTD Workflow (Capture > Clarify > Organize > Reflect > Engage)
- **#441** — Context & Tags VIEW - with items shown

### New issues created:
- **#1309** — [Mindwtr] Focus cap — WIP limit on My Day / isFocusedToday
- **#1310** — [Mindwtr] pushCount — Procrastination/reschedule tracking per task
- **#1311** — [Mindwtr] Three-date model: startTime + dueDate + reviewAt (tickler dates)
- **#1312** — [Mindwtr] Waiting / Someday / Reference statuses (GTD semantic statuses)
- **#1313** — [Mindwtr] AI Review Analysis — Stale task coach during weekly reset
- **#1314** — [Mindwtr] People entity + delegation tracking ("Waiting for Alice" view)
- **#1315** — [Mindwtr] Sequential projects — Show only first incomplete task
- **#1316** — [Mindwtr] Saved filters with negative predicates and semantic date presets
- **#1317** — [Mindwtr] Quick-add NLP parser with token grammar
- **#1318** — [Mindwtr] Feature flags for UI complexity + Task editor customization
- **#1319** — [Mindwtr] Daily Digest — Morning briefing + Evening review notifications
- **#1320** — [Mindwtr] Search operators in global search

### Closed (already covered or too vague):
- **#437** — UI is clean / light → replaced by #1318
- **#438** — Board View → MC already has Kanban
- **#442** — Extra left pane → folded into #441
- **#443** — Obsidian links → not a Mindwtr feature

### Key Gaps Not Verified
1. **Desktop app components** — Focus view, Inbox processing wizard UI not inspected
2. **Mobile-specific features** — Android widget, iOS share sheet not inspected
3. **Sync conflict resolution algorithm** — merge strategy inferred from `rev`/`revBy` fields
4. **External calendar subscription** — `ics.ts` referenced but not fetched
