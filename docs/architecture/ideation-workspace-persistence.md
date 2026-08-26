---
title: "Ideation Workspace Persistence"
status: implemented
created: 2026-08-14
category: architecture
related:
  - "[Structured Graph Workspace](../design/proposed/structured-graph-workspace/README.md)"
  - "[Architecture and Data Contracts](../design/proposed/structured-graph-workspace/architecture.md)"
  - "[Portable Persistence Boundaries](./persistence-boundaries.md)"
  - "[Issue #1324](https://github.com/rsocko/mission-control/issues/1324)"
---

# Ideation Workspace Persistence

## Outcome

Ideation workspaces are named, server-persisted, versioned documents. The
implementation replaces the single browser-local working copy while preserving
the existing outline, mind-map, undo, AI expansion, and Convert to Project
flows.

Users can:

- create, rename, duplicate, archive, restore, and delete workspaces;
- switch among active workspaces;
- import and export the canonical JSON document;
- import and export the intentionally lossy text outline;
- inspect and restore server checkpoints; and
- recover local edits after a concurrent change or failed save.

## Boundary

This is the first persistence implementation behind the structured graph
workspace boundary. It is intentionally scoped to user-authored Ideation
artifacts. It does not become the canonical store for Mission Control projects,
tasks, Universe, tags, or other projected graphs.

```text
Ideation canvas
      |
      v
Versioned Ideation document contract
      |
      v
IdeationWorkspaceRepository
      |
      v
SQLite workspace + checkpoint tables
```

The Promise-based repository interface follows the shared portable persistence
rules. SQLite owns row mapping, JSON serialization, compare-and-swap SQL, and
atomic checkpoint writes; the application service and routes depend only on the
repository port. This keeps SQLite replaceable without introducing a generic
graph platform before a second authored consumer proves that broader contract.

## Canonical document

The portable document is validated at every server write:

```typescript
interface IdeationWorkspaceDocument {
  schemaVersion: 1;
  type: 'ideation';
  nodes: IdeationNode[];
}
```

Validation limits payload size and requires:

- one root;
- unique node IDs;
- valid parent IDs;
- an acyclic hierarchy;
- known node kinds and property keys; and
- bounded labels, values, tags, and node count.

The document preserves all current Ideation properties, including notes, tags,
`depends-on`, and `related`. JSON import/export is the lossless interchange
format. Text interchange preserves hierarchy, labels, node types, priority, and
tags; the UI warns before using it because the remaining properties cannot
round-trip through the existing outline syntax.

## Storage

`graph_workspaces` stores:

- workspace identity and name;
- artifact type and schema version;
- current content revision and canonical document;
- archive state;
- an optional one-time migration source marker; and
- creation and update timestamps.

`graph_workspace_versions` stores immutable, restorable checkpoints. Creating,
importing, migrating, and restoring always writes a checkpoint. Autosave writes
the current document on every successful save but materializes at most one
routine checkpoint per five-minute interval. This separates concurrency
correctness from history volume.

Deleting is a deliberate destructive operation:

1. archive the workspace;
2. explicitly delete it; and
3. cascade its checkpoints.

## Concurrency and autosave

Content writes use compare-and-swap semantics:

```text
PATCH(baseRevision, document)
  current revision matches -> write revision + 1
  current revision differs -> 409 + current server document
```

Metadata changes do not increment the content revision, so a rename or archive
does not create a false content conflict.

The client:

- debounces edits;
- permits only one save request in flight;
- coalesces edits made during that request;
- flushes or cancels pending work before switching;
- pauses after any save error; and
- never silently retries a conflict over the server document.

Conflict recovery offers two explicit choices:

- load the current server copy; or
- create a new workspace from the local draft and switch autosave to that copy.

The same flush boundary runs before Convert to Project so project metadata
references the persisted source workspace and revision used for the handoff.

## Local draft migration

On first load, the client checks `mission-control:ideation`.

1. Validate the existing Zustand payload as a version 1 document.
2. Copy the untouched payload to
   `mission-control:ideation:recovery` if no recovery copy exists.
3. Create a workspace using `mission-control:ideation` as an idempotent
   migration source.
4. After the server confirms success, write a migration-complete marker and
   remove the old active key.

The database has a unique migration-source index. Concurrent tabs therefore
resolve to one migrated workspace. The recovery payload remains available after
success and invalid drafts are never removed.

## Security and privacy

Workspace mutation routes require either:

- a same-origin browser request; or
- a valid Mission Control API key.

Inputs are schema-validated and bounded before persistence. Errors do not log
workspace contents. Reads and storage remain inside Mission Control's current
deployment and database trust boundary; a future multi-user deployment must
add owner/tenant columns and authorization policy before exposing these
artifacts across identities.

## API

| Route | Purpose |
|---|---|
| `GET/POST /api/ideation/workspaces` | List or create/import/migrate |
| `GET/PATCH/DELETE /api/ideation/workspaces/:id` | Load, save, rename, archive, or delete |
| `POST /api/ideation/workspaces/:id/duplicate` | Duplicate as an active workspace |
| `GET /api/ideation/workspaces/:id/versions` | List bounded checkpoint metadata |
| `GET /api/ideation/workspaces/:id/versions/:revision` | Inspect one complete checkpoint |
| `POST /api/ideation/workspaces/:id/versions/:revision` | Restore as a new latest revision |

## Deferred work

- Multi-user ownership and tenant authorization, pending a product-wide
  identity model.
- Real-time collaboration or automatic merging; optimistic concurrency is the
  deliberate first implementation.
- ID-based relationship edges. Current `depends-on` and `related` properties
  retain the existing label-reference semantics.
- Diffs between checkpoints and user-authored checkpoint names.
- Extracting graph workspace storage into a package or service before a second
  authored consumer demonstrates a stable independent lifecycle.
