---
title: "External Agent Integration"
status: proposed
created: 2026-07-19
last_reviewed: 2026-08-03
category: design
related:
  - "[AI & Agent Architecture (consolidated)](../active/ai-agent-architecture.md)"
  - "[Scout Smart Connector](scout-smart-connector.md)"
  - "[AI Assistant Completion](../active/ai-assistant-completion.md)"
  - "[Houston Identity](../active/houston-ai-identity.md)"
  - "[Wave Planning](../active/wave-planning.md)"
  - "[Future Integrations](future-integrations.md)"
  - "[Structured Graph Workspace](structured-graph-workspace/README.md)"
mockups: []
---

# External Agent Integration — Design Spec

## Summary

Mission Control already has a powerful internal AI layer (chat, insights, agent dispatch, phase planning). This design extends it to **leverage external agents** — GitHub Copilot, custom MCP servers, n8n workflows, or any agent that can produce structured output — and to **dispatch work outward** from Mission Control to those agents.

Two directions of flow:

1. **Inbound**: External agent → Mission Control (structured task/phase data arrives)
2. **Outbound**: Mission Control → External agent (MC sends context, agent does work, result comes back)

---

## Problem

The user often needs to:
- Have an external AI (e.g., GitHub Copilot with codebase access) analyze a repo, then structure the resulting work items in Mission Control
- Dispatch a development task from MC to an agent that can actually write code, open PRs, or run builds
- Compose multi-agent workflows: MC plans the work → external agent executes → results flow back into MC

Today, these hand-offs require manual copy-paste between tools. There is no programmatic bridge.

---

## Design Principles

1. **MC is the control plane** — Mission Control plans, sequences, and tracks. Domain-specific work runs in an external service or a separately isolated MC-managed worker, never in the web request process.
2. **Protocol-first** — Use open standards (webhooks, MCP, REST) so any agent can integrate, not just GitHub Copilot.
3. **Human-in-the-loop by default** — Outbound dispatches require confirmation. Inbound results land in a review queue before being committed.
4. **Leverage what exists** — Build on top of the existing inbound webhook system, the agent dispatch framework, and the phase proposal review UI.
5. **Transport follows agent capability** — Some agents accept pushes; others, including Scout, must poll and claim queued work. The dispatch lifecycle is transport-independent.
6. **Minimize disclosed context** — Preview and classify every payload. Sensitive content should remain in its tenant-managed execution environment whenever possible.
7. **Inference is not execution** — Copilot model access through Bifrost cannot read a repository, run commands, or open a PR. Coding execution requires an explicit local-workspace or hosted-cloud adapter.
8. **Execution locality is user-visible** — Never silently move work between an MC-hosted workspace and a GitHub-hosted cloud agent. The preview identifies where code and task context will be processed.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Mission Control                              │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │ Agent        │   │ Outbound     │   │ Inbound Agent           │ │
│  │ Registry     │──▶│ Dispatcher   │   │ Receiver                │ │
│  │              │   │              │   │ (extends inbound        │ │
│  │ - name       │   │ - serialize  │   │  webhooks)              │ │
│  │ - type       │   │   context    │   │                         │ │
│  │ - endpoint   │   │ - POST to    │   │ - parse structured      │ │
│  │ - auth       │   │   agent      │   │   results               │ │
│  │ - caps       │   │ - poll/wait  │   │ - create tasks/phases   │ │
│  └──────────────┘   └──────┬───────┘   │ - queue for review      │ │
│                            │           └────────────▲─────────────┘ │
│                            │                        │               │
└────────────────────────────┼────────────────────────┼───────────────┘
                             │                        │
                     ┌───────▼────────────────────────┼───────┐
                     │          External Agents                │
                     │                                         │
                     │  ┌─────────────┐  ┌──────────────────┐ │
                     │  │ Copilot     │  │ Copilot SDK      │ │
                     │  │ Cloud Agent │  │ Workspace Agent  │ │
                     │  └─────────────┘  └──────────────────┘ │
                     │  Custom agents: MCP / REST / n8n        │
                     └─────────────────────────────────────────┘
