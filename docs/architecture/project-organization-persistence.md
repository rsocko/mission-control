---
title: "Project Organization Persistence"
status: implemented
created: 2026-09-05
category: architecture
related:
  - "[Portable Persistence Boundaries](./persistence-boundaries.md)"
  - "[Project Hierarchy Persistence](./project-hierarchy-persistence.md)"
---

# Project Organization Persistence

## Outcome and scope

Project administration, phase lifecycle, rule-match previews, and list-group
organization now run through backend-neutral SQLite and PostgreSQL adapters.
The owned web surface is exactly:

- `src/app/api/hub-projects/route.ts`
- `src/app/api/hub-projects/[id]/route.ts`
- `src/app/api/hub-projects/[id]/rule-matches/route.ts`
- `src/app/api/project-phases/route.ts`
- `src/app/api/project-phases/[id]/route.ts`
- `src/app/api/list-groups/route.ts`
- `src/app/api/list-groups/[id]/route.ts`
- `src/app/api/list-groups/reorder/route.ts`

Phase AI refinement/suggestion, goals, quick-sort/task workflows, webhooks and
integrations, notifications and push, and finance remain outside this layer.
The existing L15 hierarchy item, membership, reorder, and command routes are
unchanged.

## Atomic composition

No runtime registry or backend selector was added. Two capabilities are nested
beside L15 hierarchy under the existing `projectAutomation` slot:

```text
owned routes
  -> project/list organization services
     -> getWorkerPersistenceRepositories()
        -> projectAutomation
           -> hierarchy                 (L15, unchanged)
           -> projectAdministration     (projects, phases, rule existence)
           -> listOrganization          (groups, source-list projection)
```

SQLite construction supplies all three SQLite capabilities and PostgreSQL
construction supplies all three PostgreSQL capabilities. Publication of the
worker composition remains atomic, so PostgreSQL mode cannot resolve a missing
sub-capability from SQLite. The clean services do not inspect environment
variables, import a backend adapter, hold a driver handle, or implement a
fallback.

## Contracts and behavior

`src/db/persistence/project-organization.ts` contains only Promise-based
operations and neutral domain values. It preserves:

- stable project, phase, group, source-list, and phase-item identities;
- parsed JSON arrays/objects and explicit nullability;
- project name ordering and phase `(sortOrder, createdAt, id)` ordering;
- phase-item `(sortOrder, createdAt, id)` ordering;
- the collection delete's membership-only behavior and the item delete's
  owned-hierarchy cascade;
- dependent-phase reassignment to `startAfterPhaseId = null` before phase
  deletion;
- source-list reassignment to no group before group deletion;
- append-at-maximum group creation and dense, caller-supplied group reordering;
- active top-level task counts keyed by connector and remote source-list
  identity; and
- deterministic project, task, and tag ordering before shared rule matching.

Project update validation remains shared through `parseHubProjectUpdate`.
Rule reevaluation still follows the authoritative project commit and remains
non-fatal, with `evaluationFailed` preserving the existing response contract.
Semantic publication also stays outside persistence transactions and uses the
already-composed semantic publication service.

## Transactions, ordering, and concurrency

SQLite mutations use short `BEGIN IMMEDIATE` transactions. Composite project,
phase-item, and list-organization reads use one deferred snapshot where more
than one table is involved. SQLite `BINARY` ordering and shared JavaScript tie-breakers define the returned
order.

PostgreSQL mutations use bounded SERIALIZABLE transactions and retry only
SQLSTATE `40001` or `40P01`. Project mutations use the same
`pg_advisory_lock(hashtext(projectId))` namespace as rule evaluation and L15.
Phase mutations first serialize against the phase-administration gate, then
take transaction-scoped locks in the existing project namespace for the
current, target, and dependency projects. This prevents a phase move or delete
from racing an L15 hierarchy command while preserving trigger-driven
`hierarchyRevision` advancement and optimistic CAS conflicts. List-group
mutations use one dedicated list-organization advisory namespace so concurrent
append/reorder/delete operations cannot interleave.

PostgreSQL composite reads use REPEATABLE READ READ ONLY. Every text tie-breaker
that affects response or rule-match order uses `COLLATE "C"`, matching SQLite
byte ordering. Driver errors are never translated into success-shaped results;
transactions roll back and the existing route-level `ApiErrors` mapping
remains authoritative.

## Graph decrement and proof

The exact graph moved from
`266/121/13/132/91/30/92/61/0/182` to
`266/113/13/140/83/30/84/61/0/174` for API routes, Tier A, Tier B, clean,
direct taint, transitive-only taint, direct `@/db`, tainted libraries, tainted
API helpers, and migration units respectively. All eight owned routes moved
from Tier A to clean; no route moved to Tier B.

Proof is split across one shared repository contract, SQLite and live
PostgreSQL runners, PostgreSQL concurrency/CAS checks, a poisoned-SQLite import
and route execution proof, route compatibility tests, and the L18 architecture
ratchet. `tests/architecture/web-persistence-baseline.json` records the exact
decrement.
