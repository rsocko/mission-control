---
title: Kanban Board
sidebar_label: Kanban
sidebar_position: 4
route: /kanban
---

# Kanban Board

A visual drag-and-drop board for organizing tasks across customizable columns.

## Purpose

When you need spatial organization — seeing tasks flow through stages — the Kanban view provides a familiar board metaphor. Columns can map to statuses, custom workflows, or project-specific stages.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: Project selector, Source filter, Bulk mode              │
├─────────────────────────────────────────────────────────────────┤
│  Board Controls: Search, Swimlanes, Score sort, Columns editor  │
├────────────┬────────────┬────────────┬────────────┬─────────────┤
│  Column 1  │  Column 2  │  Column 3  │  Column 4  │  Column 5   │
│  (WIP: 3)  │            │  (WIP: 5)  │            │             │
│ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │             │
│ │ Task   │ │ │ Task   │ │ │ Task   │ │ │ Task   │ │             │
│ │ card   │ │ │ card   │ │ │ card   │ │ │ card   │ │             │
│ └────────┘ │ └────────┘ │ └────────┘ │ └────────┘ │             │
│ ┌────────┐ │            │ ┌────────┐ │            │             │
│ │ Task   │ │            │ │ Task   │ │            │             │
│ └────────┘ │            │ └────────┘ │            │             │
│  [+ Add]   │  [+ Add]   │  [+ Add]   │  [+ Add]   │  [+ Add]    │
└────────────┴────────────┴────────────┴────────────┴─────────────┘
```

## Key Behaviors

### Column Management
- **Default columns** — To Do, In Progress, Done (global defaults)
- **Custom columns** — Add, rename, reorder, remove columns
- **Per-project columns** — Each project can define its own column set
- **Global column mapping** — Project columns can map to global columns for cross-project consistency
- **WIP limits** — Optional maximum per column (visual warning when exceeded)
- **Collapse/Expand** — Collapse columns to save horizontal space

### Project Scoping
- **All tasks** — View all tasks across all projects on one board
- **Project-specific** — Select a project to see only its tasks with project-specific columns
- **URL param** — `?projectId=...` for deep-linking to a project board

### Drag & Drop
- Drag task cards between columns to update status
- Visual drag indicator showing source and target
- Optimistic update — card moves immediately, syncs in background

### Swimlanes
- **None** — Flat column layout (default)
- **By source** — Group cards within columns by connector
- **By priority** — Group cards by priority level
- **By project** — Group cards by hub project

### Card Display
- Task title, priority indicator, source badge
- Optional: due date, smart score
- Toggle source badges and due dates via Board Controls

### Search & Filter
- **Search** — Real-time text search across all visible cards
- **Source filter** — Show/hide tasks from specific connectors
- **Score sort** — Sort cards within columns by AI smart score

### Quick Add
- Per-column "+" button to add a task directly into that column
- Inline title input with Enter to confirm

### Bulk Operations
- Enter bulk mode from header
- Multi-select cards across columns
- Bulk move to column, set priority, delete

### Task Detail
- Click any card to open the task detail slide-over panel
- Edit all fields without leaving the board view

## Data Sources

- All connected task sources (filtered by project/source selection)
- Column configuration stored per-user and per-project
- Smart scores from AI engine

## Related

- [Design: Kanban Column Mapping](../design/proposed/kanban-column-mapping.md)
- [Archive: Kanban Backlog](../archive/kanban-backlog.md)
