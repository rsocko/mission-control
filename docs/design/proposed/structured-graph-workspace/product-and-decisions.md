---
title: "Structured Graph Workspace — Product and Decision Record"
status: proposed
created: 2026-08-01
category: design
related:
  - "[Structured Graph Workspace](README.md)"
  - "[Architecture and Data Contracts](architecture.md)"
  - "[Phased Execution Plan](roadmap.md)"
  - "[Graph Visualization System](../../graph-visualization-system.md)"
---

# Structured Graph Workspace — Product and Decision Record

## Executive Summary

Mission Control already contains the beginning of a differentiated structured
thinking tool:

- a synchronized outline and mind-map;
- fast inline title and `key:: value` property entry;
- ordered hierarchical nodes;
- drag reparenting;
- structured idea, phase, and task types;
- local persistence and undo;
- AI expansion; and
- conversion from an ideation document into a project.

The immediate opportunity is to improve that workflow with XMind-like
directness: edit on the canvas, create adjacent nodes, navigate by keyboard,
collapse branches, and choose useful layouts.

A second opportunity is to apply the same interaction principles to typed
relationship maps. Account planning is the initial example:

- Projects relate to business units.
- People participate in projects and belong to business units.
- Opportunities have internal specialists and external stakeholders.
- Opportunities, projects, and business units support strategic priorities.
- Initiatives contain projects and other decomposed work.

The resulting product should not be framed as a generic graph editor. It should
be a structured workspace that supports:

1. a primary hierarchy when one exists;
2. typed cross-links when information is network-shaped;
3. multiple views over the same local entities;
4. offline references to source-system records; and
5. deliberate handoff to external agents for downstream action.

## How the Proposal Evolved

The design discussion deliberately moved through several scopes:

1. **Genericize the Ideation canvas.** The reusable value appeared to be the
   synchronized outline, canvas, store, layout, editing, and property system.
2. **Compare dedicated mind-map tools.** XMind and similar tools highlighted
   operational gaps rather than a missing data platform: canvas editing,
   keyboard-first entry, adjacent add controls, collapse, focus, branch color,
   and radial layout.
3. **Consider arbitrary account relationships.** A strict tree was insufficient
   for people, business units, projects, opportunities, and priorities.
4. **Consider source systems.** Some entities already exist formally, while
   others begin as local hypotheses before they are created in a CRM.
5. **Constrain integration scope.** The workspace should accept offline source
   snapshots and preserve IDs, but it should not read, synchronize, or write
   source systems.
6. **Separate reasoning from execution.** Scout or another authorized agent can
   consume a selected subgraph and perform external updates independently.

The final boundary preserves the useful parts of every step without committing
Mission Control to CRM, synchronization, or enterprise graph-platform scope.

## Product Thesis

> **A fast structured authoring environment for developing ideas, linking
> entities, and producing agent-ready context.**

The workspace is valuable before, during, and after records exist elsewhere:

- Before formalization, it stores local opportunity hypotheses.
- During planning, it connects those ideas to known people, business units,
  projects, and priorities.
- After formalization, it retains lightweight source references so an agent can
  locate the relevant records.
- It remains useful even when no source system or external agent is available.

## Primary Jobs to Be Done

### 1. Brainstorm and decompose quickly

Create a useful structure without repeatedly opening dialogs or positioning
individual nodes. Preserve the existing outline as a first-class editor.

### 2. Connect entities across dimensions

Express relationships that do not fit a single hierarchy, such as a person
participating in several projects or an opportunity supporting multiple
priorities.

### 3. Explore from different perspectives

View the same workspace by initiative, business unit, opportunity, stakeholder,
or strategic priority without duplicating canonical entities.

### 4. Mix formal references with provisional ideas

Import known CRM opportunities from a spreadsheet while also creating local,
pre-formal opportunity candidates.

### 5. Produce actionable context

Select entities and relationships, add an instruction, and let Scout or another
agent retrieve a bounded handoff bundle for downstream work.

## Proposed Product Modes

### Ideation

- Strong ordered hierarchy
- Document-local ideas, phases, and tasks
- Inline properties and lightweight cross-links
- AI expansion
- Convert to Mission Control project

### Account Map

- Reusable local entities within a workspace
- Fixed typed relationships
- Hierarchical and network views
- Imported CRM reference snapshots
- Local opportunity hypotheses
- Agent handoff for downstream CRM actions

### Future structured workspaces

Potential consumers include decision maps, stakeholder maps, architecture maps,
workflow planning, research synthesis, and incident analysis. None should be
built until a concrete workflow validates its entity and relationship schema.

## Interaction Model

### Preserve the text-first editor

The graph model does not replace indentation-based editing. The outline edits a
view's primary structural relationship:

```text
Improve Member Experience
  Digital Front Door
    Mobile Enrollment
    Benefits Navigation
```

Cross-links remain compact and searchable:

```text
Mobile Enrollment
  business-unit:: [[Consumer Products]]
  participants:: [[Jane Smith]], [[Sam Lee]]
  supports:: [[Improve Member Experience]]
```