```

---

## Part 1: Agent Registry

A lightweight config table that knows about available external agents.

### Schema

```sql
CREATE TABLE external_agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,           -- "GitHub Copilot Coding Agent"
  type            TEXT NOT NULL,           -- 'copilot-cloud' | 'copilot-sdk-workspace' | 'webhook-roundtrip' | 'mcp' | 'pull-queue' | 'manual'
  description     TEXT,
  endpoint        TEXT,                    -- URL to invoke (null for manual)
  auth_type       TEXT DEFAULT 'none',     -- 'none' | 'bearer' | 'hmac' | 'github-user' | 'github-app'
  auth_credential_ref TEXT,                -- reference to a secret manager entry; never the token itself
  capabilities    TEXT DEFAULT '{}',       -- JSON: { executionLocality, canAnalyzeCode, canWriteCode, canRunCommands, canPush, canCreatePR }
  input_format    TEXT DEFAULT 'mc-tasks', -- 'mc-tasks' | 'markdown' | 'custom-json'
  output_format   TEXT DEFAULT 'mc-tasks', -- 'mc-tasks' | 'mc-phases' | 'github-issues' | 'raw'
  inbound_webhook_id TEXT,                 -- links to existing inbound_webhooks for receiving results
  enabled         INTEGER DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### Pre-configured Agent Types

| Type | Description | Dispatch method | Result collection |
|------|-------------|-----------------|-------------------|
| `copilot-cloud` | GitHub-hosted Copilot cloud agent | `POST /agents/repos/{owner}/{repo}/tasks`; issue assignment is a compatibility path | Agent Tasks polling plus PR/issue webhooks |
| `copilot-sdk-workspace` | MC-hosted Copilot SDK coding runtime | Provision isolated clone/worktree, then start a scoped SDK session | SDK events plus Git/PR references |
| `webhook-roundtrip` | Any system that accepts a POST and calls back | POST to `endpoint` with MC context | Agent POSTs back to `inbound_webhook_id` |
| `mcp` | MCP-compatible tool server | MCP tool invocation protocol | Inline response |
| `pull-queue` | Agent without a supported inbound API, such as Scout | Agent polls MC and atomically claims a dispatch | Agent completes/fails through scoped MC tools |
| `manual` | Human-assisted hand-off (deep-link + clipboard) | Opens URL with pre-filled context | User pastes/imports result |

---

## Part 2: Outbound Dispatch

### Context Serialization

When dispatching work to an external agent, MC serializes relevant context:

```typescript
interface AgentDispatchPayload {
  // What MC wants the agent to do
  instruction: string;

  // Scope
  project?: { id: string; name: string; description: string };
  repository?: { owner: string; repo: string; defaultBranch: string };
  execution?: {
    locality: 'mission-control-host' | 'github-cloud' | 'external';
    baseRef?: string;
    createPullRequest?: boolean;
  };

  // Work items to act on
  tasks: Array<{
    id: string;
    title: string;
    description: string | null;
    priority: string;
    status: string;
    tags: string[];
    phase?: string;
  }>;

  // Optional: existing phase plan for context
  phases?: Array<{
    name: string;
    description: string;
    taskIds: string[];
    sortOrder: number;
  }>;

  // Callback
  callbackUrl: string;      // MC's inbound webhook URL for results
  callbackSecret?: string;  // HMAC secret for verifying the callback
  dispatchId: string;       // correlate response to this dispatch

  // Disclosure and side-effect controls
  dataClassification: 'standard' | 'sensitive';
  allowedActions: string[];
  requiresConfirmation: boolean;
}
```

### API: `POST /api/external-agents/dispatch`

The implemented API uses a durable two-step boundary:

1. The initial request creates (or idempotently returns) a
   `needs_confirmation` dispatch and returns the exact allowlisted payload,
   disclosed field names, processing locality, and a destination-bound
   `previewHash`.
2. A second request with `{ confirm: true, dispatchId, previewHash }` is
   accepted only while the payload and destination configuration still match
   the reviewed preview. Retries reuse the selected locality and provider
   idempotency identity; they never fall back to another execution mode.

Credential values are supplied server-side from
`MC_EXTERNAL_AGENT_CREDENTIALS_JSON`, keyed by `auth_credential_ref`. Only the
reference is stored in the registry, and neither the reference nor the
credential value is returned in API responses or persisted payload/result
logs.

