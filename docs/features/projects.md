---
title: Projects
sidebar_label: Projects
sidebar_position: 5
route: /projects
---

# Projects Hub

A portfolio command center for resuming active work, reviewing recent outcomes, and understanding progress and health across multi-task initiatives.

## Purpose

Group related tasks into projects, track progress across them, and get a birds-eye view of what's on track vs. at risk. Projects span across source systems — a single project can include Microsoft Todo tasks, GitHub issues, and locally-created items.

## Layout

### Portfolio View (`/projects`)

```
┌─────────────────────────────────────────────────────────────┐
│  Actions: Import Plan | Ideate | New Project                 │
├─────────────────────────────────────────────────────────────┤
│  Active | Completed This Week | Progress | Needs Attention   │
├───────────────────────────────────┬─────────────────────────┤
│  Pick up where you left off       │  Portfolio Pulse        │
│  Recent project + next task cards │  Completion breakdown   │
├───────────────────────────────────┼─────────────────────────┤
│  Start with an outcome            │  Recent Wins            │
│  Blank | Ideate | Import          │  Completed work/project │
└───────────────────────────────────┴─────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

### Project Detail (`/projects/[id]`)

Individual project page with tasks, kanban, and progress details.

## Key Behaviors

### Portfolio Overview
- **Recent projects** — The three most recently active projects, each with its latest open task
- **Recent wins** — Recently completed tasks with their project context
- **Portfolio pulse** — Task completion and in-progress breakdown across visible projects
- **Launch actions** — Create a blank project, ideate in Graph, or import a project plan
- **Sidebar affordance** — A Show All Projects action expands the project navigator when it is collapsed
- **Health indicators** — On Track / At Risk / Behind (derived from progress + target date)
- **Hidden projects** — Review and restore hidden projects from the landing page

### Project Properties
- **Name** — Project title
- **Icon** — Emoji icon for quick recognition
- **Color** — Accent color for visual grouping
- **Category** — Organizational category (Development, Home, etc.)
- **Status** — Active / Completed / On Hold / Archived
- **Target date** — Optional deadline

### Progress Tracking
- Automatic calculation from task completion ratio
- Health status derived from progress vs. remaining time to target date
- At-risk detection: behind expected pace given remaining time

### Project Detail View
- Full task list scoped to the project
- Kanban board with project-specific columns
- Progress summary and health indicator

### Auto-Include Rules
- Rules can match tasks by tag, title text, source list, or connector
- A task is included when it matches any configured rule
- Tag matching ignores letter case and an optional leading `#`
- Saving a rule immediately adds existing matches; task creation, title/tag edits, and connector syncs evaluate changes
- Project Settings previews qualifying tasks and explains why each task matches
- Manually removing a matching task excludes it from future auto-includes until it is explicitly restored
- Project Settings lists excluded matches and allows them to be restored
- Rules are additive: removing a rule does not unlink tasks already assigned to the project

## Data Sources

- Hub projects table (local database)
- Tasks assigned to project via `projectId` field
- Progress calculated at query time from task statuses

## Related

- [Archive: Project/Epic/Portfolio Design](../archive/PROJECT-EPIC-PORTFOLIO-DESIGN.md)
- [Design: Wave Planning](../design/active/wave-planning.md)
