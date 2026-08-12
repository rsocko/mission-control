---
title: "Field Sync Patterns"
status: active
created: 2026-07-25
last_reviewed: 2026-07-30
category: architecture
related:
  - "[Connectors](connectors.md)"
  - "[Sync Engine](sync-engine.md)"
---

# Field Sync Patterns — Design Guide for Connector Authors

> How Mission Control resolves field values during bidirectional sync, and the rules every connector must follow to avoid data loss.

---

## Core Principle: Don't Erase What You Can't Store

Mission Control often has **richer field semantics** than the source platform. For example:

- MC has 5 priority levels; MS Todo has 3 (`low` / `normal` / `high`)
- MC has effort 1–5; GitHub Issues has no native effort field
- MC has `microStatus` with 7+ variants; most sources have none

The sync engine must **never silently lose a locally-set value** when the source can't represent it.

---

## Field Resolution Rules

The pull-manager (`src/lib/sync/pull-manager.ts`) applies these rules when merging a remote update into an existing MC task:

### Rule 1: Explicit Remote Value Wins

If the source provides a **meaningful, non-empty** value for a field, it takes precedence over the local value.

```
Remote: priority = 'high'   →   MC stores 'high'  (overwrites local)
```

### Rule 2: "None" / Empty Never Overwrites

If the source returns `'none'`, `null`, `undefined`, or an equivalent "unset" value, the **local value is preserved**. A source saying "I don't have a value" is not the same as "the value should be cleared."

```
Remote: priority = 'none'   →   MC keeps existingTask.priority
Remote: priority = undefined →   MC keeps existingTask.priority
```

**Implementation** (pull-manager.ts):
```typescript
const remotePriorityIsExplicit = remote.priority && remote.priority !== 'none';
const resolvedPriority = remotePriorityIsExplicit
  ? remote.priority
  : (existingTask.priority || 'none');
```

### Rule 3: Capability-Gated Fields

Some fields are only meaningful if the connector declares support. The `dueDate` field uses this pattern:

```typescript
const connectorHasDueDate = caps?.dueDate === true;
const resolvedDueDate = connectorHasDueDate
  ? (remote.dueDate || null)        // Source is authoritative
  : (remote.dueDate || existingTask.dueDate || null);  // Preserve local
```

### Rule 4: Write-Back Before Pull

The sync pipeline runs **push before pull** (see sync-engine.md). This ensures that if a user changes a value in MC, the write-back has a chance to propagate to the source before the next pull re-reads it.

```
1. Push Manager → writes MC priority to source (e.g., adds GitHub label)
2. Pull Manager → reads source (now sees the label MC just wrote)
3. Resolution → remote matches local, no conflict
```

---

## Field-by-Field Reference

| Field | Stored In | Overwrite Behavior | Write-Back Support |
|-------|-----------|-------------------|-------------------|
| **title** | `tasks.title` | Always overwrites from remote | ✅ Push-manager sends to `updateTask()` |
| **description** | `tasks.description` | Always overwrites from remote | ✅ Push-manager sends to `updateTask()` |
| **status** | `tasks.status` | **Protected** — remote `'todo'` won't overwrite `'in_progress'`; `'done'`/`'cancelled'` always wins | ✅ Via `completeTask()` / `updateTask()` |
| **priority** | `tasks.priority` | **Protected** — only explicit non-`'none'` wins | ✅ GitHub: labels · MS Todo: importance |
| **effort** | `tasks.effort` | **Never overwritten** on update (only set on initial insert) | ✅ GitHub: labels · Others: local-only |
| **dueDate** | `tasks.dueDate` | Capability-gated (`caps.dueDate`) | ✅ If connector supports it |
| **microStatus** | `tasks.microStatus` | Overwrites if remote provides value | ✅ GitHub: `mc:*` labels · MS Todo: categories |
| **tags** | `task_tags` join table | Source-type tags replaced; hub/AI tags preserved | Varies by connector |
| **completedAt** | `tasks.completedAt` | Smart: remote wins if provided; else preserved if task still done | N/A (derived from status) |
| **assignee** | `tasks.assignee` | Overwrites from remote | ❌ Not implemented |

---

## Priority Mapping Per Connector

MC stores priority as one of: `none` | `low` | `medium` | `high` | `critical`

### Mapping Table

| MC Priority | GitHub Issues | MS Todo | Document Intelligence |
|-------------|--------------|---------|----------------------|
| `critical` | `priority:critical` label | `importance: high` ⚠️ | `urgency: critical` |
| `high` | `priority:high` label | `importance: high` | `urgency: high` |
| `medium` | `priority:medium` label | `importance: normal` ⚠️ | `urgency: medium` |
| `low` | `priority:low` label | `importance: low` | `urgency: low` |
| `none` | *(no label)* | `importance: normal` | *(no urgency)* |

⚠️ = Lossy mapping (multiple MC values collapse to one source value). The pull-manager's Rule 2 prevents this from causing data loss on round-trip.

### Round-Trip Safety Examples

**MS Todo — medium priority:**
1. User sets `priority: medium` in MC
2. Push: `priorityToImportance('medium')` → `'normal'` (MS Todo)
3. Pull: `importanceToPriority('normal')` → `'none'`
4. Resolution: `'none'` is not explicit → **local `'medium'` preserved** ✅

