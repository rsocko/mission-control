---
title: "Scout Ingestion and Reconciliation Persistence"
status: active
created: 2026-09-06
last_reviewed: 2026-09-06
category: architecture
related:
  - "[Portable Persistence Boundaries](./persistence-boundaries.md)"
  - "[Connectors](./connectors.md)"
---

# Scout Ingestion and Reconciliation Persistence

## Boundary

`WorkerPersistenceRepositories.scoutIngestionReconciliation` is the single
startup-selected capability for Scout push ingestion, the Scout
parallel-comparison projection, and Scout reconciliation runs and suggestions.
`TriagePersistenceRepositories` additionally publishes two bounded action
surfaces — `actions` for triage action execution and `documentTaskActions` for
the OWL document task action.

Both contracts contain only plain values and named operation results. There is
no generic query, transaction, or database handle: driver handles, transactions,
Drizzle tables, and SQL fragments stay inside the SQLite and PostgreSQL
adapters. Where one operation must interleave a read and a write inside a single
transaction, the port accepts a *pure decision callback* whose input and output
are both typed Scout or triage records; the callback never receives a database
handle, a query builder, or a transaction object.

The method groups are:

- `ingestion`: connector/source-list bootstrap and enabled reporting, project
  validation, existing task and triage lookup, the one-batch cross-connector
  candidate snapshot, ingest suppression/link lookup, the atomic existing-task
  merge, the atomic create/link/triage writes with conflict-winner readback, and
  the source-list count refresh;
- `comparison`: the deterministic parallel-comparison window projection; and
- `reconciliation`: run expiry/create/replay/resume, scoped task and task-state
  snapshots, the atomic evaluation/suggestion/task-state commit, digest-row
  creation, suggestion listing/action/supersession, and auto-completion
  provenance reads.

Identifier generation, timestamps, hashing, settings parsing, evidence scoring,
autonomy policy, HTTP status selection, semantic publication, UI event emission,
Microsoft Graph calls, and OWL connector initialization all remain application
responsibilities.

## Ordering, transactions, and idempotency

**Ingestion.** The whole maximum-100-item request is validated before any
persistence happens. Scout is bootstrapped once and the cross-connector
candidate set is snapshotted once, then items are processed in request order.
Each item gets *its own* transaction — never one transaction for the batch — and
the suppression/linked-source check and the chosen create, link, merge, or
triage write happen inside that same transaction. The unique
`(connectorInstanceId, sourceId)` conflict converges by returning the stored
winner; the losing item is requeued at most once and then merges normally.
Existing-task updates write the rendered columns, metadata, and every
field-state observation atomically. Triage upserts never reopen an `actioned` or
`dismissed` row. Semantic publication and `task.created` events are external
side effects and happen only after the item's transaction commits.

**Reconciliation.** Run idempotency is `(idempotencyKey, requestHash)`; a
request-hash mismatch is rejected rather than replayed. A scope lease token and
the partial unique active-scope index fence create and resume. All evaluations,
suggestion supersessions and insertions, task-state changes, the optional task
completion, the digest notification row, and the final run summary commit
together or not at all; losing the lease aborts the whole commit. Suggestion
actions are fenced on `id + payloadHash + pending status`, so a stale proposal
can never complete a task, and completion plus the suggestion state transition
commit together before any event is emitted.

**Triage actions.** A durable `create_task_todo` claim is reserved before any
remote call. A known failure releases the claim; an unknown Microsoft To Do
outcome deliberately retains the target and claim so the embedded triage marker
can reconcile it later. Local completion and the action-record append are
atomic. Undo takes an action-history compare-and-set snapshot with a stale-claim
timeout, and rolls the claim back if the remote reopen fails.

**OWL document actions.** The remote mutation happens first, the task identity
is re-read, and local state is applied only through an identity-fenced write.
Identity drift returns 409 instead of overwriting a task that has moved. Per-task
in-process serialization and connector initialization stay outside the adapter.

## Dialect parity

SQLite stores JSON as text and booleans as integers; PostgreSQL stores `jsonb`
and native booleans. Both adapters normalize before values cross the contract,
so services observe the same parsed objects, booleans, and `null`s.

Action-history writes are portable in both directions: SQLite appends with
`json_insert(actions_taken, '$[#]', json(?))` and compares with
`json(actions_taken) = json(?)`, PostgreSQL appends with `actions_taken || $n::jsonb`
and compares with `jsonb` equality. Callers never see `json_insert`.

Task completion and document-action writes are expressed in physical column
names so both adapters write exactly the same columns from the same service
decision.

Bounded compare-and-set losses surface as a single
`ScoutPersistenceConflictError` with a typed code (`task-changed-before-completion`,
`task-changed-before-confirmation`, `run-claim-lost`,
`suggestion-acted-concurrently`); the service maps each code onto its own HTTP
status so status selection stays a policy decision.

## Deferred, backend-selected branches

Four routes are deliberately recorded as Tier B rather than claimed clean,
because a deferred, backend-selected import remains on a branch this layer does
not own:

| Route | Deferred branch |
| --- | --- |
| `scout/ingest` | backend-selected semantic publication |
| `triage/[id]` | backend-selected external connector initialization |
| `tasks/[id]/owl` | backend-selected external connector initialization |
| `triage/[id]/extract-actions` | excluded dynamic AI provider |

The remaining four routes (`scout/parallel-comparison`, `scout/reconcile`, and
both reconciliation-suggestion routes) are fully clean.

## Proof

- Shared SQLite/PostgreSQL contract suites in
  `tests/contracts/scout-ingestion-reconciliation-persistence.contract.ts` and
  `tests/contracts/triage-action-persistence.contract.ts`.
- PostgreSQL integration runs in
  `tests/db/postgres-scout-ingestion-reconciliation.integration.test.ts` and
  `tests/db/postgres-triage-action-persistence.integration.test.ts` (skipped
  unless `MC_TEST_POSTGRES_URL` is set).
- One poisoned-SQLite route suite,
  `tests/api/scout-triage-actions-postgres-poisoned.test.ts`, imports and calls
  all eight affected route modules with `@/db` and `@/db/schema` poisoned.
- Behavioural oracles remain in `tests/connectors/scout/scout-ingest.test.ts`,
  `tests/connectors/scout/scout-reconciliation-service.test.ts`,
  `tests/api/scout-reconciliation-route.test.ts`,
  `tests/triage/triage-action-idempotency.test.ts`, and
  `tests/connectors/document-intelligence-task-actions.test.ts`.
