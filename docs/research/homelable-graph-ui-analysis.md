---
title: "Homelable Graph UI Source Analysis"
status: active
created: 2026-08-05
last_reviewed: 2026-08-05
category: research
subject: "[Pouzor/homelable](https://github.com/Pouzor/homelable)"
source_revision: "f07f43686ec05f586bebe476b889a47137d2af2d"
related:
  - "[Graph Visualization System](../design/graph-visualization-system.md)"
  - "[Graph Workbench](../design/proposed/graph-workbench.md)"
  - "[Structured Graph Workspace](../design/proposed/structured-graph-workspace/README.md)"
  - "[GitHub issue #2084](https://github.com/rsocko/mission-control/issues/2084)"
---

# Homelable Graph UI Source Analysis

## Executive Summary

Homelable is a useful comparison for Mission Control because both products use
React 19, `@xyflow/react`, Dagre, Zustand, and typed domain nodes. Homelable's
main advantage is not its graph model. It is the coherence of its canvas
editing experience:

- selection, lasso, pan, connect, and delete behavior are predictable;
- alignment guides, grid snapping, copy/paste, and undo make manual arrangement
  practical;
- search can move the viewport directly to a result;
- groups, visual zones, collapse, waypoints, and endpoint reconnection support
  sophisticated diagrams;
- multiple named designs and read-only views turn a canvas into a durable
  artifact; and
- live monitoring is kept separate from persisted user edits.

Mission Control already has stronger task, dependency, provenance, bounded
query, and semantic-search foundations. The opportunity is therefore to adopt
selected interaction and state-management patterns without becoming a generic
whiteboard or copying Homelable's topology-specific concepts.

The recommended outcome is a shared **Graph Workbench interaction contract**,
not a single universal graph component. Project, Universe, Ideation, Words, and
a future Relationship Workspace should retain their own data and rendering
models.

## Research Scope and Method

