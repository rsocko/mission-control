---
title: "Structured Graph Workspace"
status: proposed
created: 2026-08-01
category: design
related:
  - "[Product and Decision Record](product-and-decisions.md)"
  - "[Architecture and Data Contracts](architecture.md)"
  - "[Phased Execution Plan](roadmap.md)"
  - "[Graph Visualization System](../../graph-visualization-system.md)"
  - "[Graph Workbench](../graph-workbench.md)"
  - "[Homelable Graph UI Source Analysis](../../../research/homelable-graph-ui-analysis.md)"
  - "[External Agent Integration](../external-agent-integration.md)"
  - "[Scout as Smart Connector](../scout-smart-connector.md)"
mockups: []
---

# Structured Graph Workspace

## Summary

The Structured Graph Workspace is a proposed local-first environment for:

- rapidly brainstorming in an outline or mind-map;
- creating typed entities and relationships;
- arranging the same information into hierarchical and network views;
- importing reference snapshots from user-provided spreadsheets;
- retaining external record identifiers without synchronizing source systems; and
- handing bounded, structured context to Scout or other external agents.

The proposal grows from the existing Ideation canvas, but it is intentionally
not a CRM, connector framework, enterprise knowledge graph, or general-purpose
diagramming suite.

The product thesis is:

> **Model locally, connect meaningfully, and hand off deliberately.**

Mission Control owns the thinking surface, local context, and structured
artifact. Source systems remain authoritative. External agents with their own
credentials and tools perform downstream reads or writes.

## Recommendation

Build this as an opinionated Mission Control capability first:

1. Make the existing Ideation canvas a complete editing surface.
2. Extract only the hierarchy and canvas primitives proven by Ideation.
3. Validate one non-hierarchical consumer: an Account Map with fixed entity and
   relationship types.
4. Add offline reference imports and read-oriented agent handoffs.
5. Consider a standalone package or application only after both consumers prove
   the shared contracts.

The underlying model may be extensible. The initial product surface must remain
narrow and use-case driven.

## Document Set

| Document | Purpose |
|---|---|
| [Product and Decision Record](product-and-decisions.md) | Product boundary, use cases, research lessons, decisions, alternatives, and non-goals |
| [Architecture and Data Contracts](architecture.md) | Canonical model, storage, views, imports, agent handoffs, deployment options, and graph database decision |
| [Phased Execution Plan](roadmap.md) | Validation gates, implementation phases, success criteria, risks, gaps, and open questions |
| [Graph Workbench](../graph-workbench.md) | Shared interaction modes, search/focus, saved-view behavior, accessibility, and UI mockups |

## Relationship to Existing Designs

This proposal complements rather than replaces the
[Graph Visualization System](../../graph-visualization-system.md):

- The existing system projects Mission Control projects, tasks, tags, and
  derived relationships for visualization.
- This proposal adds a user-authored workspace for local entities,
  relationships, structured views, and reference snapshots.
- The two may share bounded graph query and rendering primitives, but they
  should not share a feature store or force one domain model onto the other.

It also complements [External Agent Integration](../external-agent-integration.md):

- The workspace produces agent-ready context and source references.
- Scout or another agent resolves current source-system state and performs
  external actions.
- The workspace does not become a source-system connector.

## Terminology

| Term | Meaning |
|---|---|
| **Entity** | A stable, locally addressable concept such as a person, project, opportunity, initiative, priority, or business unit |
| **Relationship** | A typed connection between two entities, optionally carrying role or context |
| **Workspace** | A collection of entities, relationships, notes, and views created for a planning or reasoning purpose |
| **View** | A saved projection of workspace data, such as outline, mind-map, network, table, or radial view |
| **Placement** | The appearance and organization of an entity in a particular view |
| **Reference snapshot** | Selected fields and identifiers imported from a user-provided file; not a synchronized source record |
| **Handoff bundle** | A bounded, versioned context package exposed to an external agent |
| **Formalize** | Create or update a record in a source system through an external agent, outside the workspace core |

## Current Status

This is a design proposal. No implementation is authorized by these documents.
Each roadmap phase has an explicit validation and exit gate to prevent the
proposal from turning into an unbounded platform effort.
