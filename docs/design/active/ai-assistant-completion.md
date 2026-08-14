---
title: "AI Assistant Completion"
status: design-draft
created: 2026-07-10
last_reviewed: 2026-08-03
category: design
related:
  - "[AI & Agent Architecture (consolidated)](ai-agent-architecture.md)"
  - "[GitHub Copilot Provider and Runtime](copilot-sdk-provider.md)"
  - "[Go-Forward Plan](Mission%20Control%20—%20Go-Forward%20Plan.md) (§2.5)"
  - "[External Agent Integration](../proposed/external-agent-integration.md)"
  - "[Scout Smart Connector](../proposed/scout-smart-connector.md)"
  - "[Houston Identity](houston-ai-identity.md)"
  - "[Insights Page](../proposed/insights-page.md)"
mockups:
  - "[mockup-ai-assistant.html](../mockups/mockup-ai-assistant.html)"
  - "[mockup-ai-assistant-v2.html](../mockups/mockup-ai-assistant-v2.html)"
dependencies:
  - Vercel AI SDK (existing)
  - "Policy-aware AI routes and optional direct Copilot SDK runtime (#811)"
  - n8n (deployed)
issues:
  - "rsocko/mission-control#811 — policy-aware Copilot provider and runtime"
---

# AI Assistant Completion — Expanded Design Spec

---

## Executive Summary

Section 2.5 covers three interconnected pieces that complete the AI Assistant experience:

1. **Agent Dispatch UI** — run/stop/status panel with streaming progress
2. **Confirmation Dialog** — tiered severity, partial approval, undo
3. **Tool Result Display** — structured cards for AI tool calls in chat

The current implementation has the foundation (AgentPanel, backgroundAiTaskManager, tool definitions) but lacks **streaming progress**, **persistent history**, **structured tool rendering in chat**, and **integration with external orchestrators** (OpenClaw for AI reasoning, n8n for deterministic workflows).

Copilot does not replace this three-tier architecture. Bounded inference may
reach Copilot through the standalone adapter behind Bifrost. A direct Copilot
SDK runtime is a separate candidate Tier 2 executor for capabilities that need
native sessions, tools, MCP, permission hooks, resume, or the SDK agent loop.
It must use the same durable run and confirmation contracts described here.

---

## Architecture: Three-Tier Agent System

The key design decision is **not** picking one framework — it's routing to the right executor based on the task type:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mission Control UI                          │
│  Chat (streaming) │ Agent Panel │ n8n Workflow Triggers         │
└────────┬──────────┴──────┬──────┴──────────┬────────────────────┘
         │                 │                  │
    ┌────▼────┐     ┌──────▼──────┐    ┌──────▼──────┐
    │ Tier 1  │     │   Tier 2    │    │   Tier 3    │
    │ Built-in│     │  OpenClaw   │    │    n8n      │
    │ Agents  │     │  AI Agents  │    │  Workflows  │
    └─────────┘     └─────────────┘    └─────────────┘
    Fast, local      Multi-step AI      Deterministic
    DB operations    reasoning +        multi-system
    Dry-runnable     tool chaining      orchestration
