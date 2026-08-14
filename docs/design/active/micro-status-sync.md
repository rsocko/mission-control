---
title: "Micro-Status Source Sync"
status: implemented
created: 2026-07-10
last_reviewed: 2026-08-01
category: design
related:
  - "[Kanban Column Mapping](../proposed/kanban-column-mapping.md)"
  - "[Task Sync Integration](../../architecture/task-sync-integration.md)"
  - "[Connector Expansion Review](connector-expansion-review.md)"
mockups: []
---

# Micro-Status Source Sync Design

## Overview

Micro-statuses ("Waiting on someone", "Started but stuck", etc.) need bidirectional sync with source systems. Each source represents micro-statuses differently based on what it natively supports.

The core design was implemented by #623, with completion cleanup and per-connector
controls completed by #1896. Timestamp-aware conflict resolution remains tracked
separately in #1892.

## Strategy: Namespaced Tags/Labels

Micro-statuses are represented as **namespaced tags** in source systems using a `mc:` prefix:

| Source | Representation | Example |
|--------|---------------|---------|
| Microsoft Todo | Categories | `mc:waiting-on-someone` |
| GitHub Issues | Labels | `mc:waiting-on-someone` (color-coded) |
| Local | Native field | `microStatus` column directly |

### Why namespacing?
- **Distinguishable**: `mc:` prefix clearly separates Mission Control metadata from user-created tags/labels
- **Filterable**: Users can search/filter by prefix in source UIs
- **Non-destructive**: Adding `mc:` categories/labels doesn't interfere with existing workflows
- **Round-trippable**: On sync, MC can detect `mc:*` tags and convert back to micro-status

## Connector Capability

Add `microStatusSync` to `ConnectorCapabilities`:

```typescript
interface ConnectorCapabilities {
  // ... existing
  microStatusSync?: boolean;      // Can represent micro-statuses
  microStatusWriteBack?: boolean; // Can write micro-status back to source
}
```

## Sync Behavior

### Outbound (MC → Source)
When user sets micro-status in MC:
1. Map to namespaced tag: `mc:waiting-on-someone`
2. Remove any previous `mc:*` tag from the task (only one micro-status active)
3. Add new `mc:*` tag via connector's tag write-back mechanism
4. Clearing micro-status removes all `mc:*` tags

### Inbound (Source → MC)
When sync pulls tasks:
1. Check tags/labels for `mc:*` prefix
2. Strip prefix, convert to micro-status key: `mc:waiting-on-someone` → `waiting_on_someone`
3. Set `microStatus` field on task
4. Keep the `mc:*` tag in the tags array as well (source provenance)

### Conflict Resolution
- **Last-write-wins**: If both MC and source changed micro-status since last sync, take the most recent
- **Clear on complete**: Completing a task clears micro-status in both MC and source

Timestamp-aware last-write-wins handling is tracked separately in #1892.

## Per-Connector Implementation

### Microsoft Todo
- **Mechanism**: `categories` array on the Graph API task object
- **Write**: PATCH task with updated `categories` (add `mc:status-slug`, remove previous `mc:*`)
- **Read**: Extract `mc:*` from `categories` during `mapGraphTask`
- **Limit**: No limit on categories. Strings only (no structure), which is perfect
- **Visibility**: Categories appear as colored pills in the Todo app

### GitHub Issues  
- **Mechanism**: Labels on the issue
- **Write**: POST/DELETE labels via REST API (add `mc:status-slug`, remove previous `mc:*`)
- **Read**: Extract `mc:*` from labels during `mapIssueToTask`
- **Setup**: Auto-create `mc:*` labels on first use with appropriate colors
- **Visibility**: Labels appear prominently on issues in GitHub UI
- **Note**: GitHub Projects custom "Status" fields are per-project, not per-repo, and require GraphQL ProjectV2 API. Labels are simpler and universal.

### Other Connectors
- **Local**: Direct `microStatus` column, no sync needed
- **Outlook/Calendar/etc**: `microStatusSync: false` — no representation available

## User Control

Per-connector setting in connector config:
```json
{
  "settings": {
    "syncMicroStatus": true  // default: false for new connectors
  }
}
```

User can toggle this in Settings → Connectors → [Connector] → "Sync status reasons to source"

New connectors persist this setting as disabled. Connectors created before the setting was
introduced retain the original enabled behavior until the user changes the toggle.

When disabled:
- Micro-status is MC-local only (stored in `microStatus` column)
- No `mc:*` tags are written to source
- Existing `mc:*` tags in source are still read on inbound (but not created)

## Label/Category Styling

Auto-created labels/categories use colors matching `MICRO_STATUS_CONFIG`:

| Micro-Status | Color | Label Text |
|-------------|-------|------------|
| waiting_on_someone | #f59e0b | mc:waiting-on-someone |
| need_to_think | #8b5cf6 | mc:need-to-think |
| started_but_stuck | #ef4444 | mc:started-but-stuck |
| ready_but_unmotivated | #64748b | mc:ready-but-unmotivated |
| done_needs_review | #06b6d4 | mc:done-needs-review |
| blocked_external | #dc2626 | mc:blocked-external |
| in_research | #3b82f6 | mc:in-research |
