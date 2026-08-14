---
title: "Smart Auto-Routing — Automatically File Items to the Right Destination"
status: proposed
created: 2025-07-25
last_reviewed: 2025-07-25
category: design
origin: "Issue #17 — Smart way to take audio, to-do, an auto classify categorize, and file them in the right place"
related:
  - "[Triage Queue](triage-queue.md)"
  - "[Triage Enhancements](triage-enhancements.md)"
  - "[PR 895 — Quick Sort Mode](https://github.com/rsocko/mission-control/pull/895)"
---

# Smart Auto-Routing — Automatically File Items to the Right Destination

## Summary

Extend the triage pipeline with **auto-routing rules** that automatically send
captured items to the correct destination (task list, Karakeep bookmark, Model
Catalog, GitHub issue, knowledge base) based on content type, source, keywords,
and learned user behavior — eliminating the manual "where does this go?" decision.

---

## Problem Statement

Today, when an item enters triage, the user must manually decide its destination
using the Decision Panel actions (Create Task, Send to Karakeep, Save to Model
Catalog, etc.). PR 895's Triage Mode helps with *metadata* (priority, effort, tags)
but the user still makes the *routing* decision for every item.

For power users processing 20–50+ items per day, this is the remaining bottleneck:
the system knows enough about each item (source, content type, keywords, SmartScore)
to route most items automatically — or at least suggest a destination with high
confidence.

---

## User Stories

| # | As a…       | I want to…                                              | So that…                                             |
|---|-------------|----------------------------------------------------------|------------------------------------------------------|
| 1 | Power user  | Define rules like "GitHub Stars → Karakeep automatically" | I don't manually route predictable items              |
| 2 | Power user  | See auto-routed items in a "Recently Auto-Filed" feed    | I can spot and correct mistakes                       |
| 3 | Power user  | Have the system learn from my routing patterns            | Suggestions improve over time                         |
| 4 | Power user  | Override any auto-routing decision easily                 | I stay in control                                     |
| 5 | Power user  | Set confidence thresholds for auto-routing                | Low-confidence items still come to me for review       |

---

## Proposed Design

### Rule System

Auto-routing rules are evaluated in priority order when an item enters (or is
re-classified in) the triage queue.

```
┌───────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Item enters   │────▶│ Evaluate routing  │────▶│ Confidence ≥    │──▶ Auto-route
│ triage queue  │     │ rules (ordered)   │     │ threshold?      │
└───────────────┘     └──────────────────┘     └────────┬────────┘
                                                        │ No
                                                        ▼
                                               ┌─────────────────┐
                                               │ Show suggestion  │
                                               │ in triage card   │
                                               └─────────────────┘
```

### Rule Definition

Each rule consists of:

| Field          | Description                                              | Example                                |
|----------------|----------------------------------------------------------|----------------------------------------|
| **Name**       | Human label                                              | "GitHub Stars → Karakeep"              |
| **Conditions** | Match criteria (AND logic)                               | `source = github-stars`                |
| **Destination**| Where to send the item                                   | `karakeep`                             |
| **Confidence** | Minimum confidence to auto-route (0–100)                 | `80`                                   |
| **Enabled**    | Toggle                                                   | `true`                                 |

**Condition types:**
- Source platform (`github-stars`, `reddit`, `instagram`, etc.)
- Content type (`link`, `image`, `video`, `article`, `3d-model`)
- Keyword match (title/body contains)
- Tag match (has specific tag)
- SmartScore range (e.g., priority suggestion ≥ P1)

### Destinations

Leverage existing triage actions:
- **Task list** — create a task (specific list optional)
- **Karakeep** — bookmark via Karakeep action
- **Model Catalog** — save to 3D model catalog
- **GitHub Issue** — create issue in a configured repo
- **Knowledge Base** — save to knowledge base
- **Dismiss** — auto-archive low-value items

### Confidence & Learning

- **Initial version:** Rule-based only (deterministic, no ML).
- **Future:** Track user routing decisions to build per-source/per-content-type
  routing histograms. When a source+content-type combination has been routed to
  the same destination ≥ 5 times, suggest creating an auto-routing rule.

### Settings UI

Add a new section to Settings → Triage:

- **Auto-Routing Rules** table with add/edit/delete/reorder.
- **Confidence threshold** slider (global default, overridable per rule).
- **Recently Auto-Filed** log with undo capability.

---

## Integration with Triage Mode (PR 895)

Triage Mode focuses on *metadata* assignment (priority, effort, tags).
Auto-routing focuses on *destination* assignment. They are complementary:

1. An item can be auto-routed AND still appear in Triage Mode queues if metadata is missing.
2. Auto-routing runs first (at capture time); Triage Mode runs later (user-initiated batch).
3. If an item is auto-routed to "Create Task," Triage Mode can still prompt for priority/effort.

---

## Technical Considerations

- Store rules in a new `auto_routing_rules` table (or extend triage settings JSON).
- Evaluate rules in the existing `POST /api/triage/capture` and auto-sync pipelines.
- Add an `auto_routed` boolean + `routed_by_rule` foreign key to triage items for audit trail.
- "Recently Auto-Filed" is a filtered view of triage items where `auto_routed = true`.

---

## Out of Scope (for initial version)

- ML-based routing (learn from user behavior automatically).
- Multi-destination routing (send one item to multiple places).
- Time-based rules (e.g., "after 7 days unprocessed, auto-dismiss").

---

## Success Metrics

- % of triage items auto-routed (target: 40–60% for active users).
- Auto-routing accuracy (% of auto-routed items NOT manually overridden).
- Reduction in average triage processing time per item.
