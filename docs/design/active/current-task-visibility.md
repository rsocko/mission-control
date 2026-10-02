---
title: "Current Task Visibility and Historical Projections"
status: accepted
created: 2026-10-02
last_reviewed: 2026-10-02
category: architecture
related:
  - "[Data Model](../../architecture/data-model.md)"
  - "[Persistence Boundaries](../../architecture/persistence-boundaries.md)"
  - "[Daily Planning Persistence](../../architecture/daily-planning-persistence.md)"
  - "[Analytics Persistence](../../architecture/analytics-persistence.md)"
---

# Current Task Visibility and Historical Projections

## Decision summary

Mission Control distinguishes **current/actionable task projections** from
**historical projections**.

A task is canonically current only while its `tasks.deleted_at` value is
`NULL`. Any repository, API, index, suggestion, selector, relationship, or
action that represents tasks a user can open or mutate must apply that rule at
its persistence boundary. A retained task row with `deleted_at IS NOT NULL` is
historical data, not a degraded current task.

Historical projections may retain immutable facts recorded before deletion.
History timelines, completed-period analytics, and burn-up contributions keep
those facts because removing them would rewrite the past. Current snapshots,
counts, suggestions, search results, navigation targets, and task mutations
exclude soft-deleted tasks because they promise a presently available task.

SQLite and PostgreSQL implementations must expose identical visibility and
association semantics. Backend differences are not a supported compatibility
mode.

## Context

Mission Control soft-deletes tasks so synchronization, transfer, recovery, and
audit workflows can retain provenance. The retained row is useful evidence, but
it is unsafe as an implicit target for current UI and actions. A projection
that returns the row while task detail rejects it creates an orphaned user
journey: the task appears actionable and then fails after navigation or
mutation.

The distinction cannot be solved by physically deleting every task or by
nulling every historical reference. Both approaches destroy provenance.
Instead, each projection must declare whether it represents current state or
historical evidence.

## Canonical current-task visibility

The canonical predicate is:

```sql
tasks.deleted_at IS NULL
```

Repositories apply additional surface-specific predicates after this one, such
as checklist membership, connector scope, status, permissions, or date range.
Those predicates do not replace or weaken the canonical rule.

The rule belongs in repository queries or shared persistence helpers, not only
in components. APIs and background workers must receive the same answer as the
interactive UI. A caller must not need to fetch a task and infer visibility
from a downstream `404`.

Current/actionable projections include:

- task lists, search, duplicate detection, relationships, source-list views,
  assignee views, and project or graph snapshots;
- My Day, focus, scheduling, reminders, suggestions, and current KPI inputs;
- notification links and actions that navigate to or mutate a task;
- semantic or full-text indexes used to retrieve current tasks.

## Historical projections

Historical projections preserve facts whose meaning was fixed when the event
occurred. They include task history, audit trails, immutable sync outcomes,
completed-period analytics, and burn-up contributions.

Deletion changes whether a task participates in a current snapshot. It does
not retroactively erase work that was completed, effort that was recorded, or
an event that occurred before deletion. Therefore:

- History keeps the original task identifier and event payload.
- Burn-up and other cumulative historical series keep past contributions.
- Current totals and point-in-time snapshots exclude deleted tasks.
- A historical view must not turn its retained identifier into an unguarded
  current-task link or mutation.

If a report combines current and historical data, its contract must name the
boundary explicitly rather than relying on a shared query with ambiguous
semantics.

## Notification task associations

Notifications are historical records and may outlive their related tasks.
Their `related_task_id` is retained as provenance.

Notification read models expose `relatedTaskAvailability`:

- `available` means the association resolves to a task with
  `deleted_at IS NULL`;
- `unavailable` means the identifier is retained but the task is soft-deleted
  or no task row exists;
- `null` means the notification has no task association.

When availability is `unavailable`, task-dependent links and actions are
omitted from API responses and the UI explains that the notification remains
for history while its task is no longer available. Notification lifecycle and
provider actions that do not depend on the task remain usable.

Action endpoints independently enforce the same rule and return a deterministic
conflict before provider dispatch or task mutation. Client-side omission is a
usability measure, not an authorization or integrity boundary.

Established task transfer and succession flows repoint
`notifications.related_task_id` transactionally in both SQLite and PostgreSQL.
The successor becomes the available association. No read path guesses a
successor, matches by title, or reassociates an orphan without authoritative
transfer evidence.

## SQLite and PostgreSQL parity

Every current-task predicate, notification availability projection, transfer
repoint, and action guard must be implemented for both persistence engines.
Shared contract tests are the primary parity check. Backend-specific tests may
supplement the contract for SQL syntax, transaction, or query-plan behavior,
but may not define different product semantics.

## Indexing and rebuild rules

`idx_tasks_deleted_at` supports the canonical predicate. Association columns
retain their role-specific indexes, including
`idx_notifications_related_task_id`.

Current-task indexes and derived stores must remove or tombstone an entity when
`deleted_at` becomes non-null and restore it only through an explicit supported
recovery transition. Rebuilds must start from the canonical current predicate;
they must not republish every retained task row.

Historical stores rebuild from their immutable event or contribution source,
not from the current `tasks` table. A rebuild must never infer that historical
data should be deleted merely because its task is no longer current.

Adding a new task reference requires classifying it in the repository's task
reference policy as one of:

- current/repointable association;
- rebuildable current projection;
- immutable history or lineage;
- source-operation or external identity.

That classification determines transfer, deletion, and rebuild behavior.

## Testing expectations

Every current task projection must test at least:

- a visible task is included;
- a soft-deleted task is excluded;
- a retained reference to a deleted or missing task cannot produce an
  actionable orphan;
- transfer or succession repoints the association when the repository supports
  it;
- SQLite and PostgreSQL return the same result through a shared contract where
  both engines implement the surface.

Historical projections must test that deletion does not remove immutable past
events or completed-period contributions, while their corresponding current
snapshot excludes the task.

Notification tests additionally cover the explicit availability field, action
omission, explanatory UI, and deterministic server-side rejection.

## Consequences

- Soft deletion remains compatible with audit, recovery, and transfer.
- Current UI and APIs no longer expose retained rows as actionable tasks.
- Historical metrics remain stable instead of shrinking when a task is
  deleted.
- Queries must state their projection semantics, which adds some deliberate
  SQL but removes ambiguous caller-side filtering.
- No data migration is required for notification availability because it is
  derived at read time. Existing task and notification indexes support the
  lookup.