```typescript
// Request
{
  agentId: string;           // external_agents.id
  instruction: string;       // "Analyze the codebase and create tasks for v2 migration"
  scope: {
    projectId?: string;      // scope to a project's tasks
    taskIds?: string[];      // or explicit task IDs
    repository?: string;     // "owner/repo" for code-aware agents
  };
  dryRun?: boolean;          // preview what would be sent
}

// Response
{
  dispatchId: string;
  status: 'sent' | 'queued' | 'manual-handoff';
  agentName: string;
  payloadPreview?: AgentDispatchPayload;  // if dryRun
  manualUrl?: string;                      // for type='manual' — deep link
}
```

### Dispatch Flows by Agent Type

#### `copilot-cloud` (GitHub-hosted cloud agent)

1. MC previews the exact prompt, repository, base ref, model selection, and whether a PR should be created.
2. After confirmation, MC calls `POST /agents/repos/{owner}/{repo}/tasks` with `prompt`, optional `base_ref`, optional `model`, and `create_pull_request`.
3. MC stores the returned GitHub agent task ID and polls its status. Supported states include `queued`, `in_progress`, `idle`, `waiting_for_user`, and terminal outcomes.
4. PR/issue webhooks and the existing GitHub connector associate created branches and PRs with the dispatch.
5. If the Agent Tasks API is unavailable, MC may assign an issue to `copilot-swe-agent[bot]` with an explicit `agent_assignment`; merely adding a `copilot` label is not a supported dispatch contract.

The Agent Tasks API is public preview and currently accepts only user-to-server
credentials, such as a PAT, OAuth user token, or GitHub App user token. GitHub
App installation access tokens are not supported for this cloud-dispatch API.
MC must report entitlement, repository-policy, and token-scope failures without
falling back to another execution mode.

#### `copilot-sdk-workspace` (MC-hosted workspace agent)

1. MC provisions a per-dispatch clone/worktree on the machine or worker running the SDK.
2. The direct Copilot SDK runtime starts with an isolated `COPILOT_HOME`, session state, workspace root, and credentials.
3. The permission policy separately gates file access, command execution, network access, Git writes, pushes, and PR creation.
4. SDK progress events are persisted so browser and mobile clients can disconnect and reconnect.
5. The worker returns structured branch, commit, checks, and PR references, then removes ephemeral credentials, processes, and workspace data.

This mode can read only code cloned or explicitly mounted into its execution
environment. It cannot reach arbitrary files on a user's desktop through the
browser or PWA. Shared-server deployments must isolate tenants and workspaces;
Houston's safe `mode: "empty"` runtime must not be reused as a CLI-like coding
runtime. Copilot model requests and repository Git/GitHub operations may require
different credentials; both are injected only for the active worker and scoped
to their separate purposes.

**Deep-link for Copilot Chat (manual mode)**:
```
https://github.com/{owner}/{repo}?copilot=1&prompt={urlEncodedInstruction}
```
Or open VS Code with a pre-filled Copilot prompt via `vscode://` URI.

#### `webhook-roundtrip`

1. MC POSTs the `AgentDispatchPayload` to the agent's `endpoint`
2. Agent processes asynchronously
3. Agent calls back to MC's inbound webhook with structured results
4. MC matches the `dispatchId` and routes to the review queue

#### `mcp`

1. MC invokes the MCP tool with the serialized context
2. Receives structured response synchronously (or via SSE)
3. Parses into tasks/phases and routes to review

#### `pull-queue` (Scout)

1. MC creates a queued dispatch after an explicit user preview/confirmation.
2. The agent polls a scoped queue that returns only claimable work.
3. The agent atomically claims a dispatch and receives a claim token and lease.
4. The agent performs read-only work or requests additional confirmation for a
   side effect not already approved.
5. Completion/failure requires the active claim token; duplicate calls are
   idempotent and expired claims can be safely requeued.
6. MC stores only the minimum result needed for status, audit, and user review.

This transport is preferred over a GitHub issue bridge for Scout because
business M365 payloads should not be copied into a code-hosting work item.

#### `manual`

1. MC serializes context to clipboard or a shareable URL
2. Opens the target tool (Copilot Chat, Claude, etc.) with a deep link
3. User completes the work externally
4. User imports results back via paste, file upload, or the "Import from Agent" UI

