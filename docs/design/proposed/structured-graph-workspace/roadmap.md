---
title: "Structured Graph Workspace — Phased Execution Plan"
status: proposed
created: 2026-08-01
category: planning
related:
  - "[Structured Graph Workspace](README.md)"
  - "[Product and Decision Record](product-and-decisions.md)"
  - "[Architecture and Data Contracts](architecture.md)"
---

# Structured Graph Workspace — Phased Execution Plan

## Planning Principles

1. Improve the proven Ideation workflow before extracting abstractions.
2. Require a second concrete consumer before creating a shared toolkit.
3. Keep source-system integration outside the workspace.
4. Place review boundaries around imports and AI proposals.
5. Use phase exit criteria to stop platform expansion.
6. Preserve current Ideation behavior and project conversion throughout.

All estimates are rough engineering ranges for planning, not commitments.

## Phase Overview

| Phase | Outcome | Rough effort | Decision gate |
|---|---|---:|---|
| 0 | Validate jobs, terminology, and sample data | 2–4 days | Is Account Map a real recurring workflow? |
| 1 | Make Ideation canvas a complete editor | 3–5 days | Does canvas editing materially improve creation speed? |
| 2 | Extract proven structured-hierarchy primitives | 1–2 weeks | Are the seams stable without graph over-abstraction? |
| 3 | Build local Account Map MVP | 2–3 weeks | Do typed network views provide repeatable value? |
| 4 | Add offline reference import | 1–2 weeks | Does reference data improve mapping enough to maintain? |
| 5 | Add bounded Scout/agent handoff | 1–2 weeks | Can an agent act reliably from selected graph context? |
| 6 | Evaluate packaging or standalone deployment | discovery | Is there a second host or independent lifecycle? |

## Phase 0 — Product Validation and Contract Spikes

### Goal

Validate the bounded product before adding a general graph schema.

### Work

- Gather two or three representative account-planning examples.
- Build a sample entity and relationship catalog using the proposed fixed
  Account Map types.
- Identify one realistic CRM spreadsheet export and its stable identifier
  columns.
- Define the first relationship registry.
- Prototype a handoff bundle from a manually authored sample.
- Confirm terminology: workspace, entity, relationship, view, reference import,
  and handoff.
- Decide whether Account Map lives under Graph, Projects, or a new Workspaces
  navigation entry for the pilot.

### Exit criteria

- At least one real planning exercise cannot be represented cleanly by the
  existing Ideation hierarchy alone.
- The fixed initial entity and relationship types represent the exercise
  without a user-defined schema.
- A useful downstream agent instruction can be expressed using a bounded
  selected subgraph.
- Stakeholders agree that source-system synchronization is not part of the MVP.

### Stop conditions

- The only desired outcome is CRM pipeline management.
- Users primarily need a whiteboard rather than structured entities.
- A spreadsheet and ordinary notes already satisfy the workflow with little
  friction.

## Phase 1 — Ideation Canvas Editing

