---
title: "Document Intelligence Integration"
status: proposed
created: 2026-07-14
last_reviewed: 2026-07-14
category: design
related:
  - "[Triage Queue](design/TRIAGE-QUEUE-DESIGN.md)"
  - "[Insights Page](design/INSIGHTS-PAGE-DESIGN.md)"
  - "[Connector Expansion Review](design/CONNECTOR-EXPANSION-REVIEW.md)"
mockups:
  - "[mockup-doc-intelligence-hub.html](mockups/mockup-doc-intelligence-hub.html)"
  - "[mockup-doc-intelligence-gallery-cards.html](mockups/mockup-doc-intelligence-gallery-cards.html)"
---

# Document Intelligence — Mission Control Integration Design

## Summary

A full integration of the [DocIntelligence](http://hub.local:8200) service into Mission Control across three
surfaces: the **Action Queue** (tasks), the **Document Gallery** (Triage-style browse), and an **Insights** tab
(missing statements, unmatched EOBs, module health). The design fits entirely within the existing connector
framework and Triage framework — no bespoke `if source === 'document-intelligence'` logic.

---

## Current State

The connector exists at `src/lib/connectors/document-intelligence/index.ts` but is incomplete:

| Feature | Status | Issue |
|---------|--------|-------|
| `pay`, `respond`, `sign`, `schedule` actions → Tasks | ✅ Done | — |
| `file`, `review` actions → Tasks | ❌ Missing | Silently dropped |
| Missing statements → Alerts | ✅ Done | — |
| Unmatched EOBs → Alerts | ✅ Done | — |
| Document preview | ❌ Missing | No `previewUrl` in metadata |
| DocIntelligence Hub page | ❌ Missing | — |
| Gallery/Triage integration | ❌ Missing | — |

---

## DocIntelligence API Surface

The connector communicates with the DocIntelligence service:

| Endpoint | Module | Used for |
|----------|--------|----------|
| `GET /api/action-queue/actions?status=pending` | actionQueue | Fetch pending actions → Tasks |
| `PATCH /api/action-queue/actions/:id` | actionQueue | Complete / dismiss an action |
| `GET /api/statements/missing` | statements | Missing statement alerts |
| `GET /api/eob/unmatched` | eobMatching | Unmatched EOB alerts |
| `GET /api/documents` *(planned)* | documents | Browse document corpus |
| `GET /api/documents/:id` *(planned)* | documents | Document detail + thumbnail URL |
| `GET /api/stats` *(planned)* | all | Processing stats for Insights tab |

---

## Design Decisions

### 1. Action Queue → All Six Action Types Become Tasks

All action types (`pay`, `respond`, `sign`, `schedule`, `file`, `review`) become `TaskItem`s. Tags
differentiate them — the user uses tag filters to manage the queue. This is consistent with the
"source-aware, not source-bound" design principle.

`file` and `review` were previously dropped from `TASK_ACTION_TYPES`. They should be added:

```typescript
const TASK_ACTION_TYPES = new Set<DocAction['action_type']>([
  'pay', 'respond', 'sign', 'schedule', 'file', 'review',  // all six
]);
```

Title builders for the new types:
- `file` → `"File: [document_title]"`
- `review` → `"Review: [document_title]"`

### 2. Document Preview — Generic `metadata.previewUrl` Contract

Rather than source-checking in the task detail panel, a generic preview contract in `TaskItem.metadata`:

```typescript
// Populated by any connector that has a previewable document
metadata.previewUrl     // URL to open or embed (Paperless deep-link)
metadata.previewType    // 'pdf' | 'iframe' | 'external' | 'image'
metadata.previewLabel   // button label, e.g. "View in Paperless"
```

The `TaskDetailPanel` renders a document preview section for **any task** with `metadata.previewUrl` set.
Any future connector can use this without code changes to the UI.

The DocIntelligence connector prefers OWL-provided `preview_url` or `thumbnail_url`.
When neither is present, it derives Paperless's inline PDF preview endpoint from
`action.document_url`, while retaining the original URL for the open-document action:

```typescript
metadata: {
  // ... existing fields
  documentUrl: action.document_url,
  previewUrl: action.preview_url ?? action.thumbnail_url ?? paperlessPreviewUrl,
  previewType: action.preview_type ?? inferredPreviewType,
  previewLabel: 'View in Paperless',
}
```

### 3. Statement & EOB Alerts — Level Rules

Alert level determines how prominently users see notifications in Mission Control.
All connectors now use `NotificationLevel` values directly:

| NotificationLevel | Visual treatment |
|-------------------|------------------|
| `urgent`          | Red badge, top of list |
| `action_needed`   | Orange, prominent |
| `heads_up`        | Yellow, standard |
| `fyi`             | Gray, quiet |
| `digest`          | Collapsed/grouped |

#### Missing Statement Level

Graduated by `days_overdue`. Configured in `mapStatementOverdueSeverity()` in
`src/lib/connectors/document-intelligence/document-parser.ts`.

| Days overdue | Level           | Rationale |
|--------------|-----------------|-----------|
| < 7          | `fyi`           | Within normal processing window |
| 7 -- 13      | `heads_up`      | Late but not yet alarming |
| 14 -- 29     | `action_needed` | Significantly overdue, needs attention |
| 30+          | `urgent`        | A full billing cycle missed |

#### Unmatched EOB Level

Graduated by patient responsibility amount and total claim amount. Configured in
`mapEobSeverity()` in `src/lib/connectors/document-intelligence/document-parser.ts`.

| Condition                                       | Level           | Rationale |
|-------------------------------------------------|-----------------|-----------|
| Responsibility < $100 AND total < $500          | `fyi`           | Small amount, low urgency |
| Responsibility $100 -- $199                     | `heads_up`      | Moderate out-of-pocket |
| Responsibility $200 -- $499 OR total $500 -- $999 | `action_needed` | Significant financial exposure |
| Responsibility >= $500 OR total >= $1,000       | `urgent`        | Large balance requiring action |

> **Future enhancement:** These thresholds are currently hardcoded. A planned improvement
> would allow users to configure them per-connector through the connector settings UI,
> stored in the connector's `settings` JSON. This would let users adjust thresholds to
> match their personal financial context (e.g., someone with high medical costs might
> raise the EOB thresholds).

#### Rich Card Treatment

Notification cards for DI alerts show:

- **Missing Statements**: correspondent name, expected period, days-overdue progress bar,
  color-coded by severity tier
- **Unmatched EOBs**: provider, service date, patient responsibility amount badge,
  link to EOB document in Paperless

Implementation: alert card renderer reads `connectorType` and `category` to apply a richer layout.
This is acceptable `connectorType` checking because it's a *visual formatting decision* in a renderer,
not business logic. Pattern already exists for the finance connector.

### 4. Triage Integration — `document` Content Type

Rather than building a separate bespoke page, extend the existing Triage framework:

**Type additions** (`src/types/index.ts`):

```typescript
export type TriageContentType =
  | 'link' | 'image' | 'video' | 'text_post' | 'repo' | 'model_3d' | 'article' | 'product'
  | 'document';   // NEW

export type TriageSourcePlatform =
  | 'reddit' | 'youtube' | 'instagram' | 'github' | 'ios_share' | 'browser_extension' | 'web'
  | 'document-intelligence';   // NEW

export type TriageActionType =
  | 'save_karakeep' | 'create_task_github' | 'create_task_todo' | 'save_model_catalog'
  | 'trigger_workflow' | 'dismiss' | 'snooze'
  | 'complete_action' | 'open_document' | 'defer_action';   // NEW
```

**Gallery card renderer** (`TriageGalleryView.tsx`): Add a `document` branch in `GalleryCard` parallel
to the existing `repo` and `text_post` branches. The card shows:

- Line-art background simulating a document (no real thumbnail needed)
- Source badge: `📄 Docs` (registered in `SOURCE_META`)
- Action type chip: `PAY` / `REVIEW` / `SIGN` / `FILE` / `RESPOND` / `SCHEDULE`
- Priority dot (top-right of thumb)
- Correspondent name + amount (or page count for non-financial)

**Connector bridge**: Add an optional `fetchTriageItems?(): Promise<TriageItem[]>` method to `IConnector`.
DocIntelligence implements it to convert action queue items into `TriageItem` shape. Sync layer calls
this when present. Zero impact on other connectors.

### 5. DocIntelligence Hub Page — New Route `/doc-intelligence`

A dedicated page (analogous to `/triage`) with three tabs:

| Tab | Content |
|-----|---------|
| **Action Queue** | Three-column layout: filter chips + task list + task detail with document preview |
| **Documents** | Gallery view of all documents in the Paperless corpus, filtered by type (Invoice, EOB, Statement, Contract) with action badge overlays |
| **Insights** | Stats cards (pending actions, docs processed, missing statements, unmatched EOBs), alert cards for statements/EOBs, module health indicators |

The hub page reuses:
- Existing task row components (no new task list code)
- Alert card patterns from the main alerts panel
- The generic `metadata.previewUrl` preview in TaskDetailPanel
- The document gallery card from the Triage gallery (same component, different props)

---

## Implementation Roadmap

### Phase 1 — Connector completeness (1–2 days)

- [ ] Add `file` and `review` to `TASK_ACTION_TYPES`
- [ ] Add title builders for `file` and `review`
- [ ] Populate `metadata.previewUrl`, `metadata.previewType`, `metadata.previewLabel` on all task items
- [ ] Add `metadata.previewUrl` and `metadata.previewLabel` to EOB alert items (links to document)
- [ ] Update `testConnection()` to test all enabled modules independently and report per-module health

### Phase 2 — Generic preview in task detail (1 day)

- [ ] Extend `TaskDetailPanel` to render a document preview section when `metadata.previewUrl` is set
  - `external`: render a styled "Open in [previewLabel]" button + document metadata
  - `pdf` (future): render a minimal iframe embed with page thumbnails (like the mockup)
- [ ] This is framework-generic — benefits any connector that provides a `previewUrl`

### Phase 3 — DocIntelligence Hub page (2–3 days)

- [ ] Create `/doc-intelligence` route and page layout with tab navigation
- [ ] Action Queue tab: task list filtered to `connectorType === 'document-intelligence'` + detail pane
- [ ] Documents tab: gallery grid calling `GET /api/documents` (when DocIntelligence exposes this endpoint)
- [ ] Insights tab: stats cards + statement/EOB alert lists + module health grid
- [ ] Add sidebar nav item: "Doc Intelligence" with pending count badge

### Phase 4 — Triage integration (1–2 days)

- [ ] Add `'document'` to `TriageContentType`
- [ ] Add `'document-intelligence'` to `TriageSourcePlatform`
- [ ] Add new action types to `TriageActionType`
- [ ] Register `document-intelligence` in `SOURCE_META` in both `TriageGalleryView.tsx` and `triage/page.tsx`
- [ ] Add `document` branch to `GalleryCard` in `TriageGalleryView.tsx`
- [ ] Add `fetchTriageItems?()` to `IConnector` interface (optional)
- [ ] Implement `fetchTriageItems()` in `DocumentIntelligenceConnector`
- [ ] Update sync layer to call `fetchTriageItems()` when implemented

### Phase 5 — Rich alert cards (0.5 days)

- [ ] Enhanced alert card renderer for `connectorType === 'document-intelligence'`
  - Statement cards: overdue progress bar, correspondent name, period
  - EOB cards: provider, amount, service date, patient responsibility
  - Open-in-Paperless button on both types

---

## Framework Compliance

| Requirement | Solution |
|-------------|----------|
| No `if source === 'document-intelligence'` in business logic | Generic `metadata.previewUrl` contract; `contentType === 'document'` in renderer |
| Works within connector framework | All data flows through `fetchTasks()` / `fetchAlerts()` / optional `fetchTriageItems()` |
| Works within Triage framework | Extend types + add one new `case` in GalleryCard |
| No new schema changes | `rawMetadata` on TriageItem and `metadata` on TaskItem/AlertItem already exist as JSON blobs |
| Consistent visual language | Follows existing card patterns; uses design tokens from `DESIGN.md` |

---

## Mockups

- [`mockup-doc-intelligence-hub.html`](mockups/mockup-doc-intelligence-hub.html) — Full hub page with Action Queue, Documents gallery, and Insights tabs. Shows the three-panel Action Queue view with embedded document preview, rich alert cards in Insights tab, and the document gallery view.

- [`mockup-doc-intelligence-gallery-cards.html`](mockups/mockup-doc-intelligence-gallery-cards.html) — Document cards in the Triage Gallery view. Shows all six action types as gallery cards, demonstrates the mixed view (doc cards alongside Reddit/GitHub/YouTube cards), and includes a full implementation spec table.
