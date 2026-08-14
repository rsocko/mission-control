---
title: "Mockup Design Review: mockup-doc-intelligence-hub.html"
status: reviewed
created: 2026-07-23
category: design
label: di-mc-integration
issue: "#713"
related:
  - "[DESIGN.md](../../../DESIGN.md)"
  - "[Mockup](../../mockups/mockup-doc-intelligence-hub.html)"
  - "[Integration Review](di-integration-review.md)"
---

# Mockup Review: `mockup-doc-intelligence-hub.html`

**Decision: ✅ Keep Action Queue tab; ❌ Remove Documents & Insights tabs**

The mockup's design system alignment is excellent — colors, typography, spacing, and components all match DESIGN.md. However, the 3-tab hub page structure has been revised based on product review. The Action Queue tab is the only tab that should ship as a dedicated `/doc-intelligence` page. Documents and Insights content should integrate into existing MC surfaces instead.

---

## Design Decision: Hub Page Scope Revision

After product review, the original 3-tab hub page has been **revised to a single-tab page** (Action Queue only). The other two tabs' concerns are addressed differently:

### What changed and why

| Original Tab | Decision | Rationale |
|-------------|----------|-----------|
| **Action Queue** | ✅ **Keep** as `/doc-intelligence` page | Document-centric view with previews, filters by action type — genuinely unique value |
| **Documents** | ❌ **Remove** | Replicates Paperless-ngx browser with little added value; high effort; use "Open in Paperless" links from task detail instead |
| **Insights** | ❌ **Remove** as standalone tab | Missing statements and unmatched EOBs flow into MC's existing **Notifications** page via `fetchAlerts()`. DI stats (actions pending, docs processed, etc.) integrate into the **Dashboard KPI section** and **Insights** page. Module health lives in **Settings → Connector** status. |

### Where DI content lives instead

| Content | MC Surface | How |
|---------|-----------|-----|
| DI actions (pay, sign, file, review, etc.) | **Dashboard, My Day, Projects, Kanban** | Already works — connector maps actions → TaskItems |
| DI actions with document context | **`/doc-intelligence` hub page** | Filtered task list + document-oriented detail pane |
| DI actions in task detail | **TaskDetailPanel** (everywhere) | Enhanced document preview section (PDF render, thumbnail, Paperless link) |
| Missing statement alerts | **Notifications** page | Via `fetchAlerts()` — already implemented |
| Unmatched EOB alerts | **Notifications** page | Via `fetchAlerts()` — already implemented |
| DI KPIs (actions pending, docs processed, missing statements) | **Dashboard KPI bar** | New KPI cards in `KPI_REGISTRY` (category: `integrations`) |
| DI stats (completion trends, module health) | **Insights** page | Integrated alongside other connector stats |
| Module health (action queue / statements / EOB status) | **Settings → Connectors** | Connector status section |
| Document browsing | **Paperless-ngx** (external) | "Open in Paperless" links from task details |

### Document-Oriented Task Detail

When a DI task is selected in **any** MC view (Dashboard, My Day, Kanban, etc.), the task detail panel should render a **document-oriented preview** rather than just an external link. This is inspired by the Triage system's `RichPreviewEmbed` pattern:

| Current (external link only) | Target (document-oriented) |
|------------------------------|---------------------------|
| Simple "Open Document" link | PDF thumbnail / rendered preview |
| No visual document context | Page thumbnails with page count |
| Metadata as plain text | Structured KV grid (correspondent, amount, due date) |
| — | "Open in Paperless" button in preview header |
| — | Action buttons (Mark Complete, Schedule, Dismiss) |

**Implementation approach**: Extend the existing `TaskDetailPanel` document preview section (currently lines 988–1016) to detect `connectorType === 'document-intelligence'` and render a richer preview. Use patterns from `RichPreviewEmbed` (thumbnail with aspect ratio handling, click-to-expand, platform-specific rendering) as architectural inspiration — shared utilities where possible rather than duplicating logic.

### New Dashboard KPIs

The following KPI cards should be added to `KPI_REGISTRY` for the Dashboard KPI bar:

| Slug | Label | Type | Accent | Source |
|------|-------|------|--------|--------|
| `doc-actions-pending` | Doc Actions | `counter` | `indigo` | Count of pending DI tasks |
| `doc-statements-missing` | Missing Stmts | `counter` | `purple` | Count of missing statement alerts |
| `doc-eob-unmatched` | Unmatched EOBs | `counter` | `pink` | Count of unmatched EOB alerts |

These use the `integrations` category and can be added to the "Operations" KPI preset.

---

## Review Summary