```

### Tier 1: Built-in Agents (existing)
- **What**: Direct DB operations — dismiss alerts, bulk prioritize, cleanup done, snooze
- **When**: Predictable, single-domain operations on Mission Control data
- **Executor**: `dispatchAgent()` in `lib/ai/agents/index.ts`
- **Confirmation**: Dry-run preview with item-level opt-out
- **Latency**: <1s

### Tier 2: OpenClaw AI Agents (new)
- **What**: Multi-step reasoning that requires judgment — "analyze my week and suggest what to drop", "triage these 20 alerts and group by action needed", custom natural-language instructions
- **When**: User asks something that requires AI reasoning + potential multi-tool execution
- **Executor**: OpenClaw API via HTTP (deployed at your instance)
- **Confirmation**: Plan preview → approve/edit → execute with step-by-step streaming
- **Latency**: 5–30s depending on complexity
- **Key difference from Tier 1**: OpenClaw can chain multiple tools, maintain context across steps, and handle ambiguous instructions. The custom agent currently fakes this (plan-only, no execution) — OpenClaw actually executes.

### Tier 3: n8n Deterministic Workflows (new)
- **What**: Fixed multi-system flows — "sync completed GitHub issues to MS Todo", "when an alert is critical, send a push notification and create a task", "export weekly summary to Notion"
- **When**: User triggers a known cross-system automation, or it runs on a schedule/webhook
- **Executor**: n8n webhook trigger (already have `integrations/n8n.ts` stub)
- **Confirmation**: Show workflow diagram + expected actions, no AI judgment involved
- **Latency**: 2–10s
- **Key difference from Tier 2**: No AI reasoning — n8n runs a fixed graph of steps. Cheaper, faster, auditable, and the user can edit the workflow visually in the n8n UI.

### Routing Logic

```typescript
function resolveExecutor(request: AgentRequest): 'built-in' | 'openclaw' | 'n8n' {
  // Tier 1: Known built-in agent types
  if (BUILT_IN_AGENTS.includes(request.agentType)) return 'built-in';
  
  // Tier 3: Mapped n8n workflows (user-configured)
  if (request.n8nWorkflowId || N8N_WORKFLOW_MAP[request.agentType]) return 'n8n';
  
  // Tier 2: Everything else — AI reasoning needed
  return 'openclaw';
}
```

---

## 1. Agent Dispatch UI — Expanded Design

### Current State
- `AgentPanel.tsx` with 4 built-in agent cards + custom agent textarea
- Fire-and-forget execution (spinner → result)
- History is React state only (lost on refresh)

### Design Changes

#### 1a. Unified Agent Launcher

Replace the current grid of cards with a unified launcher that shows all three tiers:

```
┌───────────────────────────────────────────────────┐
│  Agent Dispatch                                    │
│  Run focused automations and inspect results.      │
│                                                    │
│  ┌─ Built-in ──────────────────────────────────┐  │
│  │ ⚡ Dismiss old alerts    [▶ Run]            │  │
│  │ ⚡ Bulk prioritize       [▶ Run]            │  │
│  │ ⚡ Cleanup done          [▶ Run]            │  │
│  │ ⚡ Snooze low priority   [▶ Run]            │  │
│  └─────────────────────────────────────────────┘  │
│                                                    │
│  ┌─ n8n Workflows ─────────────────────────────┐  │
│  │ 🔗 Sync Todo → GitHub    [▶ Trigger]        │  │
│  │ 🔗 Weekly digest email    [▶ Trigger]        │  │
│  │ 🔗 Critical alert → push  ⏱ Scheduled       │  │
│  │               [+ Add workflow]               │  │
│  └─────────────────────────────────────────────┘  │
│                                                    │
│  ┌─ AI Agent (OpenClaw) ───────────────────────┐  │
│  │ ✨ Describe what you want the AI to do...   │  │
│  │ ┌───────────────────────────────────────┐   │  │
│  │ │ "Review my overdue tasks and suggest  │   │  │
│  │ │  which to drop vs reschedule"         │   │  │
│  │ └───────────────────────────────────────┘   │  │
│  │                     [▶ Plan] [▶ Execute]    │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

#### 1b. Streaming Progress Panel

When an agent/workflow is running, replace the spinner with a step-by-step progress stream:

```
┌─ Running: Bulk prioritize ──────────────────────────┐
│                                                      │
│  ● Scanning open tasks...                    ✅ 47   │
│  ● Evaluating due date proximity...          ✅ 12   │
│  ● Updating priorities...                            │
│    ├─ "Fix auth timeout"  none → critical    ✅      │
│    ├─ "Review Q2 budget"  low → high         ✅      │
│    └─ "Update deps"       none → medium      ⏳      │
│                                                      │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  3 of 5 steps             │
│                                                      │
│  [⏹ Cancel]                                          │
└──────────────────────────────────────────────────────┘
```