---

## Part 3: Inbound Result Processing

External agents return structured results. These extend the existing inbound webhook system.

### Enhanced Inbound Webhook — Agent Result Format

Only an inbound webhook payload with `type: "agent-result"` is routed as an
agent response. A `dispatchId` on any other payload does not change normal
task/alert handling:

```typescript
interface AgentResultPayload {
  type: 'agent-result';
  dispatchId: string;         // correlate to outbound dispatch
  agentName?: string;

  // Option A: Task list (simple)
  tasks?: Array<{
    title: string;
    description?: string;
    priority?: string;
    tags?: string[];
    phase?: string;
    estimatedHours?: number;
  }>;

  // Option B: Full phase plan (rich)
  phases?: Array<{
    name: string;
    description: string;
    tasks: Array<{
      title: string;
      description?: string;
      priority?: string;
    }>;
    estimatedDays?: number;
  }>;

  // Option C: Modifications to existing tasks
  modifications?: Array<{
    taskId: string;
    field: string;
    oldValue?: string;
    newValue: string;
    reasoning: string;
  }>;

  // Suggestions
  suggestedClosures?: Array<{
    taskId?: string;
    title: string;
    reasoning: string;
  }>;

  // Agent's reasoning
  summary: string;

  // Option D: Code execution references
  codeChange?: {
    repository: string;
    baseRef?: string;
    branchRef?: string;
    commitSha?: string;
    pullRequestUrl?: string;
    checks?: Array<{ name: string; status: string; url?: string }>;
    artifacts?: Array<{ name: string; url: string; mediaType?: string }>;
  };
}
```

### Review Queue

Agent results don't auto-commit. They land in a **review queue** that reuses the `PhaseProposalReview` pattern:

1. Results appear in the AI page or as a notification banner
2. User reviews: accept all, accept with modifications, or reject
3. Accepted tasks are created via the normal task creation pipeline
4. Accepted phases are created via the project-phases API

### Dispatch Tracking Table

```sql
CREATE TABLE agent_dispatches (
  id                TEXT PRIMARY KEY,
  external_agent_id TEXT NOT NULL REFERENCES external_agents(id),
  instruction       TEXT NOT NULL,
  scope_project_id  TEXT,
  scope_task_ids    TEXT,              -- JSON array
  scope_repository  TEXT,              -- "owner/repo"
  status            TEXT NOT NULL,     -- 'queued' | 'claimed' | 'in_progress' | 'waiting_for_user' | 'needs_confirmation' | 'completed' | 'failed' | 'timed_out' | 'dead_letter' | 'cancelled'
  data_classification TEXT NOT NULL DEFAULT 'standard',
  allowed_actions   TEXT DEFAULT '[]', -- JSON array
  claim_token_hash  TEXT,
  claimed_at        TEXT,
  lease_expires_at  TEXT,
  attempt_count     INTEGER DEFAULT 0,
  payload_sent      TEXT,              -- JSON: the AgentDispatchPayload
  result_raw        TEXT,              -- JSON: raw agent response
  result_status     TEXT,              -- 'pending_review' | 'accepted' | 'rejected' | 'partial'
  tasks_created     INTEGER DEFAULT 0,
  phases_created    INTEGER DEFAULT 0,
  github_issue_url  TEXT,              -- for cloud issue-assignment compatibility
  github_pr_url     TEXT,
  execution_mode    TEXT,              -- 'github-cloud' | 'mission-control-host' | 'external'
  provider_task_id  TEXT,              -- GitHub cloud task ID or external provider ID
  base_ref          TEXT,
  branch_ref        TEXT,
  commit_sha        TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  reviewed_at       TEXT
);
```

Dispatch state transitions and claim updates must be atomic. Raw claim tokens
are returned once and stored only as hashes. Results, errors, and payloads are
size-limited and redacted before persistence. A dispatch cannot transition from
`cancelled`, `completed`, or `dead_letter` back to executable state without an
explicit user retry that creates a new attempt.

---

## Part 4: UI Integration

### Agent Panel (extension of existing `/ai` page)