Indentation cannot losslessly represent every cyclic relationship. It instead
defines the structural backbone of the active view. Secondary relationships
appear as link tokens, property rows, or optional canvas edges.

### Make the canvas a complete editor

Minimum canvas behavior:

- Click to select.
- Double-click, `F2`, or type to edit a selected label.
- `Enter` creates a sibling.
- `Tab` creates or establishes a child according to the keyboard semantics
  resolved in Phase 0.
- `Shift+Tab` outdents.
- `Escape` cancels editing.
- Arrow keys navigate parent, child, and sibling relationships.
- `Space` collapses or expands a branch.
- A visible `+` creates a connected child.
- A connector handle links to an existing or new compatible entity.
- New nodes enter editing immediately.
- All mutations use one undo history.

The desired XMind-style canvas loop is `Enter` for sibling and `Tab` for a new
child. The current outline uses `Tab` to indent an existing node beneath its
previous sibling. Phase 0 must decide whether to harmonize both editors on the
new-child behavior or preserve context-specific behavior with clear guidance.

The current canvas card is a `<button>`. Adding nested inputs and buttons will
require an accessible non-button container with separate selectable, editing,
add, and collapse controls.

### Treat relationship creation as search-first

When connecting a person or opportunity:

1. Choose or infer a compatible relationship type.
2. Search existing entities.
3. Create only when no appropriate match exists.
4. Capture relationship-specific context.

This reduces duplicate people, opportunities, and business units.

## Entity and Relationship Semantics

### Entity test

Create an entity when the concept has its own identity, lifecycle, context, or
relationships. Keep simple values as properties.

Examples:

- A strategic priority is an entity when many opportunities and business units
  support it.
- `high`, `medium`, and `low` remain attribute values.
- A project participant's role belongs on the relationship.
- A specialty becomes an entity only if it needs independent reuse and
  relationships.

### Initial Account Map schema

Initial entity types:

- Person
- Business Unit
- Project
- Initiative
- Opportunity
- Strategic Priority

Initial relationship types:

| Type | Source → target | Example metadata |
|---|---|---|
| `part-of` | Project → Initiative | order, rationale |
| `belongs-to` | Project → Business Unit | primary/secondary |
| `member-of` | Person → Business Unit | title, leadership status |
| `participant-in` | Person → Project | role, influence, dates |
| `specialist-for` | Person → Opportunity | specialty, allocation |
| `supports` | Opportunity/Project/BU → Priority | strength, rationale |
| `depends-on` | Project/Opportunity → Project/Opportunity | status |
| `related-to` | compatible entity → compatible entity | label, rationale |

The registry constrains compatible endpoint types and defines forward and
reverse labels. Initial users cannot create arbitrary schemas through the UI.

## Local Ideas and Formal Records

An opportunity may exist locally before a CRM record exists:

```text
idea → developing → qualified → formalized
                       └──────→ discarded
```

Several competing opportunity ideas may be developed under the same account or
priority. Formalization should link a resulting source record to the existing
local entity rather than replace it. Local history, notes, and relationships
remain intact.

External record creation and updates are outside the workspace. Scout or
another agent performs those actions with its own source-system integration.

## Offline Reference Imports

The workspace may import a spreadsheet containing CRM opportunities, people,
or other known records. This is a **reference import**, not synchronization.

The import:

- maps rows into local entities and source references;
- retains selected snapshot fields;
- records source file, sheet, row, and import time;
- matches repeat imports by source system, record type, and external ID;
- preserves local notes, relationships, and placements; and
- visibly communicates that imported fields may be stale.

The workspace never stores CRM credentials or calls CRM APIs as part of this
capability.

## Agent Handoff

The preferred integration is read-oriented:

1. A user selects entities or a saved view.
2. The workspace creates a bounded handoff bundle.
3. Scout retrieves the bundle through a narrow MCP tool or API.
4. Scout resolves current records using the included external IDs.
5. Scout previews and executes source-system changes using its own tools.

The graph artifact remains semantic. Source-system commands are separate action
requests and do not become part of the canonical graph.

Example:

> "Scout, use the stakeholder conclusions in this view to add updated notes to
> these three CRM opportunities."

## Product Research Lessons

The proposal borrows interaction patterns rather than attempting feature
parity with mature tools.

| Tool/category | Relevant lesson | Decision |
|---|---|---|
| XMind | Keyboard-first sibling/child creation, branch collapse, radial layout, branch identity | Adopt the fast-entry loop and selected visual patterns |
| Whimsical mind maps | Automatic layout keeps creation lightweight | Preserve automatic layout as the default |
| MindMeister | Planning artifacts can lead into task execution | Preserve explicit formalization/conversion boundaries |
| Obsidian Canvas / JsonCanvas | Open graph interchange is useful; free placement is not a hierarchy model | Consider JsonCanvas export later; do not adopt free-form semantics as the core |
| Mermaid mind maps | Text representations are portable and versionable | Support Markdown/Mermaid-style export later |
| Miro, tldraw, Excalidraw | Infinite whiteboards optimize for unconstrained spatial composition | Do not become a whiteboard or diagram suite |
| Homelable | Typed canvases benefit from lasso, alignment, semantic groups, visual zones, collapse rewiring, waypoints, saved designs, and presentation views | Adopt selected interaction mechanics; keep stable IDs, per-view state, keyboard parity, and Mission Control authorization |

