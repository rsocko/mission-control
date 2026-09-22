---
title: "Graph and Reporting Persistence"
status: active
created: 2026-09-05
last_reviewed: 2026-09-05
category: architecture
related:
  - "[Portable Persistence Boundaries](./persistence-boundaries.md)"
---

# Graph and Reporting Persistence

## Boundary

`WorkerPersistenceRepositories.graphReporting` is the single startup-selected
capability for Universe, node-neighbor, project-graph, project-dependency,
projects-overview, burn-report, and Universe cluster-save persistence. Its
contract contains only plain values and operation results. Driver handles,
transactions, Drizzle tables, and SQL fragments remain inside the SQLite and
PostgreSQL adapters.

The method groups are:

- `universe`: canonical-filtered task/tag/project rows and eligible task IDs;
- `neighbors`: aggregate centers, visible task neighborhoods, memberships,
  explicit dependencies, semantic task hydration, and deleted connector IDs;
- `projects`: project graph rows plus validated dependency create/delete context;
- `overview`: visible projects, top-level task inputs, memberships, and tags;
- `burn`: validated project/phase scope, historical members, ordered transitions,
  and task lifecycle rows; and
- `clusterSave`: project/tag existence, atomic tag creation/removal, and batch
  audit recording.

Graph construction, query validation, filtering input parsing, semantic search,
burn reconstruction, overview reduction, cluster orchestration, and connector
dependency synchronization remain application-service responsibilities.

## Dialect parity

SQLite JSON text and integer booleans are normalized before crossing the
contract. PostgreSQL `jsonb` and native booleans are returned in the same
shapes. Observable text orders use an explicit ID tiebreaker; raw PostgreSQL
queries use `COLLATE "C"` where byte ordering matters.

Read models remain non-transactional and therefore retain their former
read-committed, non-snapshot behavior. Dependency creation is one
validate-and-insert operation. SQLite uses an immediate transaction.
PostgreSQL uses a transaction-scoped advisory lock over the global dependency
graph, with the unique edge constraint as the concurrent duplicate backstop.
Connector synchronization remains after commit.

Dependency deletion remains remote-first: the adapter validates existence and
scope, then the existing synchronization manager performs remote removal and
the final local delete. Cluster project saves retain create/assign/compensating
delete behavior. A per-request creation token and adapter-owned conditional
delete ensure a losing concurrent project create never compensates by deleting
the winning request's project, including across delete/recreate races.
Cluster tag saves retain independent per-task assignment, partial results, and
a post-success batch audit.

## Scope and evidence

Task relationship routes, broad tag APIs, task moves, AI, notifications,
planning, Scout/triage, schema, migrations, and deployment are excluded.
The eight owned routes are covered by a test that poisons both `@/db` and
`@/db/schema` while installing PostgreSQL-shaped worker and task-core
collaborators. Shared adapter contracts cover empty scopes, visibility and
ordering, dependency validation, burn JSON membership, cluster partial results,
and rollback outcomes.

The canonical route graph changed from
`266/A76/B5/clean185/direct46/transitive30/directDB48/lib51/helpers0/units127`
to
`266/A68/B5/clean193/direct45/transitive23/directDB47/lib46/helpers0/units114`.
Tier B did not change.

The implementation changes 26 paths: 16 production paths, 8 test/baseline
paths, and 2 documentation paths. This stays below the approved hard cap of
20 production, 8 test/baseline, and 2 documentation paths. The production
runtime facade is included because the top-level capability must resolve
through the same stable PostgreSQL composition used by every worker consumer;
no nested compatibility tunnel or backend probe is used.