Add an "External Agents" section to the AI page:

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Assistant                                                    │
│                                                                  │
│  [Chat]  [Insights]  [Agents]  [External Agents]                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ⚡ GitHub Copilot Coding Agent          [Dispatch ▸]      │  │
│  │  GitHub cloud · Analyze code · Create PRs · Write tests    │  │
│  │  Last used: 2d ago · 3 dispatches                          │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  🔄 n8n Research Workflow                [Dispatch ▸]      │  │
│  │  Web research · Data enrichment                            │  │
│  │  Last used: never                                          │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  📋 Manual (Clipboard)                   [Copy Context ▸]  │  │
│  │  Export context for any external AI tool                    │  │
│  │  Last used: 5h ago                                         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Pending Results (2)                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  🟡 Copilot: "Migration tasks for v2"   [Review ▸]        │  │
│  │     12 tasks · 3 phases · received 10m ago                 │  │
│  │  🟡 n8n: "Competitor feature audit"     [Review ▸]         │  │
│  │     8 tasks · received 2h ago                              │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Dispatch Modal

When the user clicks "Dispatch", a modal opens:

```
┌───────────────────────────────────────────────┐
│  Dispatch to GitHub Copilot Coding Agent       │
│                                                │
│  Execution:                                    │
│  ● GitHub-hosted cloud agent                   │
│  ○ MC-hosted isolated workspace                │
│                                                │
│  Instruction:                                  │
│  ┌──────────────────────────────────────────┐  │
│  │ Analyze the codebase and break down the  │  │
│  │ auth migration into implementable tasks  │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  Scope:                                        │
│  ○ Project: Mission Control (23 tasks)         │
│  ○ Selected tasks (4 selected)                 │
│  ○ Repository: your-org/mission-control          │
│                                                │
│  Include:                                      │
│  ☑ Current task list                           │
│  ☑ Phase plan (if exists)                      │
│  ☑ Repository context                          │
│                                                │
│  [Preview Payload]   [Cancel]   [Dispatch ▸]   │
└───────────────────────────────────────────────┘
```

### Context Actions (right-click / ⌘K)

From any task list, project view, or phase plan:
- **"Send to agent…"** — opens dispatch modal with the current scope pre-filled
- **"Copy as agent context"** — serializes to clipboard for manual paste into Copilot Chat, Claude, etc.

### Result Import (manual flow)

For the `manual` agent type, provide a quick import path:

- **"Import agent results"** button on AI page
- Accepts: JSON (matching `AgentResultPayload`), Markdown table (parsed into tasks), or CSV
- Parsed results go through the same review queue as automated results

---

## Part 5: Practical Scenarios

### Scenario A: Code Analysis → Task Breakdown

1. User is on the Mission Control project page
2. Clicks **"Dispatch → GitHub Copilot"**
3. Instruction: *"Look at the auth module and break down what's needed for OAuth2 support"*
4. MC creates a hosted Agent Task for the selected repository and base ref
5. Copilot cloud agent analyzes the code and returns task/PR state
6. MC polls task state and uses GitHub events to detect linked results
7. User reviews the proposed tasks in MC → accepts → tasks are created and auto-phased

### Scenario B: Copilot Chat → Mission Control Import

1. User is in VS Code / GitHub Copilot Chat
2. Asks Copilot to analyze a codebase and produce a task plan
3. Copilot outputs a structured JSON or markdown table
4. User copies the output
5. In MC, clicks **"Import agent results"** → pastes
6. MC parses into tasks → review queue → accept → tasks created

### Scenario C: n8n Workflow Integration

1. User configures an n8n workflow as a `webhook-roundtrip` agent
2. The workflow does: web research → summarize → produce tasks
3. User dispatches from MC: *"Research competitors for task management"*
4. n8n receives the payload, runs the workflow
5. n8n calls back to MC's inbound webhook with structured tasks
6. User reviews and accepts

### Scenario D: Phase Plan → Copilot Execution

1. User has a phased project plan in MC
2. Selects Phase 1 tasks → **"Send to Copilot Coding Agent"**
3. Instruction: *"Implement these tasks. Create one PR per task."*
4. Copilot creates PRs linked to the phase
5. As PRs are merged, MC's GitHub connector updates task status
6. Phase 1 auto-completes → user advances to Phase 2

---

## Implementation Phases

