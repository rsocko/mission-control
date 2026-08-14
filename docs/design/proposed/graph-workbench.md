---
title: "Graph Workbench Interaction System"
status: proposed
created: 2026-08-05
category: design
related:
  - "[Homelable Graph UI Source Analysis](../../research/homelable-graph-ui-analysis.md)"
  - "[Graph Visualization System](../graph-visualization-system.md)"
  - "[Structured Graph Workspace](structured-graph-workspace/README.md)"
  - "[GitHub issue #2084](https://github.com/rsocko/mission-control/issues/2084)"
mockups:
  - "Embedded Project Graph Workbench wireframe"
  - "Embedded Relationship Workspace wireframe"
---

# Graph Workbench Interaction System

## Summary

Mission Control has several graph experiences with different renderers and
jobs:

- Project Graph explains hierarchy and task dependencies.
- Universe explores broad task and attribute relationships.
- Ideation authors an ordered hierarchy.
- Word Graph explains word-to-task provenance.
- The proposed Relationship Workspace authors typed entities and relationships.

These surfaces should not be merged into one graph engine. They should share a
bounded interaction system: terminology, modes, search/focus behavior,
selection, inspectors, saved-view semantics, accessibility expectations, and
state boundaries.

This document calls that system the **Graph Workbench**.

## Product Goals

1. Make graph interactions predictable across Mission Control.
2. Separate exploration, placement, and semantic relationship editing.
3. Support direct, keyboard-efficient authoring where the domain permits it.
4. Preserve domain-specific renderers and bounded graph queries.
5. Make saved views durable without confusing placement with meaning.
6. Provide non-canvas alternatives and keyboard parity.

## Non-Goals

- One universal graph component
- A general-purpose diagramming or whiteboard suite
- Arbitrary shapes or user-defined graph schemas
- Manual arrangement for every graph
- Replacing list, outline, table, or detail views
- Treating all dragging as a semantic mutation
- Sharing unrestricted or unbounded graph data

## Shared Workbench Anatomy

```text
+-------------------------------------------------------------------------+
| Project Map  [Explore] [Arrange] [Connect]   Search   Layout v   Share  |
+--------------+------------------------------------------+---------------+
| LAYERS       |                                          | INSPECTOR     |
| [x] Phases   |       +-------------+                    | Task          |
| [x] Tasks    |       | Discovery  7|                    | Authentication|
| [x] Blocks   |       +------+------+                    |               |
| [ ] Related  |              |                           | Status: Active|
|              |     +--------+---------+                 | Phase: Build  |
| SAVED VIEWS  |     | Authentication |-- blocks --> ... |               |
| - Delivery   |     +-----------------+                 | RELATIONSHIPS |
| - Risks      |                                          | + Add link    |
| - Current    |                                          | Evidence ...  |
+--------------+------------------------------------------+---------------+
| 18 nodes / 24 links     Selection: 1     Undo     Fit view             |
+-------------------------------------------------------------------------+
```

The regions are capabilities, not mandatory permanent panels. Small graphs may
use popovers or drawers. The interaction vocabulary and state model remain
consistent.

### Command bar

The command bar owns:

- active interaction mode;
- graph-local search;
- layout selection and fit;
- saved-view controls;
- presentation/export actions; and
- keyboard help.

