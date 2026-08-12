---
title: Goals & Ideas
sidebar_label: Goals & Ideas
sidebar_position: 6
route: /goals
---

# Goals & Ideas

A tag-based smart view for capturing and developing aspirations, ideas, and brainstorms.

## Purpose

Not everything is a task. Goals, ideas, and brainstorms need a place to live and grow before they become actionable projects. This view provides a low-friction capture space with AI-powered "Develop" to turn vague ideas into concrete plans.

## Layout

```
┌──────────────┬──────────────────────────────────────────────┐
│  Sidebar     │  Filter Chips: All | Goals | Ideas | Brainstorm│
│              ├──────────────────────────────────────────────┤
│  Counts      │                                               │
│  - Goals: 5  │  Goal/Idea Cards                              │
│  - Ideas: 12 │  ┌─────────────────────────────────────────┐ │
│  - Brain: 3  │  │  #goal  Build home automation system    │ │
│              │  │  Created 3d ago · Project: Home          │ │
│  Project     │  │  [Develop] [Promote] [Edit]             │ │
│  Filter      │  └─────────────────────────────────────────┘ │
│              │                                               │
│              │  Develop Panel (when active)                   │
│              │  ┌─────────────────────────────────────────┐ │
│              │  │  AI-generated proposal with:             │ │
│              │  │  - Suggested tasks                       │ │
│              │  │  - Project structure                     │ │
│              │  │  - Timeline estimate                     │ │
│              │  │  [Accept] [Modify] [Cancel]             │ │
│              │  └─────────────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────────────┘
```

## Key Behaviors

### Item Types
- **Goal** (`#goal`) — A defined outcome you want to achieve
- **Idea** (`#idea`) — A concept worth exploring further
- **Brainstorm** (`#brainstorm`) — Raw thought, no commitment

### Filtering
- Filter chips: All, Goals, Ideas, Brainstorms
- Project filter: Scope to items within a specific project
- Counts update dynamically per filter

### Quick Capture
- Context-aware quick-add bar when on this page
- Automatically tags with the active filter type
- Placeholder text adjusts per filter ("Add a new goal..." / "Capture a new idea...")

### AI Develop Feature
- Click "Develop" on any item to invoke AI analysis
- AI generates a `DevelopProposal` with:
  - Suggested project structure
  - Breakdown into concrete tasks
  - Timeline and effort estimates
  - Dependencies and prerequisites
- Accept to create tasks/project, or modify the proposal

### Promote to Project
- One-click promotion from goal/idea to a full hub project
- Pre-fills project properties from the item context

## Data Sources

- Tasks with `#goal`, `#idea`, or `#brainstorm` tags from any connected source
- No separate schema entity — leverages existing task + tags system
- AI engine for Develop feature

## Related

- [Product: Goals & Ideas Smart View](../PRODUCT.md) (roadmap section)
- [Design: Goal Promotion](../design/proposed/goal-promotion.md)