This review inspected the public Homelable source at commit
[`f07f436`](https://github.com/Pouzor/homelable/tree/f07f43686ec05f586bebe476b889a47137d2af2d).
The findings below are source-verified unless explicitly described as a
recommendation or inference.

Primary sources:

| Area | Source |
|---|---|
| Dependencies | [`frontend/package.json`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/package.json) |
| Graph types | [`frontend/src/types/index.ts`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/types/index.ts) |
| Canvas state and history | [`frontend/src/stores/canvasStore.ts`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/stores/canvasStore.ts) |
| React Flow configuration | [`frontend/src/components/canvas/CanvasContainer.tsx`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/components/canvas/CanvasContainer.tsx) |
| Custom nodes | [`frontend/src/components/canvas/nodes`](https://github.com/Pouzor/homelable/tree/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/components/canvas/nodes) |
| Custom edges and waypoints | [`frontend/src/components/canvas/edges/index.tsx`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/components/canvas/edges/index.tsx) |
| Collapse and edge rewiring | [`frontend/src/utils/collapseFilter.ts`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/utils/collapseFilter.ts) |
| Alignment guides | [`frontend/src/hooks/useAlignmentGuides.ts`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/hooks/useAlignmentGuides.ts) |
| Autosave | [`frontend/src/hooks/useAutosave.ts`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/hooks/useAutosave.ts) |
| Search | [`frontend/src/components/canvas/SearchBar.tsx`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/components/canvas/SearchBar.tsx) |
| Read-only view | [`frontend/src/components/LiveView.tsx`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/components/LiveView.tsx) |
| Export format | [`frontend/src/utils/exportYaml.ts`](https://github.com/Pouzor/homelable/blob/f07f43686ec05f586bebe476b889a47137d2af2d/frontend/src/utils/exportYaml.ts) |

## Product and Interaction Model

### Typed canvases

Homelable exposes more than 35 node types across network and electrical
designs. It does not expose arbitrary user-defined schemas. This constraint is
a strength: nodes remain meaningful, searchable, and renderable with
domain-specific details.

Mission Control should retain the same discipline. A graph surface should
register allowed node and relationship types for its use case rather than
exposing a generic shape palette.

### Canvas mechanics

The main canvas configures:

- 8px grid snapping;
- partial-selection lasso;
- Ctrl/Cmd multi-selection;
- Space-drag panning;
- Backspace/Delete removal;
- loose connection mode with a larger connection radius;
- selectable pan/lasso behavior; and
- bounded zoom.

These mechanics make the canvas feel like an editor rather than a passive
diagram. Mission Control currently provides subsets of this behavior across
Project Graph and Ideation, but does not offer a consistent contract.

### Groups and zones

Homelable has two different visual constructs:

1. A real group uses React Flow `parentId`. Child placement is relative to the
   parent, moving the group moves its children, and collapse traverses the
   hierarchy.
2. A rectangle zone is decorative. Spatial hit-testing determines which node
   centers happen to be inside it when collapsed.

This distinction maps well to Mission Control:

- **semantic container**: phase, initiative, business unit, or another
  registered containment relationship;
- **visual zone**: a view-local planning region that does not change entity
  meaning.

The UI must label these differently. Dragging a node into a visual zone must
never silently create a semantic relationship.

### Collapse and edge aggregation

Homelable removes collapsed descendants before passing nodes to React Flow.
Edges whose endpoints are hidden are rewired to the nearest visible ancestor,
and parallel rewired edges are deduplicated.

For Mission Control, collapsed aggregate edges should carry a count and retain
the relationship types represented inside the group. A phase collapsed in
Project Graph could therefore show `3 blocking dependencies` rather than
making dependencies disappear or rendering indistinguishable duplicate lines.

### Search and viewport navigation

Homelable search covers several node fields and uses React Flow `setCenter` to
animate the viewport to the selected result. It also resolves absolute
positions for nodes nested in groups.

Mission Control should standardize:

- one graph-local search command;
- keyboard invocation;
- result stepping;
- animated focus;
- selected-node emphasis;
- parent expansion when a result is hidden; and
- a back/forward focus trail for exploratory graphs.

Universe already has search and filters. The reusable opportunity is the
viewport-navigation behavior, not another search backend.

### Arrangement and routing

Homelable includes alignment guides, delayed snap-on-drag-stop, an Alt-key
bypass, cursor-centered multi-node paste, resizable nodes, custom edge
waypoints, 45-degree snapping, and draggable edge endpoints.

The delayed snapping technique is especially relevant. It displays guides
during dragging but changes positions only at drag-stop, avoiding conflict with
React Flow's pointer-offset logic.

Mission Control should introduce these capabilities only in views where manual
placement is durable. They add little value to a force-directed Universe view
whose positions are recomputed.

### Multiple designs and presentation

Homelable can create, copy, rename, switch, and delete named designs. Each
design stores its own graph state and viewport. A read-only route disables
dragging, connection, and selection while preserving pan, zoom, and collapse.

Mission Control's stronger version should keep:

- canonical entities and relationships independent from views;
- position, routing, filters, layout, and default collapse state per view;
- optional personal runtime pan/zoom separate from shared view defaults; and
- scoped, expiring, auditable presentation links instead of a global secret
  query key.

## Implementation Techniques Worth Reusing

### Separate semantic edits from runtime updates

Homelable maintains a monotonic `editSeq` that advances for real user edits but
not live status changes. Autosave listens to this sequence instead of raw
node-array identity. A dedicated status action avoids marking the canvas dirty.

Mission Control should make the same distinction:

| Change | Persisted artifact dirty? | Semantic undo entry? |
|---|---:|---:|
| Rename entity | Yes | Yes |
| Create relationship | Yes | Yes |
| Move placement in a saved manual view | Yes | Yes, in view history |
| Select or hover node | No | No |
| Measure node dimensions | No | No |
| Receive task/status refresh | No | No |
| Run temporary force simulation | No | No |

### Autosave provenance guard

Homelable pins the active design ID when it arms autosave and verifies that ID
again before writing. This avoids saving stale state into a newly selected
design.

The same guard is required for Mission Control saved views and workspaces.
Writes should additionally include an expected revision where the artifact is
shared or command-driven.

### Distinguish load from layout

Homelable clears history when loading another design but preserves an undo
snapshot when applying automatic layout. Mission Control should preserve this
distinction:

- loading or switching a view replaces the active history context;
- changing layout within a view is undoable;
- semantic history and view-placement history should not be conflated; and
- if histories survive view switching, they should be stored per view.

### Pre-filter hidden graph elements

Collapsed nodes and edges are removed before React Flow renders. This reduces
work and avoids invisible elements affecting interaction. Mission Control
should use the same principle for collapsed, filtered, and budget-truncated
subgraphs.

## Recommended Adoption by Mission Control Surface

| Surface | Adopt | Avoid |
|---|---|---|
| Project Graph | Search/fly-to, explicit modes, collapse aggregation, saved lenses, optional manual routing | Treating temporary drag as hierarchy mutation |
| Universe | Search focus trail, pinning, one/two-hop expansion, saved filter lenses | Manual diagram layout and general canvas authoring |
| Ideation | Inline edit, keyboard creation, lasso, copy/paste, guides, collapse, shared undo | Modal-first editing |
| Word Graph | Focus/highlight, filters, table/matrix alternatives | Converting the accessible SVG into a free-form canvas |
| Relationship Workspace | Typed entities, semantic containers, visual zones, saved views, relationship inspector, presentation | User-defined arbitrary schemas and generic whiteboard tools |

## Prioritized Recommendations

### Adopt now

1. Define a shared Graph Workbench interaction contract and explicit
   Explore/Arrange/Connect modes.
2. Complete Ideation's direct canvas editing and keyboard loop.
3. Standardize graph search, animated focus, focus history, and hidden-parent
   expansion.
4. Distinguish semantic graph state, saved view state, and runtime UI state.
5. Add collapse edge aggregation to hierarchy views.

### Adopt after saved placements exist

1. Lasso, multi-select, cursor-centered copy/paste, and alignment guides.
2. Manual edge waypoints and endpoint reconnection.
3. Named saved views with per-view layout, routing, filters, and collapse.
4. Read-only presentation links with appropriate authorization.
5. PNG, Markdown, and stable-ID JSON exports.

### Do not adopt

- infrastructure-specific status checks and device metadata;
- dozens of handles representing physical ports;
- VLAN, electrical, or network-specific edge styling;
- arbitrary user-defined shape libraries;
- spatial zones as semantic containment;
- label-based serialization identifiers; or
- unauthenticated/global-secret sharing for sensitive data.

## Risks and Traps Found in Homelable

### Label-based export identity

Homelable's YAML export maps internal IDs to labels and serializes edge targets
by label. Duplicate labels can therefore make round trips ambiguous. Mission
Control exports must preserve stable entity, relationship, view, and placement
IDs.

### Collapse stored on canonical nodes

Homelable stores collapse on node data. That prevents two views from having
different collapse defaults. Mission Control should keep collapse in runtime
state or saved view state, never on a canonical entity.

### Absolute waypoints

Absolute waypoints become invalid after a different layout is applied.
Mission Control should store routes per view, associate them with endpoint
placements, and explicitly clear or recompute routes after automatic layout.

### Spatial containment ambiguity

Decorative zones are evaluated by center-point hit-testing and move
independently from their contents. This is acceptable for decoration but unsafe
for phases, initiatives, or other semantic containment.

### Accessibility gaps

Homelable provides shortcuts and some accessible primitives but lacks complete
node-to-node keyboard navigation and graph semantics for assistive technology.
Mission Control should preserve list/outline parity, roving focus, visible
focus, keyboard relationship creation, and non-canvas alternatives.

### Modal-heavy editing

Most Homelable node and edge details are edited in large modals. Mission
Control should prefer inline title editing and a persistent inspector so users
retain graph context.

## Implementation Backlog

| Issue | Purpose |
|---|---|
| [#1200](https://github.com/rsocko/mission-control/issues/1200) | Shared Graph Workbench interaction shell |
| [#1204](https://github.com/rsocko/mission-control/issues/1204) | Keyboard-first direct editing for Ideation |
| [#1202](https://github.com/rsocko/mission-control/issues/1202) | Search, animated focus, and navigation history |
| [#1203](https://github.com/rsocko/mission-control/issues/1203) | Saved views, per-view placements, and read-only presentation |
| [#1201](https://github.com/rsocko/mission-control/issues/1201) | Relationship Workspace / Account Map MVP |
| [#1199](https://github.com/rsocko/mission-control/issues/1199) | Advanced arrangement and edge routing after durable placements |

Existing issues remain authoritative for
[Project structure editing](https://github.com/rsocko/mission-control/issues/1021),
[Universe toolbar information architecture](https://github.com/rsocko/mission-control/issues/1080),
and
[Universe relationship editing](https://github.com/rsocko/mission-control/issues/1083).

## Conclusion

Homelable validates that sophisticated canvas interactions can coexist with a
strict typed domain model. Mission Control should borrow its editing mechanics
and state separation, but apply them to Mission Control's stronger semantic
graph contracts.

The recommended product direction is:

> Build a consistent Graph Workbench around specialized graph experiences,
> then validate a typed Relationship Workspace as the next authored graph
> surface.
