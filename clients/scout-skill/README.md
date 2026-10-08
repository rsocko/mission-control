# Scout Skill for Mission Control

This directory contains the **Scout skill definition** and **automation templates** for integrating Microsoft Scout with Mission Control.

## What Is This?

Scout acts as an intelligent connector for **business Microsoft 365**. Rather than MC directly pulling every work email, Teams message, and meeting artifact, Scout reasons over those sources and pushes only curated, actionable items into MC.

> **Important:** Scout is for business M365 only. Personal Outlook, Calendar, and Microsoft Todo use MC's direct connectors.

## Installation

### 1. Install the Skill

Copy the `SKILL.md` file to your Copilot skills directory:

```bash
mkdir -p ~/.copilot/skills/mission-control
cp SKILL.md ~/.copilot/skills/mission-control/SKILL.md
```

### 2. Install Automations

Copy the automation definitions:

```bash
mkdir -p ~/.copilot/automations
cp automations/*.json ~/.copilot/automations/
```

### 3. Configure the General Connector MCP Server

Add MC's MCP server to your user-level `.mcp.json`:

```json
{
  "servers": {
    "mission-control": {
      "type": "streamable-http",
      "url": "https://mission-control.example/api/mcp"
    }
  }
}
```

> **Note:** This connects directly to the deployed MC instance — no local process needed. For local development, you can use the stdio transport instead (see `docs/MCP-SERVER.md`).

This general connection supports Scout's connector duties: finding M365 work,
pushing curated tasks, reconciliation, and status sync. It is not the delegated
work worker.

### 4. Onboard Delegated Work Pickup

In Mission Control, open the Scout connector and choose **Generate onboarding
prompt**. Give that short bootstrap prompt to Scout. The prompt contains a
temporary registration token, not the durable worker credential.

Scout then:

1. downloads the versioned worker skill from Mission Control;
2. declares the M365 sources, actions, and Scout trigger types available in the
   current tenant;
3. confirms that its MCP connection can keep bearer credentials in protected
   credential storage;
4. waits for an operator to approve those capabilities;
5. claims the durable credential exactly once and stores it only in that
   protected connection field; and
6. configures a recurring pickup automation, normally every 15 minutes.

Do not continue onboarding if Scout can retain the durable credential only in
prompt text, automation instructions, chat history, output, or logs. Mission
Control never shows or retrieves the claimed credential in the settings UI;
restart onboarding to replace it.

The worker connection is intentionally narrower than the general connector
connection. It exposes identity, health, exact-or-next claim, progress, durable
question/approval, completion, and failure tools only.

## Automations

| File | Schedule | Description |
|---|---|---|
| `morning-triage.json` | 7am weekdays | Scans overnight business M365 activity, pushes actionable items |
| `scout-status-sync.json` | Every 2 hours | Syncs MC status changes back to Scout for write-back suppression |
| `eod-review.json` | 5pm Fridays | Weekly review — catches stale tasks, untracked commitments |
| `scout-reconciliation.json` | 2pm weekdays | Submits sanitized M365 resolution signals for policy-controlled review |

### Automation Schema

Each automation JSON file uses the Scout automation schema:

```json
{
  "name": "Human-readable name",
  "description": "Optional description",
  "triggerType": "schedule",
  "schedule": {
    "kind": "single | interval | cron",
    "naturalLanguage": "Human-readable schedule description",
    "days": [1, 2, 3, 4, 5],
    "time": { "hour": 7, "minute": 0 },
    "hour": 7,
    "minute": 0
  },
  "steps": [
    {
      "label": "Step name",
      "prompt": "The prompt to execute"
    }
  ]
}
```

Schedule `kind` options:
- `"single"` — runs once per day at `time` on specified `days` (0=Sun..6=Sat)
- `"interval"` — runs every `intervalMinutes` starting from `anchor` time
- `"cron"` — uses a `cronExpression` for complex schedules

## How It Works

```
Scout (reasons over business M365)
  → GitHub Copilot runtime (MCP over Streamable HTTP)
    → mission-control.example/api/mcp
      → Task store (dedup, index, score)
        → UI (Today, Kanban, Timeline)
```

## MCP Tools Used

| Tool | Direction | Purpose |
|---|---|---|
| `mc_scout_push_tasks` | Scout → MC | Bulk push curated items with dedup |
| `mc_scout_status_sync` | MC → Scout | Get status changes for write-back |
| `mc_scout_reconcile` | Scout → MC | Evaluate typed M365 signals with deterministic scoring and policy |
| `mc_search_tasks` | Scout → MC | Pre-push dedup check |
| `mc_create_task` | Scout → MC | Create individual tasks |
| `mc_list_projects` | Scout → MC | Map items to MC projects |

Delegated work pickup uses a separate least-privilege MCP connection:

| Tool | Purpose |
|---|---|
| `mc_agent_identity` | Verify worker, connector, capability, and policy binding |
| `mc_agent_health` | Report runtime readiness and activation constraints |
| `mc_agent_claim_work` | Claim the next dispatch or a trusted exact dispatch |
| `mc_agent_update_progress` | Renew the lease and publish progress |
| `mc_agent_request_input` | Persist a question/approval and release the claim |
| `mc_agent_complete_work` | Return the final structured result |
| `mc_agent_fail_work` | Record a sanitized failure |

MCP is the authenticated work channel; it does not wake Scout. Scheduled polling
is the guaranteed activation path. A Scout-native condition trigger may invoke
the same pickup automation sooner and pass a trusted `dispatchId`, allowing the
worker to skip broad queue discovery. Mission Control does not currently send a
webhook or event directly into Scout because Scout documents no generic inbound
wake endpoint.

Reconciliation does not give the model direct completion authority. Mission
Control stores evidence summaries and policy decisions, defaults completion to
confirmation, and permits automatic completion only through an explicit
source-scoped policy plus provider-verified provenance. The current Scout/MCP
automation supplies inferred evidence, so its high-confidence results remain
confirmation-required.

The proposed deterministic work To Do courier is maintained separately as a
disabled template under `clients/power-automate-todo-bridge/`. It must not be
installed until its Power Automate flows and `mc_todo_sync_*` MCP contracts are
deployed.
