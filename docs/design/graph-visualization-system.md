# Graph Visualization System — Design Document

> Interactive exploration document: [graph-view-exploration.html](./graph-view-exploration.html)
>
> Related interaction research:
> [Homelable Graph UI Source Analysis](../research/homelable-graph-ui-analysis.md)
> and [Graph Workbench](./proposed/graph-workbench.md)

## Summary

A graph visualization and navigation system for Mission Control enabling visual exploration of tasks, projects, dependencies, tags, and attributes through interactive graph views.

**MC Project**: [Graph Visualization System](https://mission-control.example/projects/example-project)

## Features (4 Phases, ~25-29 days total)

### Phase 1: Project Graph (~5-6 days) — [#1728](https://github.com/rsocko/mission-control/issues/1728)
- Tree layout: Project → Phase → Task via @xyflow/react + @dagrejs/dagre
- Phase + task dependency arrows (drag-to-connect)
- Status color-coding, click-to-detail, pan/zoom with minimap
- Shared server-side graph service with a project-subgraph query used by the renderer
- **Schema change**: New `task_dependencies` table

### Phase 2: Ideation + Universe (~8-10 days) — [#1729](https://github.com/rsocko/mission-control/issues/1729)
- Dual-panel ideation canvas (outline + mind map, Taskade-style sync)
- Node type promotion (idea → phase → task), Convert to Project
- Universe property graph: every task + every attribute value = a node
- Dimension toggles, semantic zoom (LOD), search-first mode

### Phase 3: AI + Tags + Words (~6-8 days) — [#1730](https://github.com/rsocko/mission-control/issues/1730)
- AI Expand (ideation nodes) + AI Breakdown (existing tasks)
- Tag galaxy (force graph) + co-occurrence matrix (heatmap)
- Word cloud (d3-cloud, toggleable sources) + word-task bipartite graph

### Phase 4: Semantic Intelligence (~4-5 days) — [#1731](https://github.com/rsocko/mission-control/issues/1731)
- Semantic word clustering via embeddings
- AI-suggested tag relationships
- Cross-source relationship discovery

### Cross-cutting: Inline Property Editing — [#1732](https://github.com/rsocko/mission-control/issues/1732)
- Three tiers: side panel (existing) → Linear-style shortcuts → `key:: value` inline syntax
- Research-backed: `key:: value` (Logseq/Roam convention), `[[wiki-links]]` for relations
- Implemented relationship persistence is limited to `depends-on::` (`blocks`) and
  `related::`/general wiki-links (`related`), which map to canonical
  `task_dependencies` types. `duplicates::` remains deferred because the canonical
  task model has no duplicate-target relationship field; `status_reason=duplicate`
  records only a close reason and cannot identify the duplicated task.

## Technology Stack

| Component | Library | Notes |
|-----------|---------|-------|
| Project/dependency graph | @xyflow/react v12 | 37.8k ⭐, MIT, React 19 ✅ |
| Tree layout | @dagrejs/dagre | Active TS fork (NOT dead original) |
| Universe graph (≤500 nodes) | react-force-graph-2d | Canvas, 60fps |
| Universe graph (1000+) | sigma.js v3 | WebGL, tens of thousands |
| Outline tree | react-arborist | 3.7k ⭐, virtualized, drag reparent |
| Inline property editor | Lexical (already installed) | Custom node types |
| Word cloud | d3-cloud | Skip react-wordcloud (React 16 only) |
| Drag & drop | @dnd-kit (already installed) | — |
| State management | zustand (already installed) | — |

## Graph Data Layer

The graph is a projection over Mission Control's relational data, not a separate
graph database. The shared contract in `src/lib/graph/types.ts` normalizes
projects, phases, tasks, tags, properties, and words into typed nodes. Consumers
select only the kinds they render; supporting a kind does not require every
renderer to display it.

Do **not** build a generalized graph platform or broad public API up front.
Add narrow, consumer-driven queries as graph views need them, beginning with:

- Project subgraph: project → phases → tasks, including phase and task dependencies
- Node neighbors: explicit, derived, and optionally semantic task relationships
- Filtered subgraph: bounded nodes/edges for Universe search and dimension filters

The visualization components consume these queries rather than reconstructing
relationships in the browser. LLM tools may call the same service directly, or
use thin authenticated API/tool wrappers, so graph reasoning is not coupled to
the visual renderer.

### Relationship Semantics

The edge union is discriminated by relationship type:

| Relationship | Direction | Provenance | Relationship metadata |
|---|---|---|---|
| `contains` | container → member | derived | none |
| `blocks` | blocker → blocked | explicit | connector sync status/action/error when applicable |
| `related` | symmetric (canonical endpoints) | explicit | connector sync metadata when applicable |
| `has-tag` | task → tag | derived | exact relational membership |
| `has-property` | task → property | derived | property dimension |
| `word-task-provenance` | word → task | derived | source, occurrence count, and source labels |
| `tag-co-occurrence` | symmetric (canonical endpoints) | derived | count and exact contributing task IDs |
| `semantic-similarity` | symmetric, never hierarchical | embedding | validated score in `[0, 1]` plus provider/model/update metadata when available |

All shared results include `pageInfo` with node/edge budgets, returned counts,
truncation reasons, and an optional continuation cursor. `normalizeGraphBudgets`
applies hard caps at the service boundary, while narrow route adapters reject
malformed dimensions, filters, searches, and numeric inputs. The local
single-user routes currently have no user/session authorization model;
`getNodeNeighbors` accepts a task authorization policy hook so an authenticated
wrapper can enforce access before neighbor data is queried.

### Consumer Projections

- **Project** returns shared project/phase/task nodes and contains/blocks/related
  edges. Blocking direction and connector dependency sync metadata are preserved.
- **Universe** uses the bounded filtered-subgraph query. Tags are tag nodes;
  scalar dimensions are property nodes; edges are `has-tag` or `has-property`.
  Existing facets and statistics remain consumer-specific fields.
- **Tags** keeps its frequency/matrix payload because counts and contributing
  task sets are first-class UI data. `projectTagInsights` adapts it to shared tag,
  task, membership, and co-occurrence primitives without losing provenance.
- **Words** keeps its cloud/extraction payload. `projectWordInsights` adapts it to
  shared word/task nodes and provenance edges with exact source attribution.

### Project Hierarchy Mutations

Project and phase containment edges remain derived. Persistent reordering or
reparenting changes `project_phases` and `project_phase_items` through the
project hierarchy command service; it does not create graph edge records.

`POST /api/projects/[id]/hierarchy` accepts project-scoped, versioned commands
for phase reorder and task move/reorder. Each command:

- requires an expected hierarchy revision and idempotency key;
- validates project, phase, and task ownership;
- applies membership and dense sibling ordering in one SQLite transaction;
- records an audit receipt and inverse command for conditional undo;
- returns the authoritative hierarchy snapshot and next revision.

All hierarchy table writers advance the project revision through database
triggers. The command service suppresses those per-row increments inside its
transaction and advances the revision once. A stale command returns `409` with
the latest snapshot. Phase placement is Mission Control-local metadata and does
not trigger connector writes.

Graph node dragging currently changes only the temporary layout. Persistent
Graph reparenting is deferred until an explicit structure-edit mode can submit
the same semantic commands with keyboard-accessible alternatives.

## Semantic Index Integration

Mission Control stores embeddings in the durable semantic index
(`semantic_documents`/`semantic_vectors`, issue #1664) and performs semantic
search over task and notification projections. Reuse that infrastructure to
augment graph exploration:

- Compute top-k semantically similar neighbors for a selected task through the
  narrow node-neighbor API
- Seed search-first Universe views with conceptually related tasks
- Support semantic word/concept clustering in Phase 4
- Offer semantic candidates for AI-suggested relationships

Semantic similarity augments the graph layer; it does not replace explicit or
derived edges. Do not persist every pairwise similarity as a canonical edge:
that would grow quadratically and become stale whenever content or the embedding
model changes. Compute bounded top-k results on demand from the vector the index
already holds for the selected task — never by embedding its content at request
time, which would compare a freshly produced vector against a corpus embedded
under different rules. Exclude the selected task, deleted tasks, vectors outside
the active index identity's vector space, and vectors older than the document
revision they point at. Return explicit unavailable, missing, stale, or
incompatible status instead of fabricating fallback edges. Include score and
provider/model/embedding timestamps when available. Never write semantic edges
to dependency or graph tables; persist only explicit or user-approved
relationships.

Projects, phases, tags, and attribute nodes are not currently embedded. Extend
the index to another entity type only when a concrete graph feature needs it,
and define its embedding text, update triggers, model/version metadata, and
re-index behavior at that time.

## Key Design Decisions (Research-Backed)

Based on analysis of 8 tools (Tana, Logseq, Roam, Notion, WorkFlowy, Linear, Obsidian, Taskade):

1. **Tab = child** — Universal, non-negotiable
2. **`key:: value` double-colon** for inline properties (PKM standard)
3. **`[[wiki-link]]`** for cross-references
4. **Linear-style single-key shortcuts** (P, S, D, L) for power users
5. **Named relation types** (blocks, related, duplicates) per Linear
6. **All graph code lazy-loaded** via `dynamic()` imports — zero cost for non-graph users
7. **Shared graph service, narrow APIs** — UI and LLM tools use the same bounded queries
8. **Semantic edges are scored suggestions** — never substitutes for explicit relationships

## Graph Workbench Interaction Direction

The graph renderers remain specialized, but they should converge on a bounded
interaction contract:

- explicit Explore, Arrange, and Connect modes where supported;
- graph-local search with animated focus and focus history;
- consistent selection, keyboard navigation, and inspector behavior;
- semantic containers distinguished from view-local visual zones;
- collapsed hierarchy edges aggregated at visible ancestors;
- saved filters, layout defaults, placements, and routes stored per view; and
- semantic edits, view edits, and runtime updates tracked independently.

Project Graph should adopt exploration and collapse improvements without
turning temporary node dragging into hierarchy mutation. Universe should remain
an exploration surface rather than a manual diagram editor. Ideation and a
future Relationship Workspace are the primary authored canvases.

Manual alignment, copy/paste, waypoints, and endpoint reconnection should be
introduced only after a view has durable placements. See the
[Graph Workbench proposal](./proposed/graph-workbench.md) for interaction
contracts, embedded mockups, sequencing, and accessibility requirements.

## Schema Addition

```typescript
export const taskDependencies = sqliteTable('task_dependencies', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  dependsOnTaskId: text('depends_on_task_id').notNull(),
  type: text('type').notNull().default('blocks'), // 'blocks' | 'related'
  createdAt: text('created_at').notNull(),
});
```

## Related Issues

- [#1723](https://github.com/rsocko/mission-control/issues/1723) — Priority × Effort quadrant scatter plot (separate from this project)

## Related Proposals

- [Structured Graph Workspace](proposed/structured-graph-workspace/README.md) —
  user-authored hierarchy and relationship workspaces, offline reference
  imports, and bounded external-agent handoffs