### Phase 1: Manual Bridge (Low effort, immediate value)
- **"Copy as agent context"** action on task lists and project views
- Context serialization to clipboard (JSON + Markdown formats)
- **"Import agent results"** on AI page (paste JSON/Markdown/CSV → review queue)
- Reuse `PhaseProposalReview` for the review step
- No new schema tables needed — just UI + serialization logic

### Phase 2: Agent Registry + Dispatch Tracking
- `external_agents` table + settings UI for configuring agents
- `agent_dispatches` table for tracking sent/received
- Dispatch API (`POST /api/external-agents/dispatch`)
- Extend inbound webhook receiver to handle `agent-result` payloads
- Pending results notification in AI page

### Phase 3: GitHub Copilot Integration
- GitHub cloud dispatch through the Agent Tasks REST API
- User-to-server OAuth/PAT credential flow, entitlement checks, and token-scope diagnostics
- Issue assignment as a compatibility/fallback entry point, not label-based dispatch
- Cloud task polling, waiting-for-user UX, PR detection, and auto-linking
- Separate isolated local SDK workspace adapter after the #2090 runtime spike
- Per-dispatch execution-locality preview with no silent local/cloud fallback
- Task status sync when PRs merge
- Deep-link generation for Copilot Chat (VS Code + GitHub.com)

### Phase 4: MCP + Automation
- MCP client for invoking tool servers directly from MC
- Pull-queue tools for agents without a supported inbound API
- n8n workflow templates for common patterns
- Scheduled agent dispatches (e.g., "every Monday, run competitor analysis")
- Agent chaining (output of one agent feeds the next)

---

## API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/external-agents` | GET/POST | List and register external agents |
| `/api/external-agents/[id]` | GET/PATCH/DELETE | Manage a specific agent |
| `/api/external-agents/dispatch` | POST | Send work to an external agent |
| `/api/external-agents/dispatches` | GET | List dispatch history |
| `/api/external-agents/dispatches/[id]` | GET/PATCH | View/update dispatch (accept/reject results) |
| `/api/external-agents/dispatches/claim` | POST | Atomically claim queued work with a lease |
| `/api/external-agents/dispatches/[id]/result` | POST | Complete/fail a claimed dispatch idempotently |
| `/api/external-agents/import` | POST | Manual import of agent results (paste/upload) |
| `/api/inbound-webhooks/[id]/receive` | POST | *(existing)* — extended to handle `agent-result` payloads |

---

## Open Questions

1. **MCP client in Next.js** — Should MC act as an MCP client? This would let it invoke any MCP-compatible tool server (file search, code analysis, database queries) directly. The Vercel AI SDK has MCP client support.

2. **Agent result format standardization** — Should we define an "MC Agent Protocol" that any agent can implement, or stay fully flexible with field mappings (like the current inbound webhook system)?

3. **Copilot cloud API stability** — The Agent Tasks API is public preview and may evolve. Keep its adapter versioned and isolate provider states from MC's canonical dispatch lifecycle.

4. **Security model for outbound dispatch** — When MC sends task data to an external agent, what data should be redacted? Should there be a per-agent allowlist of fields? For tunneled/cloud callbacks, require scoped per-agent API keys, HMAC request signatures, replay protection, rate limits, audit logging, and least-privilege tool scopes.

5. **Work IQ feasibility** — Work IQ A2A/MCP is the supported Microsoft
intelligence surface closest to Scout's M365 capabilities, but requires
delegated authentication, tenant enablement/admin consent, and billing. Run a
tenant-approved PoC before selecting it as the direct execution path.

## Resolved Copilot Execution Boundaries

1. Bifrost/Copilot provider routing is inference only and does not imply code access.
2. Direct Copilot SDK execution is MC-hosted and can access only a provisioned clone/worktree.
3. Copilot cloud dispatch is GitHub-hosted and uses the Agent Tasks API; issue assignment remains a compatibility path.
4. Cloud task creation requires a user-to-server token. Server-to-server installation tokens are not accepted by the preview API.
5. Local and cloud modes have separate credentials, permission policies, status adapters, and cleanup responsibilities.
6. A retry remains in the selected execution mode unless the user explicitly previews and confirms a new dispatch in another mode.
