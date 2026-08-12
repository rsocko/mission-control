---
title: Triage
sidebar_label: Triage
sidebar_position: 3
route: /triage
---

# Triage Queue

A review and routing inbox for content captured from various sources that hasn't been processed yet.

## Purpose

Content flows in from GitHub Stars, Reddit saves, YouTube Watch Later, browser captures, iOS Shortcuts, and intelligent agents such as Scout. Triage is where you decide what to do with it: create zero, one, or multiple tasks, save it as a bookmark, route it to another destination, snooze it, or dismiss it.

Triage is distinct from the task **Inbox** quick view. Inbox contains records
that are already tasks and need clarification, placement, or metadata review.
Triage contains source material that may never become a task or may produce
multiple tasks.

## Layout

```
┌──────────────┬──────────────────────────────────────────────┐
│  Filter      │  Quick Stats (pending, processed today)      │
│  Sidebar     ├──────────────────────────────────────────────┤
│              │  Stream / Gallery view                        │
│  - Sources   │                                               │
│  - Types     │  ┌─────────────────────────────────────────┐ │
│  - Status    │  │  Triage Item Card                       │ │
│  - Scores    │  │  Title, source, score, content type     │ │
│              │  │  Preview / thumbnail                     │ │
│              │  │  [Action buttons: Task, Bookmark, ...]  │ │
│              │  └─────────────────────────────────────────┘ │
│              │                                               │
│              │  AI Insights panel (batch recommendations)    │
└──────────────┴──────────────────────────────────────────────┘
```

## Key Behaviors

### View Modes
- **Stream** — Vertical list with inline previews (default)
- **Gallery** — Grid of cards with thumbnails (good for visual content)
- **Focus** — One item at a time, full-width decision interface
- **Density** — Configurable density (compact / comfortable / spacious)

### Filtering & Sorting
- **Source platform** — GitHub, Reddit, YouTube, iOS Shortcuts, Manual capture
- **Content type** — Configurable types (article, tool, video, repo, idea, etc.)
- **Status** — Pending, actioned, dismissed, snoozed
- **AI score** — Relevance/urgency score threshold
- **Sort** — By date captured, AI score, source, content type

### Actions (per item)
Each item can be routed via the Decision Panel:

| Action | Result |
|--------|--------|
| **Create Task(s)** | Extracts or opens task creation for one or more actions while retaining source provenance |
| **Bookmark** | Saves to bookmarks with tags |
| **Route to Project** | Assigns to a hub project for later |
| **Dismiss** | Marks as reviewed, removes from queue |
| **Snooze** | Hides for a configurable duration |

### Bulk Operations
- Multi-select mode for batch processing
- Bulk dismiss, bulk set content type, bulk route
- Bulk action bar with count indicator

### AI Features
- **Auto-Triage** — AI processes multiple items at once with suggested actions
- **AI Insights** — Pattern detection across pending items (e.g., "5 items are React libraries")
- **Smart scoring** — AI-ranked relevance based on your patterns
- **Strong suggestions** — High-confidence actions become explicit one-tap confirmations with an exact effect preview
- **Scoped autonomy** — Opt-in execution is limited to allowlisted, low-risk actions; completion, dismissal, and external effects require confirmation

### Manual Capture
- **Capture Form** — Add items directly to the triage queue
- **URL + notes** — Paste a URL with optional context

### Sync Status
- Shows last sync time per source
- Manual sync trigger per source

## Data Sources

- GitHub Stars API (via connector)
- Reddit saved posts (via connector)
- YouTube Watch Later (via connector)
- Scout content intake
- iOS Shortcuts webhook
- Browser extension captures
- Manual entries

## Related

- [Design: Triage Queue](../design/proposed/triage-queue.md)
- [Design: Scout Smart Connector](../design/proposed/scout-smart-connector.md)
- [Archive: Triage Notes](../archive/triage-notes.md)
- [Archive: Triage Queue Go-Forward](../archive/triage-queue-go-forward.md)