It should not repeat domain filters already supplied by the shared filter
system. Existing Universe toolbar work in issue
[#1943](https://github.com/rsocko/mission-control/issues/1943) remains the
surface-specific information architecture.

### Layers and saved views

The optional left rail exposes:

- node and relationship dimensions;
- topology filters such as roots, leaves, or selected neighborhoods;
- saved views; and
- legends when color or edge style carries meaning.

### Inspector

The optional right inspector shows the selected entity and its relationships.
It should preserve canvas context and replace modal-first editing for common
operations.

The inspector may edit only fields allowed by the active domain and source
ownership policy.

## Interaction Modes

### Explore

Default for Project and Universe graphs.

- click selects or opens details;
- drag pans unless a renderer explicitly supports temporary node movement;
- search and neighbor expansion navigate;
- no semantic edge can be created accidentally; and
- destructive commands require an explicit selected object.

### Arrange

Available only for a view with durable placements.

- node drag changes placement, never canonical entity meaning;
- lasso and multi-select are enabled;
- alignment guides and optional grid snapping are enabled;
- copy/paste duplicates or reuses entities according to the domain contract;
- layout changes create view-history entries; and
- Alt temporarily bypasses snapping.

For Project Graph, Arrange initially remains a temporary layout tool. Persistent
hierarchy editing belongs to the explicit structure-edit flow in issue
[#1826](https://github.com/rsocko/mission-control/issues/1826).

### Connect

Available only when the active graph supports semantic relationship mutation.

- connection handles become visible;
- dragging to an empty location opens search-first creation;
- dragging to an existing node validates compatible relationship types;
- the relationship inspector captures type-specific metadata;
- invalid endpoints provide a reason, not a silent no-op; and
- keyboard users can choose source, relationship type, and target without
  dragging.

Universe relationship editing remains governed by issue
[#1946](https://github.com/rsocko/mission-control/issues/1946).

### Direct edit

Direct editing is an action within the applicable mode, not a permanent fourth
mode:

- double-click, `F2`, or typing edits a selected label;
- `Enter` commits;
- `Escape` cancels;
- new nodes enter editing immediately; and
- more complex fields remain in the inspector.

## Search and Focus Contract

Every graph that can exceed one viewport should support:

1. Open graph-local search from the command bar or keyboard.
2. Search the fields exposed by that graph's bounded query.
3. Select a result to expand hidden ancestors if permitted.
4. Animate the viewport to the result.
5. Select and visibly emphasize the result.
6. Record the previous focus in a graph-local back/forward trail.
7. Preserve the current filter context.

Universe may additionally expand one or two relationship hops. Project Graph
should not fetch unrelated projects merely to satisfy a search.

## Selection and Keyboard Contract

- A visible focus ring is required independently from selection styling.
- Arrow keys move through domain-defined neighbors.
- `Enter` opens or edits according to the current surface.
- `Space` collapses/expands a selected container where supported.
- Shift and Ctrl/Cmd extend selection where multi-select is supported.
- Delete asks for confirmation when removal affects semantic data.
- A list, outline, or table must expose equivalent content and primary actions.
- Keyboard relationship creation must not require manipulating canvas handles.

Canvas cards containing inputs or controls must not use a single outer
`<button>`.

## Semantic Containers and Visual Zones

The Workbench recognizes two visually similar but semantically different
objects:

| Construct | Stored as | Moving contents | Collapse | Creates relationships |
|---|---|---|---|---:|
| Semantic container | Entity/relationship or hierarchy command | With container placement when applicable | Descendant traversal | Yes |
| Visual zone | View annotation | Independent by default | View-local spatial visibility only | No |

Visual zones require distinct styling and a `View annotation` label in the
inspector. Dropping onto a zone never reparents an entity.

## Collapse and Aggregate Edges

When a container collapses:

- descendants are filtered before rendering;
- external edges are represented at the nearest visible ancestor;
- equivalent aggregate edges are deduplicated;
- aggregate edges show relationship type and count;
- selecting an aggregate edge explains the hidden relationships; and
- expanding restores the original edges without changing semantic data.

Collapse is runtime state by default. A saved view may define a default collapse
state, but canonical entities do not own collapse.

## Saved Views and Placements

A saved view references canonical graph data and stores presentation choices:

```typescript
interface GraphViewPresentation {
  viewId: string;
  layout: 'horizontal-tree' | 'vertical-tree' | 'radial' | 'force' | 'manual';
  filters: Record<string, unknown>;
  visibleRelationshipTypes: string[];
  defaultCollapsedEntityIds: string[];
  placements: GraphPlacement[];
  edgeRoutes: GraphEdgeRoute[];
  viewport?: { x: number; y: number; zoom: number };
}
```

`GraphEdgeRoute` uses stable relationship and placement IDs. Routes are
per-view and are invalidated or recomputed explicitly when automatic layout
changes endpoint placements.

Canonical entities and relationships are never duplicated merely because they
appear in multiple views.

## History, Dirty State, and Autosave

The implementation must distinguish:

1. **Semantic history**: entity, hierarchy, and relationship commands.
2. **View history**: placements, routes, layout, and saved defaults.
3. **Runtime state**: selection, hover, temporary pan/zoom, and simulations.

Only the first two mark an artifact dirty. Status refreshes, node measurement,
selection, and force-layout ticks do not.

Autosave must pin:

- workspace ID;
- view ID;
- artifact revision; and
- the semantic or view edit sequence that armed the save.

A delayed save is discarded or retried against current state if any provenance
value changed.

## Arrangement and Edge Routing

Arrangement features are staged behind durable placements:

### Initial

- lasso and multi-select;
- cursor-centered copy/paste;
- alignment guides;
- optional grid snapping;
- deterministic automatic layout; and
- undoable layout changes.

### Advanced

- manual waypoints;
- 45-degree snapping;
- endpoint reconnection;
- route reset after auto-layout; and
- aggregate edge routing around collapsed containers.

These controls should not appear in force-directed exploration-only views.

## Presentation and Export

Saved views may be presented through:

- an authenticated read-only route;
- a scoped, expiring presentation link;
- PNG for visual communication;
- Markdown for summaries and inventories; and
- versioned JSON using stable IDs.

Presentation mode disables mutation controls but preserves permitted search,
pan, zoom, collapse, and inspector reads. Audit metadata records creator,
scope, expiration, and retrieval where sensitive data is involved.

## Surface-Specific Recommendations

| Surface | Workbench capabilities |
|---|---|
| Project Graph | Explore, search/focus, collapse aggregates, saved lenses, optional temporary Arrange |
| Universe | Explore, search/focus trail, pinning, neighbor expansion, saved filter lenses |
| Ideation | Explore, Arrange, direct edit, keyboard creation, collapse, copy/paste, alignment |
| Word Graph | Search/focus and filters only; retain accessible SVG/table alternatives |
| Relationship Workspace | Full Explore, Arrange, Connect, inspector, saved views, presentation |

## Relationship Workspace Mockup

```text
+------------------------------------------------------------------------+
| Account: Contoso   [Network] [Initiatives] [Stakeholders] [Table]      |
| Search or create entity...                         Add v   Connect v    |
+------------------------------------------------------------------------+
|                       + Strategic Priority +                         |
|                       | Improve retention  |                         |
|                       +----------+---------+                         |
|                           supports|                                   |
|       + Opportunity +-------------+---------+                         |
|       | Mobile App  |                       |                         |
|       +------+------+               + Project -----+                 |
|     specialist|                     | Enrollment   |                 |
|        +-------v---+                 +------+-------+                 |
|        | Jane Smith|-- participant --------+                         |
|        +-----------+                                                  |
+------------------------------------------------------------------------+
| Connect Jane Smith                                                     |
| Relationship: [participant in v]  Find existing entity...              |
| Role: [Executive sponsor]  Rationale: [...]                [Create]     |
+------------------------------------------------------------------------+
```

This surface is justified only after a representative account-planning dataset
passes the validation gate in the Structured Graph Workspace roadmap.

## Delivery Sequence

### Phase 1: interaction contract

[Issue #2212](https://github.com/rsocko/mission-control/issues/2212)

- shared mode vocabulary and command-bar primitives;
- search/focus controller;
- selection and keyboard contract;
- dirty-state classification; and
- tests against Project and Universe integration boundaries.

### Phase 2: complete Ideation authoring

[Issue #2216](https://github.com/rsocko/mission-control/issues/2216)

- direct label editing;
- keyboard sibling/child loop;
- collapse;
- lasso and copy/paste;
- alignment guides; and
- shared undo behavior.

### Phase 3: graph navigation and saved lenses

[Issue #2214](https://github.com/rsocko/mission-control/issues/2214)

- Project and Universe focus behavior;
- collapse aggregate edges;
- pinned nodes and focus history;
- named filters/layout defaults; and
- no semantic authoring expansion beyond existing domain issues.

### Phase 4: durable views and presentation

[Issue #2215](https://github.com/rsocko/mission-control/issues/2215)

- canonical/view state separation;
- saved placements and routes;
- read-only presentation;
- stable-ID export; and
- authorization and audit.

### Phase 5: Relationship Workspace pilot

[Issue #2213](https://github.com/rsocko/mission-control/issues/2213)

- fixed entity and relationship registries;
- search-before-create connection flow;
- network, hierarchy, and table views;
- relationship inspector; and
- bounded agent handoff.

Advanced waypoints and endpoint reconnection remain a later capability tracked
in [issue #2211](https://github.com/rsocko/mission-control/issues/2211). They
should not block the first durable saved-view implementation.

## Decision Gates

1. Do shared primitives remove duplicated behavior without imposing one
   renderer?
2. Does direct canvas editing materially improve 25-node Ideation creation?
3. Do saved views solve repeat navigation or presentation jobs?
4. Does a real account-planning exercise require typed non-hierarchical
   relationships?
5. Can all semantic mutations be completed without pointer-only canvas
   interaction?

Stop extraction if the shell begins absorbing graph data fetching, layout
algorithms, or domain-specific node rendering.