References:

- [XMind](https://xmind.com/)
- [Whimsical Mind Maps](https://whimsical.com/mind-maps)
- [MindMeister Mind Mapping](https://www.mindmeister.com/pages/use-case/mind-mapping)
- [Obsidian Canvas](https://obsidian.md/canvas)
- [JsonCanvas 1.0](https://jsoncanvas.org/spec/1.0/)
- [Mermaid Mindmap Syntax](https://mermaid.js.org/syntax/mindmap.html)
- [React Flow Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes)
- [Homelable source analysis](../../../research/homelable-graph-ui-analysis.md)
- [Graph Workbench proposal](../graph-workbench.md)

## Decision Record

### D1. Genericize interaction primitives, not a universal graph platform

**Decision:** Extract only capabilities validated by Ideation and Account Map.

**Why:** A broad graph SDK would create speculative APIs and maintenance burden.

### D2. Support hierarchy and graph relationships together

**Decision:** Use a typed entity-and-relationship model with optional ordered
hierarchical views.

**Why:** Account relationships are network-shaped, while ideation and project
decomposition still benefit from a strong hierarchy.

### D3. Preserve outline editing as a first-class authoring mode

**Decision:** The outline edits a selected structural projection; it does not
attempt to display every graph edge as indentation.

**Why:** Text-first entry is one of the current feature's strongest advantages.

### D4. Separate entities from view placements

**Decision:** One entity may appear in multiple saved views or multiple
positions without being duplicated.

**Why:** A person may appear under a project, business unit, and opportunity.

### D5. Use typed relationships

**Decision:** Relationship definitions constrain endpoint types, direction,
labels, and allowed metadata.

**Why:** Completely arbitrary edges become inconsistent and difficult to query.

### D6. Store locally; source systems remain authoritative

**Decision:** Accept user-provided reference snapshots and IDs, but perform no
source-system reads, polling, synchronization, or writes.

**Why:** This retains downstream actionability without recreating connectors or
a CRM.

### D7. Separate artifact from action

**Decision:** The workspace exports or exposes semantic context. External agents
own execution requests and source-system operations.

**Why:** Modeling should remain useful and safe independently of integrations.

### D8. Use SQLite, not a graph database, initially

**Decision:** Store entities and edges relationally behind a graph repository
contract.

**Why:** Expected queries are bounded and workspace-sized. Operational and
consistency costs of another database are not justified.

### D9. Prefer agent connection over routine file export

**Decision:** Provide bounded MCP/API reads and handoff bundles. Keep versioned
JSON as the portable fallback.

**Why:** Connected retrieval is fresher, scoped, and less cumbersome.

### D10. Keep inferred relationships visibly provisional

**Decision:** LLM-derived entities and relationships enter a proposal/review
flow with confidence and evidence.

**Why:** Inference must never be visually indistinguishable from confirmed or
imported facts.

### D11. Build inside Mission Control first

**Decision:** Integrate the first implementation with existing MC storage,
design components, and agent infrastructure while maintaining module
boundaries suitable for later extraction.

**Why:** Ideation is the proven starting consumer and provides the fastest
validation path.

### D12. Validate one non-hierarchical consumer before further extraction

**Decision:** Account Map is the second proving use case.

**Why:** A second real consumer reveals which abstractions are genuinely shared.

## Explicit Non-Goals

Initial and medium-term non-goals:

- CRM pipeline, forecasting, activity, quoting, or campaign management
- Direct CRM or source-system reads and writes
- Generic connector, OAuth, polling, webhook, or synchronization framework
- Automatic multi-source identity resolution
- Field-level source-of-truth and conflict-resolution engine
- User-defined entity-schema designer
- General-purpose whiteboard or arbitrary diagramming suite
- UML, BPMN, fishbone, floor-plan, matrix, or presentation tooling
- Real-time multi-user collaboration or CRDT infrastructure
- Enterprise-wide knowledge graph analytics
- Autonomous LLM writes into canonical data
- Automatic formalization of provisional opportunities
- A graph database introduced solely because the data has edges
- Replacing the existing project graph or universe graph with the workspace

## Success Measures

Early validation should measure behavior rather than platform breadth:

- Time to create a 25-node ideation map
- Percentage of creation actions completed without leaving the keyboard
- Time to connect an imported opportunity to people, priorities, and projects
- Duplicate entity rate during account-map creation
- Percentage of imported rows successfully matched on repeat import
- Time required to produce a useful agent handoff
- User-reported confidence in distinguishing local, imported, and inferred data
- Continued successful conversion of Ideation documents into MC projects
