---
title: "External Agent Integration"
status: proposed
created: 2026-07-19
last_reviewed: 2026-09-30
category: design
related:
  - "[Paperclip Adoption and Integration](paperclip-adoption-and-integration.md)"
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
5. **Transport follows agent capability** — Some agents accept pushes; others, including Scout and a GitHub Copilot app local automation, must poll and claim queued work. The dispatch lifecycle is transport-independent.
6. **Minimize disclosed context** — Preview and classify every payload. Sensitive content should remain in its tenant-managed execution environment whenever possible.
7. **Inference is not execution** — Copilot model access through Bifrost cannot read a repository, run commands, or open a PR. Coding execution requires an explicit execution adapter with repository and tool authority.
8. **Execution locality is user-visible** — Never silently move work among MC-hosted, developer-workstation, and GitHub-hosted execution. The preview identifies where code and task context will be processed.

---

## Orchestration provider boundary

The implemented external-agent control plane remains the canonical MC
dispatch, disclosure, approval, lifecycle, and receipt substrate. Paperclip
does not replace it; Paperclip is a first-class provider behind it.

| Route | Use when | Orchestration owner |
|---|---|---|
| MC built-in operation | The action is bounded and entirely inside MC | Mission Control |
| Direct external executor | One known worker can complete the outcome | MC dispatches to Copilot, Scout, OpenClaw, n8n, or another registered worker |
| Paperclip orchestration | Work benefits from decomposition, multiple agents, budgets, recurring execution, or Paperclip approvals | Paperclip manages its internal issues/runs; MC retains the parent outcome |

MC must not recreate Paperclip's internal agent chaining, org chart, issue
decomposition, or budgets. Conversely, Paperclip must not bypass MC's
classification, disclosure preview, source authority, or Scout guardrails.
Direct execution routes remain valid; adopting Paperclip does not force every
delegation through it.

Houston is the user-facing intent and explanation surface over this routing
model. It may recommend or initiate a confirmed dispatch, but it is not the
dispatch persistence boundary and is not automatically a Paperclip agent. See
[Houston AI Identity](../active/houston-ai-identity.md).

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
                     │  Paperclip orchestration provider       │
                     │  Copilot app pull worker                │
                     │  Custom agents: MCP / REST / n8n        │
                     └─────────────────────────────────────────┘
