---
title: "md2hd: Lessons for Mission Control Graph Surfaces"
status: active
created: 2026-08-13
last_reviewed: 2026-08-13
category: research
related:
  - "[Frontend Architecture](../architecture/frontend.md)"
  - "[Projects](../features/projects.md)"
---

# md2hd: Lessons for Mission Control Graph Surfaces

> Research into what Mission Control can learn from
> [evan-steinhilb/md2hd](https://github.com/evan-steinhilb/md2hd), both for
> current graph surfaces and for a future generic graph tool.

## Executive take

md2hd is most useful to Mission Control as a compact interaction and graph
semantics reference, not as a code dependency.

Its strongest ideas are:

1. **Relationships have a voice from each endpoint.** One fact can read as
   `employs` from an organization and `works at` from a person.
2. **Focus is a navigation mode, not only a highlight.** A selected node gets
   an inbound/outbound ego view with independent 1st, 2nd, 3rd, and all-degree
   expansion.
3. **A graph can be schema-light without being visually incoherent.** User
   types drive labels and color while the renderer remains domain-neutral.
4. **The source representation and canvas remain linked.** Users can inspect
   and edit source from a node and see the graph redraw.
5. **Unresolved references remain visible.** A missing target becomes a ghost
   node rather than disappearing.
6. **Agent instructions are part of the product.** The repository ships a
   detailed skill that teaches agents how to author and diagnose its graph
   format.

Mission Control already has a stronger foundation in typed entities, bounded
subgraphs, provenance, synchronization state, transactional writes, and
multiple purpose-built renderers. The opportunity is to combine those
strengths with md2hd's exploration model.

**Recommendation:** borrow the interaction grammar and make it native to MC's
shared graph contracts. Do not adopt md2hd's permissive parser, relation
stemming, global inverse-label configuration, or compiled renderer.

## Scope and confidence

Research was performed against the public repository at commit
[`933f9c3`](https://github.com/evan-steinhilb/md2hd/tree/933f9c3add0e173ba7587771d1af9d03388e262d)
on 2026-08-13.

The public repository contains the CLI, built frontend assets, screenshots,
and an unusually detailed authoring skill. It does **not** contain the
visualizer's source; the
[README](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/README.md#development)
says that source lives in a sibling app repository. Rendering observations
below are therefore verified from documented behavior and screenshots, not
from the layout implementation.

At the time of review the repository was two days old, at version `0.3.0`,
with no tags or GitHub releases. Treat it as a polished early experiment, not
a mature platform.

## What md2hd is

md2hd is a zero-runtime-dependency Node CLI that:

- accepts one or more Markdown files or folders;
- serves a prebuilt browser app on `127.0.0.1`;
- exposes the current file contents through `GET /__files.json`;
- re-reads those files on each request;
- turns frontmatter blocks into nodes and named relations or wikilinks into
  edges.

The implementation is intentionally small. See
[`bin/md2hd.mjs`](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/bin/md2hd.mjs)
and
[`package.json`](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/package.json).

An optional `type: map` block defines:

- map title;
- top-to-bottom or left-to-right layout;
- user-defined node types and colors;
- inverse relationship labels;
- symmetric relationship labels.

The same renderer can therefore present an organization chart, service map,
incident map, or plot outline without knowing those domains in advance.

## The transferable model

### 1. Endpoint-relative relationship language

md2hd normalizes a relationship into a canonical direction while retaining
both its forward and reverse labels. The same edge can consequently speak in
the selected node's voice.

This is better than displaying a fixed noun or verb on every edge because
graphs are read from a point of view:

| Canonical fact | From source | From target |
|---|---|---|
| Organization employs person | employs | works at |
| Task blocks task | blocks | blocked by |
| Project contains task | contains | belongs to |
| Task has tag | tagged | tags |

MC already canonicalizes symmetric `related` edges into a stable pair order in
`src/lib/graph/query.ts` and models explicit edge types in
`src/lib/graph/types.ts`. Directional `blocks` edges intentionally retain the
source and target established by the data model, but MC has no shared
display-direction abstraction. It should add those semantics as a relation
descriptor registry rather than storing ad hoc prose on each edge.

```ts
interface GraphRelationDescriptor {
  type: GraphEdgeType;
  direction: 'directed' | 'symmetric';
  sourceLabel: string;
  targetLabel: string;
}
```

This would improve:

- `ProjectStructureGraph` dependency labels;
- task relationship panels;
- Universe node details;
- future neighborhood and path views;
- accessibility descriptions, where direction currently needs extra context.

**Do not copy md2hd's global `inverse` map.** Relation semantics should be
scoped to a stable relation type, not inferred from a verb reused in unrelated
contexts.

### 2. N-hop focus as a first-class view

The
[documented focus view](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/README.md#why)
separates inbound and outbound connections and lets users independently expand
each side by degree. Further rings are muted and the camera reframes around
the result.

MC has pieces of this behavior:

- `src/lib/graph/focus.ts` computes descendants and immediate neighbors;
- `src/lib/graph/neighbors-service.ts` returns bounded explicit, derived, and
  semantic neighbors;
- `UniverseGraph` supports incremental expansion, selection, LOD, stable
  positions, and camera fitting;
- `ProjectStructureGraph` dims nodes outside a selection focus.

What is missing is a shared neighborhood concept:

```ts
interface GraphNeighborhoodQuery {
  centerNodeId: string;
  inboundDepth: number | 'all';
  outboundDepth: number | 'all';
  edgeTypes?: GraphEdgeType[];
  include?: NeighborRelationship[];
  maxNodes: number;
  maxEdges: number;
}

interface GraphNeighborhood extends GraphSubgraph {
  centerNodeId: string;
  nodeDepth: Record<string, { inbound?: number; outbound?: number }>;
}
```

Depth metadata should come from traversal, not be recomputed in each renderer.
Renderers can then consistently style rings, summarize truncation, and explain
why each node is visible.

The generic graph tool should make **Overview**, **Neighborhood**, and **Path**
distinct view modes over one graph document. Force layout alone is not a
navigation model.

### 3. Type-oriented navigation

md2hd's bottom strip exposes three surfaces:

- overview;
- one surface per node type;
- the selected node.

See the
[README's "Reading a map" section](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/README.md#reading-a-map)
and
[screenshots](https://github.com/evan-steinhilb/md2hd/tree/933f9c3add0e173ba7587771d1af9d03388e262d/media).

The key idea is not the strip's physical placement. It is that the graph,
typed index, and selected entity are peer views with preserved context.

MC currently distributes these concepts across route tabs, filter controls,
canvas selection, and side panels. A shared graph shell could define:

```ts
type GraphSurfaceMode =
  | { kind: 'overview' }
  | { kind: 'type'; nodeKind: string }
  | { kind: 'neighborhood'; nodeId: string }
  | { kind: 'path'; sourceId: string; targetId: string };
```

This could unify `/graph/universe`, `/graph/tags`, `/graph/words`, project
structure, and later generic graph documents without forcing all of them into
one visual layout.

### 4. Visible unresolved references

md2hd renders an undefined link target as a dashed `unresolved` ghost node.
Its
[authoring skill](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/skills/writing-md2hd-maps/SKILL.md#what-happens-to-your-links-before-anything-is-drawn)
treats this as both graceful degradation and a diagnostic.

MC currently filters incoming edges when either endpoint is not in the
bounded graph. That behavior is correct for pagination but conflates several
different conditions:

- endpoint excluded by the current view;
- endpoint omitted by a node or edge budget;
- endpoint not authorized;
- endpoint not synchronized yet;
- endpoint genuinely missing or deleted.

The API should preserve those distinctions. A generic representation could
include:

```ts
interface UnresolvedGraphNode {
  id: string;
  entityId: string;
  kind: 'unresolved';
  label: string;
  resolution:
    | 'not-loaded'
    | 'truncated'
    | 'pending-sync'
    | 'missing'
    | 'forbidden';
}
```

Authorization must not leak hidden entity labels or existence. A forbidden
endpoint should only be represented when policy explicitly allows that fact
to be disclosed.

### 5. Linked source and canvas editing

md2hd's node pane can switch to a live editor for the Markdown source behind a
node. The graph redraws as the source changes.

MC already has a stronger version of the underlying pattern in Ideation:

- a text outline and graph are projections of the same Zustand state;
- inline tokens become structured properties;
- outline edits reconcile back into nodes;
- the structure can be converted into projects, phases, tasks, and
  relationships.

The generic tool should generalize **multiple synchronized projections**, not
copy a Markdown-only editor:

| Projection | Best for |
|---|---|
| Canvas | topology, clustering, paths, spatial comparison |
| Outline | hierarchy, rapid keyboard entry, ordering |
| Table | bulk metadata editing and sorting |
| Inspector | one entity and its relations |
| Source | import/export format or advanced editing |

Every projection should edit the same command model. This avoids fragile
round-tripping where one textual syntax becomes the canonical domain model.

Markdown remains valuable as an import/export adapter and agent-friendly
authoring format. It should not replace MC's typed store or synchronization
contracts.

### 6. Agent-operable graph formats

The repository ships
[`writing-md2hd-maps`](https://github.com/evan-steinhilb/md2hd/tree/933f9c3add0e173ba7587771d1af9d03388e262d/skills/writing-md2hd-maps),
a detailed skill covering syntax, parser behavior, normalization, failure
modes, and verification.

That is a notable product pattern: a tool's agent operating manual ships next
to its human interface.

For MC, a generic graph tool should expose:

- a versioned graph document schema;
- a deterministic validation endpoint or CLI;
- commands for node and edge mutations;
- diagnostics that distinguish errors, unresolved references, normalization,
  and budget truncation;
- an agent skill with worked examples and verification steps.

Agents should mutate graph documents through commands or structured patches,
not by guessing internal Zustand state or database rows.

## Comparison with current MC surfaces

| MC surface | Current strength | md2hd-inspired opportunity |
|---|---|---|
| Project structure | Typed hierarchy, editable dependencies, cycle checks, sync status, deterministic layout | Endpoint-relative edge labels and depth-aware focus |
| Universe | Multiple dimensions, bounded expansion, force layout, stable positions, filtering, detail panels | Explicit neighborhood mode with inbound/outbound hop controls |
| Tag galaxy | Weighted co-occurrence, hover emphasis, task drill-down, accessible relationship list | Promote type/index navigation into the shared shell |
| Word graph | Clear bipartite provenance and keyboard-operable SVG | Reuse common selection and inspector contracts |
| Ideation | Outline/canvas duality, inline properties, undo, AI expansion, conversion to domain records | Become the proving ground for a generic synchronized projection model |

MC should preserve its purposeful renderer diversity:

- React Flow is appropriate for editable, directed structure;
- force graphs are appropriate for exploration and clustering;
- SVG bipartite layouts are appropriate for exact provenance;
- outlines and tables are better than canvases for dense editing.

A generic tool should share data, commands, selection, traversal, diagnostics,
and view state. It should **not** require one renderer to handle every graph.

## Proposed generic graph architecture

### Graph document

```ts
interface GenericGraphDocument {
  schemaVersion: string;
  id: string;
  title: string;
  ontology: GraphOntology;
  nodes: GenericGraphNode[];
  edges: GenericGraphEdge[];
  views: GraphViewDefinition[];
}

interface GraphOntology {
  nodeTypes: GraphNodeTypeDescriptor[];
  relationTypes: GraphRelationDescriptor[];
}

interface GenericGraphNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  provenance?: GraphEntityProvenance[];
  revision?: string;
}

interface GenericGraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: Record<string, unknown>;
  provenance?: GraphEdgeProvenance;
}
```

The ontology is explicit but optional: unknown types can receive deterministic
fallback presentation while diagnostics identify missing descriptors. This
retains md2hd's "bring your own ontology" quality without relying on silent
guessing.

### Shared graph kernel

The kernel should own:

- stable IDs and endpoint validation;
- relation descriptors and direction;
- bounded subgraph queries;
- N-hop and shortest-path traversal;
- provenance and synchronization state;
- commands, validation, undo, and conflict handling;
- view definitions and persisted positions;
- diagnostics and import/export adapters.

Renderers should own:

- layout;
- node and edge visuals;
- hit testing;
- camera and zoom;
- renderer-specific LOD;
- spatial interaction.

### View definitions

Positions and view state should be named, shareable data rather than an
anonymous browser-local side effect:

```ts
interface GraphViewDefinition {
  id: string;
  name: string;
  renderer: 'flow' | 'force' | 'bipartite' | 'outline' | 'table';
  mode: GraphSurfaceMode;
  query: GraphViewQuery;
  positions?: Record<string, { x: number; y: number; pinned?: boolean }>;
}
```

This supports personal views initially and collaborative/shared views later.

## What to leverage, adapt, and avoid

### Leverage directly

- Product language around focus, node voice, types, and linked source.
- The public examples and screenshots as interaction references.
- The idea of a graph-format skill and deterministic checker.
- The local-only CLI as inspiration for a future portable graph viewer or
  export, if that becomes a product requirement.

The repository is MIT licensed, but there is little reusable source for MC:
the public implementation is primarily a static-file server and compiled app.

### Adapt into MC concepts

- `label` / `reverse` -> typed relation descriptor registry.
- degree dials -> bounded directional neighborhood query.
- type strip -> shared surface mode and typed index.
- ghost nodes -> policy-safe endpoint resolution states.
- live Markdown editing -> synchronized canvas, outline, table, inspector, and
  adapter projections.
- user-defined `type` strings -> explicit optional ontology with deterministic
  fallbacks.
- position saving -> named, durable graph views.

### Avoid

1. **Silent parse failure.** MC should offer forgiving imports with precise
   diagnostics, never silently reinterpret invalid domain data.
2. **Verb stemming as identity.** Stripping `ed`, `s`, or `d` can merge
   unrelated relations and misses irregular verbs. Identity must use stable
   relation type IDs.
3. **Global inverse labels.** The same word may have different semantics in
   different contexts.
4. **Duplicate IDs that still render.** Reject or deterministically reconcile
   duplicates before graph construction.
5. **Client-local positions as the only persistence.** MC should distinguish
   ephemeral simulation coordinates from saved user or shared layouts.
6. **One layout for every purpose.** Generic data contracts should not imply a
   universal renderer.
7. **Depending on the compiled frontend.** Its source and extension contract
   are not public, and the project is too new to treat as infrastructure.

## Recommended experiments

### P0: relation descriptors

Add a display registry for existing MC edge types and use it in one task
relationship panel.

Success criteria:

- `blocks` reads as `blocked by` from the target;
- symmetric `related` reads consistently from either endpoint;
- labels and ARIA descriptions come from the same descriptor;
- no stored edge or API migration is required.

### P0: generic neighborhood traversal

Extend `src/lib/graph/focus.ts` with a pure, bounded traversal that returns
depth and direction metadata. Prove it with unit tests before changing a
renderer.

Success criteria:

- independent inbound and outbound depth;
- cycle-safe traversal;
- edge-type and provenance filters;
- deterministic budget truncation;
- depth metadata for every returned node.

### P1: Universe neighborhood mode

Use the traversal contract in Universe with 1/2/3/all controls, ring-based
opacity, and camera fitting. Preserve existing overview and incremental
expansion behavior.

### P1: unresolved endpoint diagnostics

Model endpoint omission reasons in graph API responses before introducing
ghost visuals. Confirm authorization and privacy behavior first.

### P1: generic graph document spike in Ideation

Adapt Ideation's current nodes to a renderer-neutral graph document in memory,
while keeping its existing UI and conversion behavior. The spike should prove:

- canvas and outline edit the same commands;
- node types and relation descriptors are data;
- conversion to MC projects remains an adapter;
- undo operates on commands or document revisions;
- no renderer types leak into the document.

### P2: Markdown adapter and agent skill

Only after the graph document stabilizes, prototype Markdown import/export and
ship a checker plus agent instructions. Use a documented subset rather than
copying md2hd's parser quirks.

## Open questions

- Is the generic graph tool primarily a personal thinking surface, an MC data
  explorer, or a persisted collaborative artifact? This determines storage,
  permissions, and conflict requirements.
- Are custom relation types allowed to affect MC domain behavior, or are they
  descriptive only?
- Should named graph views be portable between users, devices, and workspaces?
- Which graph operations must remain usable without a canvas for accessibility?
- Can unresolved nodes expose existence safely across all connector and account
  boundaries?
- Should imports preserve source text losslessly, or only preserve graph
  semantics?

## Sources

- [md2hd repository](https://github.com/evan-steinhilb/md2hd)
- [README at reviewed commit](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/README.md)
- [Authoring skill and parser behavior](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/skills/writing-md2hd-maps/SKILL.md)
- [CLI server](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/bin/md2hd.mjs)
- [Package metadata](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/package.json)
- [Screenshots](https://github.com/evan-steinhilb/md2hd/tree/933f9c3add0e173ba7587771d1af9d03388e262d/media)
- [MIT license](https://github.com/evan-steinhilb/md2hd/blob/933f9c3add0e173ba7587771d1af9d03388e262d/LICENSE)
