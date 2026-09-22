---
title: "Project Hierarchy Persistence"
status: implemented
created: 2026-09-04
category: architecture
related:
  - "[Portable Persistence Boundaries](./persistence-boundaries.md)"
  - "[Data Model](./data-model.md)"
---

# Project Hierarchy Persistence

## Outcome

The project-hierarchy command/read boundary — project/task membership in a hub
project, task placement and ordering within project phases, phase-item
metadata, hierarchy snapshots, optimistic revision fencing, and the durable
idempotent command/inverse-command audit — runs identically on SQLite and
PostgreSQL.

Four API routes and one library left import-time SQLite taint:

| Path | Before | After |
| --- | --- | --- |
| `src/app/api/hub-projects/[id]/tasks/route.ts` | Tier A (transitive) | clean |
| `src/app/api/project-phases/[id]/items/route.ts` | Tier A (direct `@/db`) | clean |
| `src/app/api/project-phases/[id]/items/reorder/route.ts` | Tier A (transitive) | clean |
| `src/app/api/projects/[id]/hierarchy/route.ts` | Tier A (transitive) | clean |
| `src/lib/projects/hierarchy-service.ts` | tainted `src/lib` module | clean |

`src/app/api/graph/universe/clusters/save/route.ts` is only a compatibility
call site. Its hierarchy snapshot call became awaited; it stays Tier A because
it still owns unrelated direct task, tag, project, and audit persistence.

## Composition

No runtime slot, publication mechanism, or central backend registration was
added. The hierarchy capability is nested on the already-composed
`projectAutomation` worker repository:

```text
four owned route handlers
  -> src/lib/projects/hierarchy-service.ts
     -> TaskCore mutation-policy preflight (L05/L07)
     -> getWorkerPersistenceRepositories()
        -> projectAutomation.hierarchy
           -> src/db/persistence/sqlite-project-hierarchy-repository.ts
           -> src/db/postgres/repositories/project-hierarchy-repository.ts

both adapters
  -> src/lib/projects/hierarchy-transitions.ts (one shared pure planner)
  -> backend-owned short transaction and row mapping
  -> durable command/result audit
```

Nesting is deliberate: hierarchy commands and automatic rule evaluation mutate
the same `task_projects` and `project_auto_include_exclusions` rows, so they
must share one backend selection and one per-project serialization namespace.

## Backend-neutral contract

`src/db/persistence/project-hierarchy.ts` declares `ProjectHierarchyPersistence`
as an operation-shaped contract, not a query facade:

- `getSnapshot(projectId)`
- `findCommittedCommand(commandId)`
- `applyAuthorizedCommand(input)`
- `findPhaseProjectId(phaseId)`
- `listPhaseItems(phaseId)`
- `findPhaseItemTask(phaseId, itemId)`

It carries only opaque string IDs, ISO timestamps, numbers, booleans,
`ProjectHierarchyCommandRequest` / `ProjectHierarchyCommandResult` /
`ProjectHierarchySnapshot`, and `ProjectHierarchyServiceError`. No driver,
transaction handle, SQL fragment, table row, or backend selector crosses it.
`ProjectHierarchyServiceError` lives in the contract and is re-exported by the
service, so adapters, planner, service, and routes all share one `instanceof`,
`status`, `code`, and optional current-snapshot shape without an import cycle.

## Shared transition planner

`src/lib/projects/hierarchy-transitions.ts` is a pure, in-memory planner. Given
an authoritative snapshot, the membership/exclusion state of the referenced
tasks, a timestamp, and an item-ID source, it returns `{ changed,
inverseCommand, mutations }`. It owns, exactly once:

- validation of project membership, phase ownership, duplicate phase
  assignment, and `fromPhaseId` source expectations;
- dense order calculation;
- phase-item ID and metadata preservation when moving;
- membership/exclusion derivation;
- inverse-command derivation for all seven command types; and
- the changed versus no-op distinction.

Adapters execute the returned row-level mutations in order and carry no command
semantics. Membership mutations are always emitted before the phase-item
inserts they authorize, so the membership integrity trigger can never observe
an orphaned item.

## Idempotency and canonical replay

The command ID is the idempotency key and the audit primary key. Replay is
resolved before the task-source policy preflight, so a committed command keeps
returning its original result even after a later policy change; the adapter
repeats the same check inside its transaction.

PostgreSQL `jsonb` reorders object keys and drops `undefined` members, so
request comparison is **canonical structural equality**
(`sameProjectHierarchyRequest`), never serialized-byte equality. Key order,
absent keys, and explicitly-`undefined` keys are equivalent; arrays stay
order-sensitive and `null` is never confused with an absent key. Reusing a
command ID with an equivalent request on the same project returns the first
committed result; any other reuse is `409 COMMAND_ID_CONFLICT`.

## Transactions, locking, and fencing

Shared guarantees on both backends:

- the command result is committed atomically with its mutations and audit row;
- exact replay returns the original persisted result, including no-op results;
- `expectedRevision` is checked against the locked authoritative project row;
- two different commands from one base revision produce one winner and one
  `409 HIERARCHY_REVISION_CONFLICT`;
- `fromPhaseId` fences stale phase-scoped remove/reorder commands;
- membership, phase ownership, one-phase-per-project, dense order, exclusions,
  the inverse command, and the audit row are one transaction; and
- retry processing re-reads command and revision state and never applies a
  stale in-memory plan.