```

### Implemented persistence boundary

The external-agent control plane is backend-neutral. One
`ExternalAgentControlPersistence` aggregate is registered in the existing
worker composition and selects either the SQLite or PostgreSQL adapter. It owns
registry CRUD, protected inbound-webhook reference validation, immutable
payload snapshots, and the complete dispatch state machine. There is no
process-global agent registry, SQLite fallback, dual write, or schema change.

All network and MCP work occurs after an attempt-begin transaction commits and
before a fenced finalize transaction starts. Pull claims store only a
SHA-256 token hash. Result callbacks, transport responses, errors, provider
details, and event details are bounded and redacted before persistence.
Terminal result replay succeeds only for the same canonical digest.

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
  auth_credential TEXT,                    -- optional UI-managed credential; never serialized to clients
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
| `paperclip` | Paperclip parent issue assigned to a configured Paperclip agent | `POST /api/companies/{companyId}/issues` with a stable MC idempotency key | Issue, heartbeat-run, approval, and work-product polling |
| `webhook-roundtrip` | Any system that accepts a POST and calls back | POST to `endpoint` with MC context | Agent POSTs back to `inbound_webhook_id` |
| `mcp` | MCP-compatible tool server | MCP tool invocation protocol | Inline response |
| `pull-queue` | Agent without a supported inbound API, such as Scout or a Copilot app local automation | Agent polls MC and atomically claims a dispatch | Agent completes/fails through scoped MC tools |
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

GitHub Copilot Cloud personal access tokens are entered directly in **Settings → AI &
Agents**. Mission Control validates the token with GitHub, persists it in the
destination's server-side credential field, and never returns it in API
responses or persists it in payload/result logs. Existing installations may
instead select the advanced deployment-secret-reference mode, which resolves
`auth_credential_ref` from `MC_EXTERNAL_AGENT_CREDENTIALS_JSON`. Paperclip
bearer credentials continue to use deployment-secret references.

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
2. Before transmission, MC validates the user credential, exact repository identity, base ref, Copilot repository eligibility, and Agent tasks read permission. The create request then validates write permission.
3. After confirmation, MC calls `POST /agents/repos/{owner}/{repo}/tasks` with the reviewed context serialized into `prompt`, optional `base_ref`, optional `model`, and `create_pull_request`.
4. MC stores the returned GitHub agent task ID and polls `GET /agents/repos/{owner}/{repo}/tasks/{task_id}`. `idle` maps to canonical `in_progress`; all other documented provider states map directly.
5. The persisted provider task ID is the normal restart-reconciliation anchor. If a process stopped after GitHub accepted a create request but before that ID was stored, MC resumes the fenced attempt after its lease expires and scans recent Agent tasks for the dispatch marker in the exact prompt so a response-loss retry does not create duplicate work.
6. Branch artifacts are recorded directly. Pull artifacts are resolved through the existing GitHub REST client, verified against the confirmed repository, and persisted as branch, commit, and PR references.

The Agent Tasks API is public preview and currently accepts only user-to-server
credentials, such as a PAT, OAuth user token, or GitHub App user token. GitHub
App installation access tokens are not supported for this cloud-dispatch API.
Tokens remain server-side either in the destination credential field or behind
`auth_credential_ref`; they are never included in previews, provider details,
events, or API responses. MC reports credential, entitlement,
repository-policy, token-scope, validation, and rate-limit failures with
actionable errors and never falls back to another execution mode or repository.

`POST /api/external-agents/reconcile` performs bounded reconciliation of all
persisted active GitHub-hosted dispatches and is safe to run after process
restart. Reading an individual dispatch also refreshes its provider state.
GitHub does not currently expose an Agent Tasks cancellation endpoint. Once a
provider task ID exists, MC returns `CANCELLATION_UNSUPPORTED` instead of
claiming that the upstream task was cancelled; cancellation before submission
remains local and durable.

Issue assignment to `copilot-swe-agent[bot]` with an explicit
`agent_assignment` remains a documented compatibility path, but this adapter
does not silently switch to it when direct Agent Tasks dispatch fails. A
`copilot` label alone is never a dispatch contract.

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

#### `pull-queue`

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

##### GitHub Copilot app pull-worker profile

Issue #1519 tracks a developer-workstation coding profile that reuses this
generic transport. A supported Copilot app local automation polls MC through
authenticated, least-privilege MCP tools, claims only work compatible with its
registered repositories and capabilities, executes in an app-managed isolated
worktree, and returns structured branch, commit, check, artifact, and PR
references.

This is neither the MC-hosted Copilot SDK workspace nor GitHub-hosted cloud
dispatch. The destination is a named user/workstation-owned worker with
`external` locality, and the preview must say that execution depends on that
workstation and automation being available. MC does not receive the worker's
Copilot or GitHub credentials. The worker's MC credential is independently
revocable and scoped to its agent identity, repositories, classifications, and
actions.

The feasibility gate must prove that scheduled or on-demand local automations
can use the documented app and MCP surfaces without UI automation. Offline,
sleep, expired-auth, interactive-permission, cancellation, overlapping-run,
and lease-expiry behavior must remain visible in MC. A retry cannot silently
switch to the MC-hosted workspace or GitHub-hosted cloud modes.

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

### Provider-neutral task delegation

**Delegate** is the stable task action. Configured GitHub Copilot Cloud and Paperclip
routes are typed execution destinations; source connectors remain separate.
Operators manage those destinations in **Settings → AI & Agents → Execution
Destinations**. GitHub Copilot Cloud setup accepts and validates a personal access
token directly; deployment-secret references remain available as an advanced
and backward-compatible option. Paperclip references remain server-side in
`MC_EXTERNAL_AGENT_CREDENTIALS_JSON`. GitHub Copilot Cloud and Paperclip setup,
validation, enablement, capability policy, and data
classification policy are managed there. Paperclip route bindings are validated
when saved and remain read-only during individual delegations.
The same centered wizard opens from the task-detail header, task-row context
menu, and task bulk-action bars:

1. **Destination** selects one configured execution route.
2. **Configure and eligibility** displays destination-specific inputs plus exact
   ready and blocked tasks.
3. **Review** materializes durable disclosure previews. No provider receives
   task context until the user explicitly confirms those previews.

GitHub-origin tasks stay locked to their exact source repository. Other tasks
may select only repositories discovered from enabled GitHub connectors.
Paperclip company, project, assignee, and adapter fields are bound during route
setup and remain read-only during delegation. Bulk delegation fans out to one
durable assignment per eligible task and reports every blocked task instead of
silently skipping it.

After delegation, task rows show one compact state badge. Task details show the
destination, locality, canonical state, latest progress or blocker, base ref,
attempt, and best output link. **More details** opens a focused run dialog with
timeline, execution facts, provider IDs, outputs, disclosure, attempts, errors,
refresh, retry, and cancellation controls. GitHub Agent Tasks has no true
cancellation API: Mission Control can stop tracking while provider work may
continue.

The approved interaction study is preserved as a behavioral reference in
[Task delegation UX study](task-delegation.html). It is not runtime code or a
pixel-exact specification.

### Context actions (right-click / command palette)

From a task row, **Delegate** opens the same protected wizard with the task
already bound. Manual context export remains a separate workflow.

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

### Delivered foundation

- Backend-neutral external-agent registry and durable dispatch lifecycle
- Immutable payload snapshots, classification, field disclosure, destination
  binding, preview confirmation, retries, cancellation, and terminal fencing
- Push, pull/claim, MCP, manual, and inference transport contracts
- Atomic pull claims with token hashes, leases, expiry, and idempotent results
- SQLite and PostgreSQL persistence parity

The closed foundation issue is #536. The old generic inbound/outbound issues
#655 and #658 are fulfilled by that implementation and should not be treated as
new Paperclip work.

### Remaining manual bridge

- **"Copy as agent context"** action on task lists and project views
- Context serialization to clipboard (JSON + Markdown formats)
- **"Import agent results"** on AI page (paste JSON/Markdown/CSV → review queue)
- Reuse `PhaseProposalReview` for the review step

### Provider and user experience delivery

- Paperclip provider and correlation contract (#2012)
- Generic execution-assignment UI with Paperclip as one target (#2013)
- Paperclip approval notifications (#2014)
- Paperclip-to-MC-to-Scout guarded requests (#2015)

### Direct executor delivery

- GitHub cloud dispatch through the Agent Tasks REST API
- User-to-server OAuth/PAT credential flow, entitlement checks, and token-scope diagnostics
- Issue assignment as a compatibility/fallback entry point, not label-based dispatch
- Cloud task polling, waiting-for-user UX, PR detection, and auto-linking
- Separate isolated local SDK workspace adapter after the #1148 runtime spike
- Per-dispatch execution-locality preview with no silent local/cloud fallback
- Task status sync when PRs merge
- Deep-link generation for Copilot Chat (VS Code + GitHub.com)

### MCP and automation

- MCP client for invoking tool servers directly from MC
- Pull-queue tools for agents without a supported inbound API
- GitHub Copilot app pull-worker feasibility and delivery (#1519)
- n8n workflow templates for common patterns
- Scheduled agent dispatches (e.g., "every Monday, run competitor analysis")
- Direct single-provider chaining only where it does not duplicate Paperclip;
  multi-agent orchestration belongs to Paperclip when that provider is selected

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
4. A Copilot app pull worker is user/workstation-owned, uses the generic leased pull queue, and is available only while its local automation environment can run.
5. Cloud task creation requires a user-to-server token. Server-to-server installation tokens are not accepted by the preview API.
6. MC-hosted, developer-workstation, and GitHub-hosted modes have separate credentials, permission policies, status adapters, and cleanup responsibilities.
7. A retry remains in the selected execution mode unless the user explicitly previews and confirms a new dispatch in another mode.