**GitHub — priority removed:**
1. MC has `priority: high` (from `priority:high` label)
2. Someone removes the label from GitHub
3. Pull: `inferPriority()` → `'none'` (no priority labels found)
4. Resolution: `'none'` is not explicit → **local `'high'` preserved** ✅

**GitHub — priority changed in MC:**
1. MC has `priority: high`, user changes to `critical`
2. Push: `syncPriorityLabels()` removes `priority:high`, adds `priority:critical` on GitHub
3. Pull: `inferPriority()` sees `priority:critical` → returns `'critical'`
4. Resolution: `'critical'` is explicit → **overwrites to `'critical'`** ✅ (matches)

**GitHub — status 'in_progress' preserved:**
1. User sets `status: in_progress` in MC (issue is still open on GitHub)
2. Pull: GitHub issue is `OPEN` → transformer returns `'todo'`
3. Resolution: remote `'todo'` would be a downgrade from `'in_progress'` → **local `'in_progress'` preserved** ✅

**GitHub — issue closed while 'in_progress':**
1. MC has `status: in_progress`, someone closes the issue on GitHub
2. Pull: GitHub issue is `CLOSED` → transformer returns `'done'`
3. Resolution: `'done'` is an explicit closure → **overwrites to `'done'`** ✅

---

## Effort Mapping Per Connector

MC stores effort as `number | null` (1–5 scale).

Effort is **only set on initial task insert** and is **never overwritten** by the pull-manager on subsequent syncs. This makes it safe for local-only editing.

For write-back, connectors that support label-based effort (GitHub Issues) use canonical `effort:1` through `effort:5` labels.

See [Connectors → Effort Level Mapping](connectors.md#effort-level-mapping) for the full mapping table.

---

## Tag Sync Safety

Tags in MC have a `type` field:

| Tag Type | Behavior on Sync | Owner |
|----------|-----------------|-------|
| `source` | **Deleted and re-created** on each pull — source of truth is the remote | Connector |
| `hub` | **Never touched** by sync — user-created organizational tags | User |
| `ai-inferred` | **Never touched** by sync — AI-generated tags | System |

The `upsertTaskTags()` function (pull-manager.ts) only deletes `source`-type tags before re-inserting the remote's current set. Hub and AI tags are always preserved.

---

## Label Normalization (GitHub Issues)

GitHub Issues uses labels for priority and effort, but repos may use inconsistent naming conventions (`P0`, `priority/high`, `size:large`, etc.). MC includes a **label normalization** system:

### Canonical Label Format

| Field | Labels | Colors |
|-------|--------|--------|
| Priority | `priority:critical`, `priority:high`, `priority:medium`, `priority:low` | Red → Yellow gradient |
| Effort | `effort:1` through `effort:5` | Green → Purple gradient |

### Normalization Flow

1. **Scan**: `GET /api/connectors/{id}/label-scan` detects non-canonical labels across all repos
2. **Review**: User selects which labels to normalize (settings UI or onboarding)
3. **Execute**: `POST /api/connectors/{id}/label-normalize` migrates issues to canonical labels
4. **Safety**: Old labels are only removed after canonical labels are confirmed added; repo-level label deletion only happens if all issues are migrated successfully

### Inbound Recognition

The inbound inference functions (`inferPriority`, `inferEffort` in `issue-transformer.ts`) recognize both canonical and common non-canonical patterns to ensure tasks sync correctly even before normalization.

---

## Checklist for New Connector Authors

When implementing a new connector, verify each field against these rules:

### Priority
- [ ] Map source priority levels to MC's `none | low | medium | high | critical`
- [ ] Return `'none'` (not `undefined`) when the source has no priority concept — the pull-manager will preserve local values
- [ ] If source has fewer levels than MC, document which MC values collapse (see Mapping Table above)
- [ ] If write-back is supported, declare `priority: true` and `priorityWriteBack: true` in capabilities
- [ ] Implement outbound mapping in `updateTask()` and `createTask()`

### Effort
- [ ] If source has an effort/size/story-points concept, implement `inferEffort()` in your transformer
- [ ] Return `number | undefined` — `undefined` leaves effort unset
- [ ] If write-back is supported, add effort sync to `updateTask()` and `createTask()`
- [ ] Effort is only set on initial insert; the pull-manager does not overwrite it

### Tags
- [ ] Map source labels/categories to MC tags with `type: 'source'`
- [ ] Source tags are replaced on each sync — this is expected behavior
- [ ] Do NOT include priority/effort labels as tags if they're already mapped to dedicated fields
- [ ] Declare `tagWriteBack: true` only if your connector can add/remove tags on the source

### Status
- [ ] Map source statuses to MC's `todo | in_progress | done | cancelled`
- [ ] Implement `completeTask()` for marking tasks done on the source
- [ ] If source has richer statuses, use `microStatus` for the detailed value

### Due Date
- [ ] If source supports due dates, declare `dueDate: true` in capabilities
- [ ] The pull-manager will treat the source as authoritative for due dates when declared
- [ ] If NOT declared, local due dates set in MC will be preserved across syncs

### General
- [ ] Run push before pull — the sync scheduler handles this automatically
- [ ] Never return `undefined` for a field you want to be authoritative — return the actual value or a sentinel
- [ ] Test round-trip scenarios: set value in MC → push → pull → verify value preserved