Tracking issue:
[#2216](https://github.com/rsocko/mission-control/issues/2216)

### Goal

Close the highest-value operational gaps identified through mind-map tool
comparison.

### Deliverables

- Inline label editing on canvas nodes
- Accessible adjacent `+` child control
- Keyboard-first creation:
  - `Enter` sibling
  - `Tab` child behavior as resolved in Phase 0
  - `Shift+Tab` outdent
  - `Escape` cancel
  - arrows navigate
- Collapse/expand with hidden descendant count
- Animated deterministic reflow
- Lasso and multi-selection
- Cursor-centered copy/paste
- Alignment guides with drag-stop snapping and an Alt-key bypass
- Focus-visible and touch-safe controls
- One shared undo path
- Tests for keyboard, focus, add, edit, collapse, and undo behavior

### Implementation notes

- Refactor `MindMapCard` away from a single outer `<button>` before nesting
  interactive controls.
- Use React Flow's non-drag/non-pan classes for inputs and controls.
- Keep temporary editing and collapse state out of semantic persistence.
- Route committed changes through existing store commands.

### Exit criteria

- A user can create and edit a 25-node map entirely from the canvas and
  keyboard.
- The outline and canvas remain synchronized.
- Existing AI expansion and Convert to Project behavior still work.
- Accessibility tests cover keyboard entry and focus.

### Explicitly excluded

- Account entities
- Cross-link edge creation
- New persistence schema
- Radial layout
- Shared graph toolkit

## Phase 2 — Structured Hierarchy Foundation

### Goal

Extract only the primitives proven by the improved Ideation experience.

### Deliverables

- Versioned hierarchy document contract
- Pure ordered-tree command functions
- Extracted hierarchy layout module
- Reusable canvas keyboard controller
- Configurable node renderer boundary
- JSON and nested-Markdown export
- Migration adapter for current Ideation documents
- Domain adapter retaining idea/phase/task behavior

### Candidate seams

- `layoutMindMap`
- `buildIdeationTree`
- descendant and cycle validation
- add/move/indent/outdent/delete commands
- selection and history behavior
- canvas node rendering contract

### Exit criteria

- Ideation is a thin domain consumer of the extracted hierarchy primitives.
- No Account Map-specific concept appears in the hierarchy core.
- Existing Ideation tests remain valid or have equivalent migrated coverage.
- Versioned JSON round-trips without semantic loss.

### Decision gate

Review the extracted API before proceeding. If it is dominated by Ideation-only
callbacks or configuration, stop extraction and keep the feature local.
Account Map should then build its canvas and layout as a feature-local
implementation in Phase 3. Shared extraction is reconsidered only after the two
independent implementations reveal genuinely common contracts.

## Phase 3 — Account Map MVP

Tracking issue:
[#2213](https://github.com/rsocko/mission-control/issues/2213)

### Goal

Validate a typed non-hierarchical consumer without building a generic schema
platform.

### Deliverables

- SQLite graph workspace repository
- Fixed Account Map entity registry
- Fixed relationship registry
- Entity create, edit, archive, and search
- Relationship create, edit, and delete
- Relationship metadata inspector
- Search-before-create flow
- Manual and force-directed network views
- Hierarchical/radial view when a primary relationship is selected
- Saved views and placements
- Per-view collapse defaults and optional manual edge routes
- One/two-hop expansion with relationship-type filters
- Local opportunity lifecycle
- Graph JSON export

### Suggested initial entity types

- Person
- Business Unit
- Project
- Initiative
- Opportunity
- Strategic Priority

### Exit criteria

- A real account-planning example can be represented without duplicate
  canonical entities.
- One person or opportunity can appear meaningfully in several saved views.
- Users can distinguish hierarchy edges from secondary relationships.
- Graph operations remain responsive at the agreed pilot size.
- No source-system credentials or connector code are introduced.

### Explicitly excluded

- Spreadsheet import
- Source synchronization
- User-defined entity schemas
- CRM record creation
- Agent writes
- Graph analytics

## Phase 4 — Offline Reference Import

### Goal

Use user-provided source snapshots to reference existing formal records without
creating a connector.

### Deliverables

- CSV/XLSX upload
- Column and sheet mapping
- Saved mapping template for one CRM export
- Staged `GraphChangeSet`
- Match/new/ambiguous/invalid preview
- Idempotent matching by external reference
- Transactional apply
- Import batch history
- Visible source and snapshot-age badges
- Repeat import preserving local data
- Entity/relationship XLSX export for inspection

### Exit criteria

- Re-importing the same file does not duplicate entities or relationships.
- Changed snapshot fields refresh while local notes and graph links remain.
- Ambiguous names require human resolution.
- The UI never implies that imported snapshot fields are live.
- No source API call occurs during import or use.

### Explicitly excluded

- Scheduled import
- CRM authentication
- Polling or webhooks
- Automatic source deletion propagation
- Generic field-level conflict policies

## Phase 5 — Agent-Ready Context and Scout Handoff

### Goal

Allow external agents to retrieve a selected, bounded graph context and use
source references in their own workflows.

### Deliverables

- Handoff creation and preview UI
- Versioned `GraphHandoffBundle`
- Scoped, expiring handoff ID
- Read-oriented MCP/API tools:
  - search entities
  - get entity
  - get view
  - get bounded subgraph
  - get handoff
- Selection and relationship budgets
- Audit metadata for bundle generation and retrieval
- Manual JSON/Markdown handoff fallback
- Example Scout workflow for updating notes on selected CRM opportunities

### Agent boundary

Scout:

- resolves current source records;
- handles credentials and authorization;
- retrieves current source state;
- previews proposed changes;
- performs source-system writes; and
- reports receipts or failures.

The workspace:

- provides local entities, notes, relationships, and source references;
- does not validate current CRM state;
- does not execute CRM commands; and
- does not claim external updates succeeded.

### Exit criteria

- Scout can identify the intended formal records from a selected handoff.
- Missing or ambiguous references fail safely.
- The user can inspect exactly what graph context is shared.
- The bundle excludes unrelated workspace data.
- No unrestricted graph-write or source-write MCP tool is added.

## Phase 6 — Portability and Deployment Evaluation

### Goal

Decide whether the capability should remain integrated, become an internal
package, or live as a standalone local application.

### Evaluation questions

- Does a second application need the graph workspace without Mission Control?
- Do Account Map workspaces have a materially different lifecycle or access
  model from MC tasks and projects?
- Are the shared contracts stable across Ideation and Account Map?
- Is independent deployment worth the operational cost?
- Would a standalone application still need Mission Control for its primary
  workflows?

### Possible outcomes

#### Remain integrated

Appropriate if Mission Control remains the main surface and consumer.

#### Extract internal package

Appropriate if several MC features share stable headless commands, contracts,
and renderers.

#### Standalone local application

Appropriate only if the workspace has independent users, deployment, access, or
product lifecycle. It should use its own database and integrate through
versioned APIs, MCP, and exports rather than shared tables.

## Deferred Advancement Backlog

Only consider these after phases 0–5 demonstrate sustained use:

- radial and clustered layout refinements;
- branch coloring and richer notes;
- cross-workspace entity catalogs;
- paste indented text or Markdown as a branch;
- JsonCanvas, Mermaid, OPML, or XMind interchange;
- scoped read-only presentation links;
- advanced edge waypoints and endpoint reconnection;
- LLM extraction into reviewed change sets;
- AI duplicate and missing-link suggestions;
- AI reorganization and account briefing;
- project round-trip restructuring through existing hierarchy commands;
- temporal relationship validity;
- graph comparison and change visualization;
- optional action receipts returned by agents;
- bounded graph analytics;
- real-time collaboration; and
- graph-specific storage if measured workloads justify it.

## Current Gaps

| Gap | Consequence | Earliest phase |
|---|---|---|
| `IdeationCanvas.tsx` combines rendering, AI, conversion, editing, and layout | Extraction is risky until seams are established | 1–2 |
| Canvas cards are not direct editors | Mind-map feels secondary to outline | 1 |
| Current Ideation persistence is browser-local | Cannot support durable shared entity references | 3 |
| Current ideation model is an ordered tree | Cannot represent arbitrary typed relationships | 3 |
| Shared graph types describe MC projections, not user-authored workspaces | Reusing them directly would import irrelevant complexity | 2–3 |
| No entity identity or duplicate-resolution flow | Account imports could create duplicate people/opportunities | 3–4 |
| No import/change-set review surface | Spreadsheet and LLM ingestion would be unsafe | 4 |
| No graph handoff contract or scoped MCP reads | Agent context would require manual copy/paste or broad access | 5 |
| MC's local graph routes lack a general user authorization model | Standalone or multi-user use needs policy hooks | 5–6 |
| No validated Account Map dataset | Product value remains hypothetical | 0 |

## Key Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Feature creep from mature mind-map and whiteboard tools | Product becomes an unfocused diagram suite | Maintain explicit Adopt now/Later/Avoid decisions |
| Recreating CRM concepts | MC becomes responsible for pipeline and source truth | Keep source reads/writes and commercial workflow outside the core |
| Premature genericization | Complex APIs without proven consumers | Require Ideation plus Account Map before package extraction |
| Entity duplication | Graph becomes untrustworthy | Search-first creation, stable external IDs, manual ambiguity review |
| Confusing placement with semantic relationship | Moving a card changes business meaning unexpectedly | Distinguish view commands from semantic relationship commands |
| Stale imported snapshots | Users mistake old data for live CRM state | Show source and import timestamp; call the feature reference import |
| LLM hallucinated links | Inferred edges appear factual | Proposal status, confidence, evidence, and approval |
| Canvas complexity harms accessibility | Keyboard and screen-reader users lose functionality | Accessible controls, focus model, outline parity, automated tests |
| Layout instability at scale | Nodes jump or become unreadable | Deterministic layout first, budgets, profiling, progressive expansion |
| Sensitive account data leaks through handoff | Privacy and authorization failure | Explicit selection, bounded bundles, scopes, expiration, audit |
| Standalone and integrated implementations diverge | Duplicate product and maintenance cost | Share contracts only after validation; avoid shared live database |
| SQLite is assumed adequate without measurement | Late performance surprise | Add representative scale tests and graph-storage transition triggers |

## Outstanding Questions

### Product

1. What should the feature be called: Structured Graph Workspace, Relationship
   Workspace, Account Map, or another name?
2. Is Account Map the correct second consumer, and who is its primary user?
3. Which two real planning exercises will validate Phase 0?
4. Should local opportunities be workspace-scoped or reusable across several
   workspaces?
5. Which relationship metadata is essential versus optional for the first
   Account Map?

### Interaction

6. Should `Tab` create a child consistently in both outline and canvas, changing
   the outline's current indent behavior?
7. Should a single click or double-click enter canvas label editing?
8. When should dragging modify semantic hierarchy versus placement only?
9. How should repeated entity placements be represented in the outline?
10. Which layout should be the Account Map default: force, radial, or manual?

### Data

11. Are entities isolated per workspace, or should a later local catalog allow
    reuse across workspaces?
12. What is the deletion policy for entities referenced by several views?
13. Should raw imported files be retained, encrypted, or discarded after
    successful application?
14. Which fields from a CRM export are safe and useful to retain as snapshots?
15. How should a local opportunity be linked to an imported formal opportunity
    without losing history?
16. Which hierarchy operations update semantic `part-of` relationships?
17. Can an Account Map project or task entity reference a canonical Mission
    Control record in the MVP, and what does Convert to Project establish?

### Agent integration

18. Should handoffs be stored snapshots or generated from a workspace revision
    when retrieved?
19. What authorization and expiration model should scoped handoff IDs use?
20. Should agents be allowed to return action receipts into the workspace?
21. Should an agent be able to propose local graph updates, or remain read-only
    in the initial release?

### Deployment

22. Where should the integrated feature live in Mission Control navigation?
23. What concrete event would trigger extraction into an internal package?
24. What independent user or deployment need would justify a standalone app?
25. Should a standalone deployment use MCP as its primary MC integration?

## Required Design Spikes

Before Phase 3:

- Prototype entity placement reuse across two views.
- Test deterministic and force layouts with representative account maps.
- Demonstrate hierarchy-plus-cross-link rendering without visual overload.
- Define cycle and cardinality validation for the initial relationship registry.

Before Phase 4:

- Test a real CRM spreadsheet mapping.
- Define import fingerprinting and repeat-import semantics.
- Decide raw file retention.

Before Phase 5:

- Threat-model graph handoff access.
- Validate the handoff payload against a real Scout workflow.
- Define bundle size and traversal budgets.

## Review and Governance

At every phase boundary:

1. Review actual usage and success measures.
2. Confirm that source-system synchronization remains outside scope.
3. Remove abstractions unused by both active consumers.
4. Update the decision record and open questions.
5. Require explicit approval before entering the next phase.