**Implementation**: Server-Sent Events from `/api/ai/dispatch` endpoint. Each agent step emits a `progress` event:

```typescript
interface AgentProgressEvent {
  step: number;
  totalSteps: number;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string; // e.g., "none → critical"
  itemsProcessed?: number;
}
```

For n8n workflows, poll the n8n execution API for step status and relay as SSE.

For OpenClaw agents, the OpenClaw streaming API provides step-by-step tool call events natively.

#### 1c. Persistent History

Move agent run history from React state to the database:

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,         -- 'dismiss-old-alerts' | 'n8n:workflow-id' | 'openclaw:custom'
  executor TEXT NOT NULL,           -- 'built-in' | 'openclaw' | 'n8n'
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | partial | failed | cancelled
  dry_run BOOLEAN DEFAULT FALSE,
  custom_instruction TEXT,
  summary TEXT,
  actions_performed INTEGER DEFAULT 0,
  details_json TEXT,                -- JSON array of { action, target, result }
  started_at TEXT NOT NULL,
  completed_at TEXT,
  undone_at TEXT,                   -- if user triggered undo
  undo_snapshot_json TEXT,          -- pre-execution state for undo
  created_at TEXT DEFAULT (datetime('now'))
);
```

This gives us:
- History survives page navigation and refresh
- Undo capability (store pre-execution snapshot)
- Analytics on which agents are used most

---

## 2. Confirmation Dialog — Expanded Design

### Severity Tiering

Not all agent actions are equally dangerous. The confirmation UI should reflect this:

| Severity | Actions | UI Treatment |
|----------|---------|--------------|
| **Safe** (green) | Read-only queries, dry runs, generating summaries | No confirmation needed — execute immediately |
| **Moderate** (amber) | Priority changes, snooze, tag updates | Quick confirm: "Update 12 tasks? [Cancel] [Apply]" |
| **Destructive** (red) | Delete, archive, bulk close, sync writes to external systems | Full confirmation with dry-run preview, item-level opt-out, explicit "I understand" |

#### Destructive Confirmation — Detailed Design

```
┌─ ⚠️ Destructive Action ─────────────────────────────┐
│                                                      │
│  Cleanup done — Archive completed tasks              │
│                                                      │
│  This will archive 8 tasks completed 30+ days ago.   │
│  Archived tasks are moved to "cancelled" status and  │
│  will sync this change to the original source.       │
│                                                      │
│  ┌─ Items to archive ──────────────────────────────┐ │
│  │ ☑ Fix CORS headers             Done 45d ago     │ │
│  │ ☑ Add rate limiting            Done 38d ago     │ │
│  │ ☑ Update dependencies          Done 35d ago     │ │
│  │ ☐ Set up CI pipeline           Done 32d ago     │ │ ← user unchecked
│  │ ☑ Create project board         Done 31d ago     │ │
│  │                                                  │ │
│  │ 4 of 5 selected                                  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                      │
│  ☐ I understand this will modify external systems    │
│                                                      │
│  [Cancel]  [👁 Dry Run First]  [🗑 Archive 4 items]  │
│                                 ↑ disabled until ☑   │
└──────────────────────────────────────────────────────┘
```

**Key interactions:**
- Checkboxes for each item → partial approval
- "I understand" checkbox gates the execute button for destructive actions
- Dry Run button always available as an escape hatch
- Item count in the execute button updates dynamically

#### n8n Workflow Confirmation

For n8n triggers, show the workflow steps (fetched from n8n API) rather than individual items:

```
┌─ Trigger: Sync Todo → GitHub ────────────────────────┐
│                                                       │
│  This n8n workflow will:                              │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │  1. Fetch completed MS Todo items (last 24h)    │  │
│  │  ↓                                              │  │
│  │  2. Filter: only items with "github" tag        │  │
│  │  ↓                                              │  │
│  │  3. Create/close matching GitHub issues          │  │
│  │  ↓                                              │  │
│  │  4. Post summary to Mission Control webhook     │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  Last run: 2h ago · 3 items synced · Took 4.2s       │
│                                                       │
│  [Cancel]  [Edit in n8n ↗]  [▶ Trigger now]          │
└───────────────────────────────────────────────────────┘
```

#### OpenClaw AI Agent Confirmation

For OpenClaw custom agents, show the AI's plan before executing:

```
┌─ AI Agent Plan ──────────────────────────────────────┐
│                                                       │
│  Your instruction:                                    │
│  "Review overdue tasks and suggest what to drop"      │
│                                                       │
│  ✨ OpenClaw analyzed 47 tasks and proposes:           │
│                                                       │
│  ┌─ Proposed Actions ──────────────────────────────┐  │
│  │                                                  │  │
│  │  🗑 DROP (3 tasks)                               │  │
│  │  ☑ "Old PR review" — superseded by #142         │  │
│  │  ☑ "Update wiki" — low impact, 60d overdue      │  │
│  │  ☑ "Research caching" — deprioritized by team   │  │
│  │                                                  │  │
│  │  📅 RESCHEDULE (5 tasks)                         │  │
│  │  ☑ "Budget review" → next Monday                │  │
│  │  ☑ "Vendor email" → tomorrow                    │  │
│  │  ☑ "Slides prep" → Friday                       │  │
│  │  ☐ "Deploy staging" → next sprint               │  │
│  │  ☑ "Code review" → today                        │  │
│  │                                                  │  │
│  │  ✅ KEEP AS-IS (39 tasks)                        │  │
│  │  No changes recommended.                         │  │
│  └──────────────────────────────────────────────────┘  │
│                                                       │
│  AI reasoning: "Focused on items 30+ days overdue     │
│  with no recent activity. Kept anything with           │
│  dependencies or recent comments."                     │
│                                                       │
│  [Cancel]  [✏️ Edit Plan]  [▶ Execute 7 actions]      │
└───────────────────────────────────────────────────────┘
```

### Undo Pattern

After a destructive agent executes, show a persistent toast with undo:

```
┌───────────────────────────────────────────────┐
│ ✅ Archived 4 tasks                   [Undo]  │
│    Completed 30+ days ago              12s     │
└───────────────────────────────────────────────┘
```

- Undo window: 30 seconds (toast stays visible)
- After undo window closes, the action can still be reversed from the agent run history but requires re-confirmation
- Undo restores the `undo_snapshot_json` from the `agent_runs` table

---

## 3. Tool Result Display — Expanded Design

### Problem

Currently, when the AI calls tools like `getTaskSummary` or `searchTasks` in chat, the results are either:
- Embedded as raw text in the assistant's response
- Invisible to the user (tool calls happen silently)

### Solution: Structured Tool Result Cards

Each tool gets a dedicated card component that renders its results as rich, interactive UI inside the chat bubble.

#### Card Types by Tool

**Task Summary Card** (`getTaskSummary`)
```
┌─ 📊 Task Summary ───────────────────────────────┐
│                                                   │
│  47 open   12 overdue   5 critical   38 done     │
│  ▓▓▓▓▓▓▓▓ ▓▓▓░░░░░░░░  ▓▓░░░░░░░░  ▓▓▓▓▓▓▓▓▓  │
│                                                   │
│  By Source:                                       │
│  MS Todo ████████ 28    GitHub ████ 12            │
│  Outlook ██ 5           Custom █ 2                │
│                                                   │
│  Overdue items:                                   │
│  • Fix auth timeout — 4d overdue, critical        │
│  • Budget review — 2d overdue, high               │
│  [View all overdue →]                             │
└───────────────────────────────────────────────────┘
```

**Search Results Card** (`searchTasks`)
```
┌─ 🔍 Search: "mission-control" ───────────────────┐
│                                                    │
│  5 tasks found                                     │
│                                                    │
│  ● Fix sidebar navigation     In Progress  High   │
│    MS Todo · Due Jul 12                            │
│                                                    │
│  ● Add keyboard shortcuts     Todo         Medium  │
│    GitHub #45 · Due Jul 15                         │
│                                                    │
│  ● Deploy to production       Todo         High    │
│    GitHub #52 · No due date                        │
│                                                    │
│  [Show 2 more]  [Open in Kanban →]                │
└────────────────────────────────────────────────────┘
```

**Day Plan Card** (`suggestDayPlan`)
```
┌─ 🎯 Suggested Focus — Today ────────────────────┐
│                                                   │
│  Based on 47 open tasks, 12 overdue.              │
│                                                   │
│  1. 🔴 Fix auth timeout      GitHub    overdue    │
│  2. 🟡 Budget review         MS Todo   overdue    │
│  3. 🟡 Vendor email          Email     due today  │
│  4. 🔵 Slides prep           MS Todo   due today  │
│                                                   │
│  [✅ Mark #1 done]  [📋 Add all to My Day]        │
└───────────────────────────────────────────────────┘
```

**Mutation Result Card** (`completeTask`, `updateTaskPriority`)
```
┌─ ✅ Task Updated ────────────────────────────────┐
│                                                   │
│  "Fix auth timeout" marked as done                │
│  Completed at 2:34 PM · Will sync to GitHub       │
│                                                   │
│  [Undo]  [View task →]                            │
└───────────────────────────────────────────────────┘
```

**Wave Plan Card** (`planWaves`)
```
┌─ 🌊 Wave Plan Generated ────────────────────────┐
│                                                   │
│  3 phases for "Mission Control"                   │
│                                                   │
│  Phase 1: Core Polish     █████░░░░  5 tasks  ~3d │
│  Phase 2: New Features    ████████░  8 tasks  ~7d │
│  Phase 3: Integrations    ██░░░░░░░  3 tasks  ~4d │
│                                                   │
│  + 2 suggested new tasks  - 1 suggested closure   │
│                                                   │
│  [Review on Waves page →]                         │
└───────────────────────────────────────────────────┘
```

#### Tool Call Visibility

Show a collapsible "thinking" indicator when the AI is calling tools:

```
┌─ 🤖 Assistant ───────────────────────────────────┐
│                                                   │
│  ▸ Used 2 tools                                   │ ← collapsed by default
│    ├─ getTaskSummary()          ✅ 0.3s           │
│    └─ searchTasks("overdue")    ✅ 0.2s           │
│                                                   │
│  Here's your critical items analysis...           │
│                                                   │
│  [📊 Task Summary Card]                          │
│  [🔍 Search Results Card]                        │
│                                                   │
│  Based on this data, I recommend focusing on...   │
└───────────────────────────────────────────────────┘
```

If a tool call fails, show it inline:

```
│  ▸ Used 2 tools (1 failed)                        │
│    ├─ getTaskSummary()          ✅ 0.3s           │
│    └─ syncConnector("github")   ❌ timeout        │
```

---

## Implementation Components

### New React Components Needed

| Component | Purpose |
|-----------|---------|
| `ToolResultCard` | Wrapper that routes tool name → specific card renderer |
| `TaskSummaryCard` | Renders `getTaskSummary` results with mini bar charts |
| `SearchResultsCard` | Renders `searchTasks` results as a compact task list |
| `DayPlanCard` | Renders `suggestDayPlan` with action buttons |
| `MutationResultCard` | Renders write tool results with undo affordance |
| `WavePlanCard` | Renders `planWaves` results with phase visualization |
| `ToolCallIndicator` | Collapsible "Used N tools" with timing and status |
| `StreamingProgressPanel` | Step-by-step agent progress with SSE |
| `DestructiveConfirmDialog` | Checkbox-per-item confirmation with severity tier |
| `N8nWorkflowConfirmDialog` | Shows workflow steps from n8n API |
| `OpenClawPlanDialog` | Shows AI plan with grouped actions and partial approval |
| `AgentUndoToast` | Persistent toast with countdown and undo button |

### New API Routes Needed

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ai/dispatch` | POST (SSE) | Upgrade existing to stream progress events |
| `/api/ai/dispatch/undo` | POST | Reverse an agent run using stored snapshot |
| `/api/ai/dispatch/history` | GET | Fetch paginated agent run history from DB |
| `/api/integrations/n8n/workflows` | GET | List available n8n workflows for the trigger panel |
| `/api/integrations/n8n/trigger` | POST | Trigger an n8n workflow and stream execution status |
| `/api/integrations/n8n/executions/[id]` | GET | Poll n8n execution status for progress |
| `/api/integrations/openclaw/plan` | POST | Send instruction to OpenClaw, get plan back |
| `/api/integrations/openclaw/execute` | POST (SSE) | Execute approved OpenClaw plan with streaming |

### Database Changes

```sql
-- Agent run history (replaces React state)
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  executor TEXT NOT NULL,       -- 'built-in' | 'openclaw' | 'n8n'
  status TEXT NOT NULL DEFAULT 'pending',
  dry_run BOOLEAN DEFAULT FALSE,
  custom_instruction TEXT,
  summary TEXT,
  actions_performed INTEGER DEFAULT 0,
  details_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  undone_at TEXT,
  undo_snapshot_json TEXT,
  n8n_execution_id TEXT,       -- for n8n runs
  openclaw_session_id TEXT,    -- for OpenClaw runs
  created_at TEXT DEFAULT (datetime('now'))
);

-- n8n workflow mappings (which workflows appear in the trigger panel)
CREATE TABLE n8n_workflow_mappings (
  id TEXT PRIMARY KEY,
  n8n_workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT DEFAULT 'manual',  -- manual | scheduled | webhook
  schedule_cron TEXT,
  last_triggered_at TEXT,
  last_status TEXT,
  sort_order INTEGER DEFAULT 0
);
```

---

## Settings Integration

Add to the existing Settings page under a new "AI & Automation" section:

```
┌─ AI & Automation ────────────────────────────────────┐
│                                                       │
│  AI Provider                                          │
│  [OpenAI GPT-4o-mini ▾]     [API Key: ••••4f2k]     │
│                                                       │
│  Agent Confirmation Level                             │
│  ○ Always confirm (safest)                            │
│  ● Confirm destructive only (recommended)             │
│  ○ Auto-execute all (dangerous)                       │
│                                                       │
│  OpenClaw                                             │
│  Endpoint: [https://openclaw.example.com    ]            │
│  Status: ● Connected    [Test Connection]             │
│                                                       │
│  n8n                                                  │
│  Endpoint: [https://n8n.example.com         ]            │
│  API Key:  [••••8j2m                     ]            │
│  Status: ● Connected · 7 workflows                    │
│  [Manage workflows ↗]  [Refresh]                      │
│                                                       │
│  Undo Window                                          │
│  [30 seconds ▾]  — time before destructive actions    │
│                    become permanent                    │
└───────────────────────────────────────────────────────┘
```

---

## Open Questions / Needs Further Design

1. **OpenClaw tool registry**: Which Mission Control tools should be registered with OpenClaw? All of them, or a curated subset? The custom agent currently gets read-only context — OpenClaw could get write tools too.

2. **n8n workflow discovery**: Auto-discover workflows tagged with "mission-control" in n8n, or require manual mapping in the MC settings?

3. **Chat ↔ Agent Panel integration**: When the AI suggests dispatching an agent from chat, should it inline the confirmation in the chat bubble (current mockup approach) or navigate to the Agent Panel tab?

4. **Rate limiting / cost guardrails**: OpenClaw calls cost real money. Should there be a daily budget cap with a warning? "You've used 8 of 10 AI agent runs today."

5. **Mobile experience**: The streaming progress panel and partial approval checkboxes need mobile-friendly treatment. Likely a bottom sheet instead of a modal.

6. **Audit log vs. history**: The `agent_runs` table serves as both. Should there be a dedicated audit log view for compliance, or is the history panel sufficient for a personal tool?