**SQLite.** The backend-owned `better-sqlite3` handle is used only inside the
adapter. Command application runs in one short `BEGIN IMMEDIATE` transaction;
snapshot reads use a deferred transaction. The existing
`project_hierarchy_mutation_context` row is inserted and deleted around the
mutations so the SQLite revision triggers do not double-increment an
adapter-owned command.

**PostgreSQL.** A pool/client is used only inside the adapter. The adapter
acquires the same session-level `pg_advisory_lock(hashtext(projectId))`
namespace already used by project automation *before* opening a SERIALIZABLE
transaction and always unlocks in `finally`. The project row, phases, phase
items, task-membership rows, exclusion rows, and task rows are locked `FOR
UPDATE` before the transition is derived. Only SQLSTATE `40001` and `40P01`
retry, bounded to three attempts, and every attempt reloads command and
revision state from scratch. A command-ID unique violation is handled only
after the aborted transaction has rolled back: the winner is re-read in a fresh
read and returned only for canonical exact replay. Text tie-breakers that
affect snapshot order, index calculation, and inverse commands use
`COLLATE "C"`.

## Trigger parity migration

The initial PostgreSQL schema created the hierarchy tables but not the SQLite
hierarchy triggers, and already-portable project automation and task-core code
also writes `task_projects`, `project_phases`, and `project_phase_items`
outside the hierarchy adapter. `drizzle/postgres/0004_project_hierarchy_integrity.sql`
therefore ports the 17 SQLite triggers (and their supporting functions) 1:1:

- one phase per task within a project on phase-item insert/update;
- project membership for phase-item insert/update;
- phase reparenting guards;
- phase-item removal when project membership is deleted or repointed;
- `hub_projects.hierarchy_revision` advancement for out-of-band phase,
  phase-item, and task-project insert/update/delete; and
- suppression of those trigger-driven increments while an adapter-owned command
  holds a `project_hierarchy_mutation_context` row, so a command advances the
  revision exactly once.

The migration is additive correctness parity: it adds no table, column, index,
backfill, or cutover step, and no Drizzle snapshot changes because triggers and
functions are not represented by the schema DSL.

## API compatibility and I/O boundary

Request bodies, response bodies, status codes, and error mappings are
unchanged: `400` validation, `403 TASK_MUTATION_BLOCKED`, `404` project / task
/ phase / item failures, and `409` command, revision, and source conflicts.
Omitted `phaseId` still differs from explicit `null`, a no-op command is still a
durable idempotent audit at the unchanged revision, and phase-item response
fields are unchanged. `project-phases/[id]/items` now serves its list and item
lookup from `listPhaseItems` / `findPhaseItemTask`, and both hierarchy snapshot
call sites await. Unexpected failures still go through `ApiErrors.internal`; no
SQL text, database code, command JSON, task-source metadata, or connector
configuration is returned or logged.

No remote, network, or provider I/O occurs inside a hierarchy transaction.
Task-source mutation policy is read before the adapter transaction through the
portable TaskCore boundary; the adapter re-validates task existence, project
membership, phase ownership, command identity, and the hierarchy revision under
lock. Routes perform only request parsing, response mapping, and service calls.
This layer does not modify task rows, does not take ownership from L05/L07, and
does not emit semantic publication.

## Graph decrement

| Measure | Before | After | Delta |
| --- | ---: | ---: | ---: |
| API routes | 266 | 266 | 0 |
| Tier A routes | 190 | 186 | -4 |
| Tier B routes | 26 | 26 | 0 |
| Clean routes | 50 | 54 | +4 |
| Direct-taint-source routes | 125 | 124 | -1 |
| Transitive-only Tier A routes | 65 | 62 | -3 |
| Direct `@/db` namespace routes | 126 | 125 | -1 |
| Tainted `src/lib` modules | 86 | 85 | -1 |
| Tainted API helpers | 1 | 1 | 0 |
| Total migration units | 277 | 272 | -5 |

No Tier-B route, tainted library, tainted API helper, static source, dynamic
source, or direct database-namespace import was added, and no route was
reclassified from Tier A to Tier B.

## Proofs

- `tests/contracts/project-hierarchy-repository.contract.ts` — one behavioural
  contract run against both adapters.
- `tests/db/sqlite-project-hierarchy-repository.test.ts` — SQLite contract run.
- `tests/db/postgres-project-hierarchy-repository.integration.test.ts` — live
  PostgreSQL contract run plus concurrency, project-automation serialization,
  out-of-band trigger, placement-guard, and mutation-context suppression
  proofs. Gated on `MC_TEST_POSTGRES_URL` and the shared safe-target guard.
- `tests/db/postgres-project-hierarchy-poisoned.test.ts` — every handler on the
  four owned routes plus the clean service, run against a PostgreSQL-shaped
  composition with a throwing `@/db`.
- `tests/api/project-phases.test.ts` — phase-item route compatibility.
- `tests/projects/hierarchy-service-integration.test.ts` and
  `tests/projects/hierarchy-entry-points-integration.test.ts` — SQLite
  regression for the service and the mutation entry points.
- `tests/db/postgres-schema.test.ts` — migration `0004` inventory, trigger-name
  parity with the SQLite migration, and additive-only assertions.
- `tests/architecture/project-hierarchy-taint-decrement.test.ts` — owned
  route/library cleanliness, adapter/driver confinement, shared-planner use,
  and the monotonic L15 migration-unit ceiling. The PostgreSQL route sentinel
  owns the exact current graph.
