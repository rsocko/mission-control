---
title: "Goal Promotion"
status: proposed
created: 2026-07-10
last_reviewed: 2026-07-22
category: design
related:
  - "[Wave Planning](WAVE-PLANNING-DESIGN.md)"
  - "[Insights Page](INSIGHTS-PAGE-DESIGN.md)"
mockups:
  - "[mockup-goals-view.html](../mockups/mockup-goals-view.html)"
---

# Goal to Project Promotion

## Overview

Mission Control supports promoting goals, ideas, and brainstorms into fully structured projects. This feature bridges the gap between capturing a rough idea and executing on it with phases, tasks, and tracked progress.

## How It Works

### 1. Tag a Task as a Goal

Any task tagged with `#goal`, `#idea`, or `#brainstorm` appears on the **Goals** page (`/goals`). These tags signal that the task represents something aspirational rather than an immediate action item.

### 2. AI-Powered Development

From the Goals page, click **Develop** on any goal to invoke AI analysis. The system sends the goal's title, description, tags, and linked project context to the configured AI provider, which returns:

- **Summary** — a concise analysis of the goal
- **Suggested Tasks** — 3–6 concrete, actionable tasks with effort estimates and categories
- **Suggested Project** — a proposed project structure with phases and task assignments

### 3. Review the Proposal

The AI proposal appears in a side panel. You can review the suggested tasks, phases, and project structure before committing to anything.

### 4. Promote to Project

Click **Create Project** to promote the goal. This atomically:

1. Creates a new hub project with the suggested name, description, and category
2. Creates project phases (first phase set to `in_progress`, rest to `pending`)
3. Creates individual tasks within each phase and links them to the project
4. Marks the original goal task as `done` with metadata linking it to the new project

## API Endpoints

### `GET /api/goals`

Fetch tasks tagged with `#goal`, `#idea`, or `#brainstorm`.

**Query Parameters:**
| Param | Default | Description |
|---------|---------|----------------------------------------|
| `filter` | `all` | `all`, `goal`, `idea`, or `brainstorm` |
| `project` | — | Filter by linked project ID |

**Response:** `{ items: GoalItem[], counts: { goal, idea, brainstorm } }`

### `POST /api/goals/develop`

AI-powered idea expansion. Generates a project proposal from a goal.

**Body:** `{ taskId: string }`

**Response:** `{ proposal: { summary, suggestedTasks[], suggestedProject } }`

Requires an AI provider to be configured (returns `503` otherwise).

### `POST /api/goals/promote`

Convert a goal into a full project with phases and tasks.

**Body:**
```json
{
  "taskId": "string",
  "projectName": "string",
  "projectDescription": "string (optional)",
  "category": "string (optional)",
  "color": "string (optional)",
  "phases": [
    {
      "name": "string",
      "description": "string (optional)",
      "tasks": [
        { "title": "string", "description": "string (optional)" }
      ]
    }
  ]
}
```

**Response (201):**
```json
{
  "projectId": "string",
  "projectName": "string",
  "phasesCreated": 2,
  "tasksCreated": 5
}
```

## Data Flow

```
Goal Task (#goal tag)
  │
  ├─► GET /api/goals ──► Goals Page (list + filter)
  │
  ├─► POST /api/goals/develop ──► AI Proposal (side panel)
  │
  └─► POST /api/goals/promote ──► Hub Project + Phases + Tasks
        │
        ├─ hub_projects row (metadata.promotedFrom = taskId)
        ├─ project_phases rows (ordered, first = in_progress)
        ├─ tasks rows (linked via task_projects + project_phase_items)
        └─ original task marked done (metadata.promotedToProject = projectId)
```
