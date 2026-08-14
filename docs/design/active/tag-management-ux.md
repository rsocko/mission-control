# Tag Management UX — Design Document

**Status:** Active  
**Issue:** #1694  
**Priority:** High  

## Problem Statement

Tags (labels) in Mission Control are sourced from multiple connectors (GitHub Issues, Microsoft Todo, local) and can proliferate without governance. Users need a way to:

1. **Audit** — See all tags, their origin, and which tasks use them
2. **Clean up** — Merge duplicates, rename, remove unused, or change colors
3. **Protect system tags** — `mc:*` (micro-status), `priority:*`, and `effort:*` labels are system-managed and should not be freely deleted
4. **Maintain sync integrity** — Changes must respect each connector's `tagWriteBack` and `tagCreationMode` capabilities

## Bug Fixes (Shipped)

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Tag write-back silently no-ops for GitHub | `GitHubIssuesConnector` declared `tagWriteBack: true` but never implemented `addTagToTask` / `removeTagFromTask` | Implemented all three methods (`addTagToTask`, `addTagsToTask`, `removeTagFromTask`) |
| Quick Add creates ad-hoc labels on GitHub repos | `POST /api/tasks` `tagSlugs` resolution ignores `tagCreationMode: 'predefined'` | Now checks capabilities and only accepts pre-existing tags for predefined connectors |
| Tags not included on issue creation | `writeThroughCreate` never passed tags to `connector.createTask()` | Now resolves source-type tag names and includes them in the create payload |

## Tag Classification

| Category | Pattern | System Managed | User Removable | Examples |
|----------|---------|:-:|:-:|---------|
| Micro-status | `mc:*` | ✅ | ❌ | `mc:blocked`, `mc:waiting` |
| Priority | `priority:*`, `P0`–`P3` | ✅ | ❌ | `priority:high`, `P1` |
| Effort | `effort:*`, `size:*` | ✅ | ❌ | `effort:3`, `size/m` |
| Source (user) | Anything else from a connector | ❌ | ✅ | `bug`, `enhancement`, `frontend` |
| Hub (local) | Created in MC, not synced | ❌ | ✅ | `quick-win`, `review-needed` |

## UX Design

### Relationship to Existing Settings → Tags

The Tag Review panel **replaces** the existing `TagsSection` in Settings. The current Tags tab offers a subset of what Tag Review provides (list, filter, delete, push-to-source). Rather than maintaining two surfaces:

- Settings → Tags becomes the Tag Review panel (embedded, not a modal when launched from Settings)
- Other entry points (context menu, command palette) open it as a modal/slide-over scoped to the relevant source

This avoids user confusion about "where do I manage tags?" — it's always one place, reachable from multiple entry points.

### Entry Points

1. **Settings → Tags tab** — Replaced by full Tag Review (embedded inline)
2. **Source List context menu** — "Review Tags" scoped to that list (e.g., one GitHub repo)
3. **Command Palette** — `Tag Review` / `Clean Up Tags`
4. **Kanban column header** — When grouped by tag, overflow menu → "Manage Tags"

### Tag Review Panel (Full-page modal or slide-over)

#### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Tag Review                                               [× Close]  │
├────────────────────┬────────────────────────────────────────────────┤
│ Scope              │  ┌──────────────────────────────────────────┐  │
│ ○ All Sources      │  │ 🔍 Filter tags...          Sort: Usage ▾ │  │
│ ● GitHub Issues    │  ├──────────────────────────────────────────┤  │
│   └ owner/repo-1   │  │ ◉ bug           24 tasks    🔴  [⋯]    │  │
│   └ owner/repo-2   │  │ ◉ enhancement   18 tasks    🟢  [⋯]    │  │
│ ○ Microsoft Todo   │  │ ◉ frontend       9 tasks    🔵  [⋯]    │  │
│ ○ Local Only       │  │ ◉ wontfix        3 tasks    ⚫  [⋯]    │  │
│                    │  │ ◉ won't fix      1 task     ⚫  [⋯]    │  │
│ ────────────────── │  │   └ 💡 Merge suggestion: → "wontfix"    │  │
│ System Tags        │  │ ◉ docs           5 tasks    🟣  [⋯]    │  │
│ (view-only)        │  │                                          │  │
│  mc:blocked     3  │  │ ── System (read-only) ──────────────     │  │
│  mc:waiting     2  │  │ 🔒 priority:high    12 tasks             │  │
│  priority:high 12  │  │ 🔒 mc:blocked        3 tasks             │  │
│  effort:3       8  │  └──────────────────────────────────────────┘  │
│                    │                                                  │
├────────────────────┴────────────────────────────────────────────────┤
│ Actions:  [Merge Selected]  [Bulk Remove]  [Export CSV]             │
└─────────────────────────────────────────────────────────────────────┘
```

#### Tag Actions (⋯ menu)

| Action | Description | Constraints |
|--------|-------------|-------------|
| **Merge** | Combine 2+ tags into one. Re-assigns all tasks. Optionally deletes source labels. | Cannot merge into system tags |
| **Rename** | Change display name (and slug). Syncs rename to source if `tagWriteBack`. | Cannot rename system tags |
| **Recolor** | Change color. Syncs to source if supported. | Any tag |
| **Remove** | Delete tag + unlink from all tasks. Optionally remove from source. | Cannot remove system tags |
| **View Tasks** | Opens filtered task list showing all tasks with this tag | Any tag |

#### Merge Flow

1. User selects 2+ tags (checkboxes)
2. Clicks "Merge Selected"
3. Dialog: "Merge into:" [dropdown of selected tags or type new name]
4. Confirm → re-assigns all tasks to target tag → deletes old tags
5. If source supports write-back: optionally remove old labels, add new label on source

#### Cross-Source Merge vs Unify

Tags with the same concept may exist independently on different sources (e.g., `bug` on GitHub repo A, `Bug` on Microsoft Todo, `type:bug` on repo B). The merge dialog offers two modes:

| Mode | What happens | When to use |
|------|-------------|-------------|
| **Unify (link)** | Creates a single MC "hub tag" that maps to the distinct source labels. Tasks from all sources show under one tag in MC, but source labels remain untouched. | User wants a unified view but sources have their own naming conventions |
| **Merge (normalize)** | Renames/replaces the source labels so all sources use the same name. Applies write-back where supported. | User wants true consistency across all sources |

The merge dialog should surface this choice when selected tags span multiple sources:

> "These tags exist on different sources. Would you like to **unify** them in Mission Control (keep source labels as-is) or **merge and rename** on each source?"

Users may intentionally keep `bug` distinct per repo (e.g., different workflows). The default should be **Unify** (non-destructive) with Merge as the opt-in.

#### Smart Suggestions (Phase 2)

- **Cross-source duplicates** — Same slug or Levenshtein distance ≤ 2 across different sources
- **Within-source duplicates** — Case-insensitive match, slug collision within one source
- **Unused tags** — Tags with 0 task assignments
- **Low-usage outliers** — Tags used ≤ 1 time (likely typos)
- **Prefix normalization** — `bug` vs `type:bug` vs `type/bug`

Suggestions are presented non-destructively — user always confirms before any action.

### API Endpoints (New)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tags/review?scope=all&sourceListId=…` | List tags with usage counts, merge suggestions |
| POST | `/api/tags/merge` | Merge tags: `{ sourceIds: [...], targetId, deleteFromSource? }` |
| PATCH | `/api/tags/:id` | Rename/recolor a tag |
| DELETE | `/api/tags/:id?removeFromSource=true` | Remove tag (existing, but enhanced with source sync) |
| GET | `/api/tags/suggestions` | AI-powered merge/cleanup suggestions |

### Permissions & Safety

- System tags (`mc:*`, `priority:*`, `effort:*`) are **always visible but never editable/removable** in the UI
- Merge/remove confirm dialogs show task count impact: "This will affect 24 tasks"
- Source write-back is **opt-in per action** (checkbox: "Also remove label from GitHub?")
- Bulk operations are rate-limited to avoid GitHub API throttling
- All operations are logged to the sync audit trail

### Connector Interaction Matrix

| Connector | Tag Write-Back | Create New Tags | Rename | Recolor | Remove |
|-----------|:-:|:-:|:-:|:-:|:-:|
| GitHub Issues | ✅ | ✅ (creates label) | ❌ (GitHub has no rename API) | ✅ (PATCH label) | ✅ (DELETE label) |
| Microsoft Todo | ✅ | ✅ (freeform categories) | ✅ | ❌ | ✅ |
| Local | N/A | ✅ | ✅ | ✅ | ✅ |

> **Note:** GitHub label "rename" requires create-new + migrate + delete-old (same pattern as `normalizeLabels` in `label-handler.ts`).

## Implementation Phases

### Phase 1 (This PR)
- [x] Fix tag write-back bugs (GitHub connector)
- [x] Enforce `tagCreationMode: 'predefined'` in task creation
- [x] Pass tags through write-through create
- [ ] Design document + HTML mockup

### Phase 2 — Tag Review UI
- Tag Review panel (full page modal)
- Scope filtering (all / source / list)
- System tag protection (read-only section)
- Merge, Rename, Recolor, Remove actions
- Source write-back for remove/recolor

### Phase 3 — Smart Suggestions
- Duplicate/near-match detection
- Unused tag identification
- AI-powered cleanup recommendations
- Batch operations with progress indicator