| Category | Status | Notes |
|----------|--------|-------|
| Color tokens | ✅ Aligned | All CSS custom properties match DESIGN.md exactly |
| Typography | ⚠️ Minor issue | Imports Inter font but declares Geist Sans — functional but cleanup needed |
| Spacing & rounding | ✅ Aligned | Consistent with design system |
| Surface hierarchy | ✅ Aligned | Correct surface-0 → 1 → 2 → 3 layering |
| Semantic colors | ✅ Aligned | Success/warning/danger/info colors match |
| Navigation | ⚠️ Deviation | Mockup uses 220px vertical sidebar; MC uses horizontal top nav with overflow |
| Icons | ❌ Deviation | Font Awesome 6.5.0 used; DESIGN.md requires Lucide only |
| Tab layout | ⚠️ Revised | 3-tab → single-tab (Action Queue only); Documents & Insights removed |
| Transitions | ✅ Aligned | 100–150ms range, correct approach |
| Components | ✅ Aligned | Cards, pills, task rows follow design system patterns |

---

## Detailed Findings

### 1. ✅ Color Tokens — Fully Aligned

The mockup's CSS custom properties match DESIGN.md exactly:

| Token | Mockup | DESIGN.md | Match |
|-------|--------|-----------|-------|
| `--surface-0` | `#0b1120` | `#0b1120` | ✅ |
| `--surface-1` | `#111827` | `#111827` | ✅ |
| `--surface-2` | `#1e293b` | `#1e293b` | ✅ |
| `--surface-3` | `#334155` | `#334155` | ✅ |
| `--text-primary` | `#f8fafc` | `#f8fafc` | ✅ |
| `--text-secondary` | `#94a3b8` | `#94a3b8` | ✅ |
| `--text-tertiary` | `#64748b` | `#64748b` | ✅ |
| `--accent` | `#3b82f6` | `#3b82f6` | ✅ |
| `--accent-hover` | `#60a5fa` | `#60a5fa` | ✅ |
| `--accent-muted` | `#1e3a8a` | `#1e3a8a` | ✅ |
| `--success` | `#10b981` | `#10b981` | ✅ |
| `--warning` | `#f59e0b` | `#f59e0b` | ✅ |
| `--danger` | `#ef4444` | `#ef4444` | ✅ |
| `--info` | `#06b6d4` | `#06b6d4` | ✅ |
| `--border` | `#1e293b` | `#1e293b` | ✅ |
| `--border-strong` | `#334155` | `#334155` | ✅ |

### 2. ⚠️ Typography — Minor Cleanup Needed

- **Font declaration**: Body declares `font-family: 'Geist Sans', ...` ✅ (matches DESIGN.md)
- **Google Fonts import**: Imports `Inter` font (line 10), but never uses it — Geist Sans is the declared family
- **Font sizes**: Body 13–14px, labels 10–12px, headings 16–20px ✅
- **Font weights**: 400 body, 500 labels, 600 headings ✅
- **`font-variant-numeric: tabular-nums`**: Used on `.amount-badge` and `.stat-value` ✅
- **Letter spacing**: Section headers use `0.06–0.08em` ✅ (DESIGN.md says `0.01em` for labels)

**Fix needed**: Remove the unused Inter font import.

### 3. ⚠️ Navigation Pattern — Known Deviation

The mockup renders a **220px vertical sidebar** with section labels (Core, Integrations, System) and nav items with a 2px left accent indicator.

The actual MC app (`AppShell.tsx`) uses a **horizontal top nav** with:
- Primary items (Dashboard, My Day, Projects, Kanban, Goals) as top-level links
- Overflow items in a "More" dropdown, grouped by category (Workflow, System)
- No vertical sidebar for main navigation

**Impact**: The sidebar in the mockup is for **visual context only** — it shows where "Doc Intelligence" would sit in navigation hierarchy. The actual implementation will add a nav item to the existing horizontal structure, not build a sidebar.

**Verdict**: This is acceptable for a mockup. The sidebar accurately represents the navigational intent (DI as an "Integrations" section item with a badge count). When building the real page, the nav item will be added to `navCategories` in `AppShell.tsx` as:
```typescript
// In an "Integrations" category, or added to "Workflow":
{ href: '/doc-intelligence', label: 'Doc Intelligence', icon: FileText }
```

### 4. ❌ Icon Library — Needs Fix

The mockup uses **Font Awesome 6.5.0** (`fa-solid fa-check-square`, `fa-solid fa-file-lines`, etc.).

DESIGN.md explicitly states:
> **Don't mix icon libraries (Lucide only, via Iconify when available)**

MC uses Lucide React throughout (`lucide-react` package). All icons in `AppShell.tsx` are Lucide imports.

**Fix needed**: Replace Font Awesome references with Lucide equivalents when implementing:

| Font Awesome | Lucide Equivalent |
|-------------|-------------------|
| `fa-check-square` | `CheckSquare` |
| `fa-calendar-days` | `CalendarDays` |
| `fa-inbox` | `Inbox` |
| `fa-file-lines` | `FileText` |
| `fa-github` | `Github` |
| `fa-wallet` | `Wallet` |
| `fa-home` | `Home` |
| `fa-sliders` | `Settings` |
| `fa-list-check` | `ListChecks` |
| `fa-folder-open` | `FolderOpen` |
| `fa-chart-bar` | `BarChart3` |
| `fa-credit-card` | `CreditCard` |
| `fa-triangle-exclamation` | `AlertTriangle` |
| `fa-clock` | `Clock` |
| `fa-file-pdf` | `FileText` |
| `fa-arrow-up-right-from-square` | `ExternalLink` |
| `fa-rotate-right` | `RefreshCw` |
| `fa-check` | `Check` |
| `fa-calendar-plus` | `CalendarPlus` |
| `fa-ban` | `Ban` |
| `fa-file-invoice` | `FileText` |
| `fa-stethoscope` | `Stethoscope` |
| `fa-plug-circle-check` | `PlugZap` |
| `fa-download` | `Download` |
| `fa-arrow-right-to-bracket` | `ArrowRightToLine` |

**Note**: This is a mockup-only issue. The real React implementation should use `lucide-react` imports directly. No change to the HTML mockup file is strictly necessary since it's a design reference, not production code.

### 5. ✅ Tab Layout — Well Designed

The 3-tab layout matches the design in `doc-intelligence.md` and `di-integration-unified-plan.md`:

| Tab | Content | Status |
|-----|---------|--------|
| **Action Queue** | Task list + detail pane (master-detail) | ✅ Well-implemented in mockup |
| **Documents** | Gallery grid with type badges, action badges, amounts | ✅ Good — needs `/api/documents` (Phase 3) |
| **Insights** | Stats cards + alert list + module status | ✅ Good — needs `/api/stats` (Phase 3) |

Tab styling uses accent-colored bottom border for active state, matching MC patterns.

### 6. ✅ Component Patterns — Aligned

| Component | Mockup | DESIGN.md | Match |
|-----------|--------|-----------|-------|
| Cards | surface-1 bg, 8–12px radius, 1px border | surface-1, 12px, 1px border | ✅ |
| Tag pills | surface-2 bg, full radius, 10px font | surface-2, full radius, 12px font | ✅ (close) |
| Task rows | No card wrapper, hover: surface-1 | No card wrapper, hover: surface-2 | ⚠️ Minor |
| Buttons | accent fill, white text, 8px radius | accent fill, white text, 8px radius | ✅ |
| Filter chips | border, full radius, 11px font | — (not explicitly in DESIGN.md) | ✅ Reasonable |
| Stat cards | surface-1, 8px radius, tabular-nums | Follows card pattern | ✅ |

**Minor**: Task row hover uses `surface-1` in mockup but DESIGN.md says `surface-2`. Trivial to fix in implementation.

### 7. ✅ Transitions — Aligned

All transitions in the mockup are 100–150ms, matching DESIGN.md's guidance:
- `transition: background 0.1s` on nav items and task rows
- `transition: color 0.15s, border-color 0.15s` on tabs
- `transition: transform 0.15s, box-shadow 0.15s` on doc thumbnails

No motion on page load. ✅

---

## Recommended Actions

### Before Phase 3 Implementation

1. **Remove Documents and Insights tabs** from the hub page scope — Action Queue only
2. **Add DI KPI cards** to `KPI_REGISTRY` (`doc-actions-pending`, `doc-statements-missing`, `doc-eob-unmatched`)
3. **Enhance `TaskDetailPanel` document preview** — detect `connectorType === 'document-intelligence'` and render PDF thumbnail, structured metadata grid, and action buttons (inspired by `RichPreviewEmbed` patterns)
4. **Remove unused Inter font import** from mockup (optional — cosmetic cleanup)
5. **Note icon mapping table** above when building React components
6. **Use `surface-2` for task row hover** instead of `surface-1`
7. **Add nav item** to existing `AppShell.tsx` categories, not as a sidebar

### No Changes Needed For

- Color tokens (fully aligned)
- Action Queue tab layout (approved as designed)
- Component styling (minor deviations within tolerance)
- Transition timing (aligned)
- Surface hierarchy (correct)

---

## Decision

**Keep the mockup's Action Queue tab as the design reference** for the `/doc-intelligence` hub page. Remove Documents and Insights tabs from scope — that content integrates into existing MC surfaces (Dashboard KPIs, Notifications, Insights page, Settings). The document-oriented task detail panel (with PDF preview, metadata grid, action buttons) should render wherever a DI task is selected, not just on the hub page.
