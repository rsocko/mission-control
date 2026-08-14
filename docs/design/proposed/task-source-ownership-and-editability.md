---
title: "Task Source Ownership and Editability"
status: accepted
created: 2026-08-03
last_reviewed: 2026-08-05
category: architecture
related:
  - "[Connectors Architecture](../../architecture/connectors.md)"
  - "[Field Sync Patterns](../../architecture/field-sync-patterns.md)"
  - "[Data Model](../../architecture/data-model.md)"
  - "[Scout Smart Connector](scout-smart-connector.md)"
  - "[Triage Queue](triage-queue.md)"
  - "[Task Move (Cross-Source)](task-move-cross-source.md)"
issues:
  - "rsocko/mission-control#1406 - Scout task and content landing policy"
  - "rsocko/mission-control#2021 - Task ownership and editability epic"
  - "rsocko/mission-control#2022 - Field-policy UI adoption"
  - "rsocko/mission-control#2023 - Policy and override persistence"
  - "rsocko/mission-control#2024 - Scout editing and merge-safe re-ingest"
  - "rsocko/mission-control#2119 - Connector classification and remote-mirror disposition"
---

# Task Source Ownership and Editability

## Decision Summary

Mission Control must separate three concepts that are currently represented by
the single connector `write` capability:

1. **Task authority**: which system owns the Mission Control task's canonical
   user-facing fields.
2. **Local editability**: which fields Mission Control may change and persist
   in its own database.
3. **Source write-back**: which changes the connector can propagate to an
   upstream system.

Connector `write` will continue to mean that a connector can mutate an
upstream task. It will no longer determine whether every control in Mission
Control is enabled.

Each task-producing connector will declare one of four source models:

| Source model | Canonical task owner | Example |
|---|---|---|
| `mc-owned` | Mission Control | Local tasks |
| `remote-managed` | Upstream source, with write-through | Microsoft Todo, writable GitHub Issues |
| `remote-mirror` | Upstream source, without write-through | Read-only external task mirrors |
| `ingested` | Mission Control after capture | Scout |

Scout is an `ingested` source. Scout provides provenance, initial values, and
later enrichment, but Mission Control owns the durable task after creation.
Users may edit all ordinary task fields locally. Scout re-ingest must preserve
local overrides instead of replacing them.

This policy begins only after a durable task exists. Scout content remains a
triage item and is outside task field policy until the user or an approved
automation creates one or more tasks from it. A lower-confidence Scout task
that lands in the Inbox is already a task and therefore uses this policy.
Tasks promoted from Scout content are `ingested` tasks and retain both Scout
and originating triage provenance.

## Finalized Decisions

The following decisions are part of the accepted design:

| Area | Decision |
|---|---|
| Scout removal | The normal action cancels locally. Explicit hard deletion first creates a durable ingest-suppression tombstone. |
| Remote mirrors | Add an MC-local `localDisposition` of `active`, `handled`, or `dismissed`; upstream status remains source-authoritative. |
| Client policy contract | Resolve policy on the server for each task. List responses may deduplicate identical policies into referenced profiles. |
| Metadata | Remove generic `metadata` mutation from ordinary task PATCH requests. Trusted ingest and sync boundaries own namespaced metadata merging. |
| Disabled connectors | Allow `local` mutations, block source-dependent mutations, and reject mixed requests atomically if any field is blocked. |
| Connector rollout | Track connector classification and remote-mirror behavior separately in #2119 after the #2023 foundation. |

## Context

Mission Control stores all connector tasks in the local `tasks` table. The
connector identity fields establish provenance and synchronization behavior;
they do not imply that every task field is merely a cache.

The current capability model does not express this distinction:

```ts
interface ConnectorCapabilities {
  read: boolean;
  write: boolean;
  delete: boolean;
  // ...
}
```

Runtime and UI code commonly interpret `write: false` as "the task is
read-only in Mission Control." That interpretation works for some upstream
mirrors, but it is incorrect for:

- MC-local planning fields that have no upstream representation.
- Ingested tasks that become first-class Mission Control records.
- Local organization such as tags, projects, phases, My Day, and ordering.
- Sources that use an indirect or pull-based write-back protocol.

Scout exposes the problem clearly. Its connector declares `write: false`
because there is no direct upstream task API to call. However, Scout-created
items are intentionally real Mission Control tasks. Scout polls Mission
Control for status changes, and there is no separate authoritative Scout task
store to which ordinary edits could be sent.

## Current Behavior

### Task PATCH route

For a connector with `write: false`, the main task PATCH route currently:

| Field | Current server behavior |
|---|---|
| `title`, `description` | Blocked |
| `status`, `statusReason` | Blocked, except Scout status-only updates |
| `priority`, `dueDate` | Blocked |
| `recurrence`, `microStatus` | Blocked |
| `metadata` | Blocked |
| `kanbanColumn`, `kanbanOrder` | Saved locally |
| `effort`, `estimatedDuration` | Saved locally |
| `snoozedUntil`, `reminderAt` | Saved locally |
| `tags` | Saved locally |

Other APIs also persist Mission Control organization independently of source
write capability, including project, phase, focus, My Day, relationship, and
tag associations.

### UI

Most task surfaces derive a single `canWrite` boolean from
`connectorCaps.write`. Task detail controls, row actions, status menus,
priority menus, and planning controls are disabled together.

This creates two inconsistencies:

1. The server supports local edits that the UI does not expose.
2. A connector cannot express that some fields are editable while others are
   source-controlled.

### Scout re-ingest

When Scout pushes an existing open task, ingest currently compares and then
replaces:

- `title`
- `description`
- `priority`
- `dueDate`
- `metadata`

Consequently, enabling local edits to these fields without a merge policy
would cause later Scout pushes to erase user changes.

## Goals

- Make source authority explicit.
- Permit all appropriate Mission Control-local edits regardless of upstream
  write support.
- Treat Scout tasks as MC-owned tasks with durable provenance.
- Preserve local edits across inbound refresh and re-ingest.
- Keep upstream write attempts capability-safe.
- Provide one server-side policy used by every mutation route and UI surface.
- Make mixed local/write-through mutations predictable and observable.
- Preserve existing behavior for writable Microsoft Todo and GitHub tasks.

## Non-Goals

- Add new upstream mutation abilities to Scout.
- Reply to email, mutate Teams messages, or modify meetings through Scout.
- Replace connector-specific status, priority, or tag mappings.
- Make notification records editable as tasks without first promoting them.
- Solve arbitrary multi-master conflict resolution.
- Store complete upstream email bodies, transcripts, or other unnecessary
  private source content.

## Terminology

### Task authority

The system whose value is canonical for an ordinary task field.

### Source write-back

An attempt to apply a Mission Control change to an upstream source. Write-back
may be direct, queued, pull-based, or unsupported.

### Local overlay

Mission Control state that augments a source task without changing the
upstream object. Examples include focus placement, effort estimates, and hub
project membership.

### Local override

A user edit to a field that an ingested or hybrid source may also enrich.
Inbound updates must preserve the local value until the override is cleared.

### Provenance

Stable source identity and context explaining where a task came from. It is
not the same as task ownership.

## Source Models

### `mc-owned`

Mission Control owns all ordinary task fields. No source write-back occurs.

Examples:

- Local tasks.
- Tasks detached from a deleted connector when explicitly retained.

### `remote-managed`

The upstream system owns source-native fields and Mission Control writes
supported changes through to it.

Examples:

- Microsoft Todo.
- GitHub Issues with write permission.

Source-native fields normally use `write-through`. MC-only fields use `local`.
Unsupported source fields remain local rather than being discarded.

### `remote-mirror`

The upstream system owns source-native fields and Mission Control cannot write
them back.

Examples:

- A read-only task connector.
- A connector instance whose credentials have read permission but not write
  permission.

Source-native fields are `blocked` unless a separate local-overlay field
exists. MC-owned planning and organization remain editable.

Marking a mirrored source task "done" is semantically ambiguous. The design
must not silently claim that the upstream task was completed. A mirror may
instead expose an MC-local disposition such as `handled` or `dismissed`.

Remote mirrors store:

```ts
type LocalDisposition = 'active' | 'handled' | 'dismissed';
```

`localDisposition` is an MC-owned overlay. Inbound sync does not clear a
non-`active` disposition, and no disposition change calls or queues a connector
write. If connector configuration later changes the task's source model, the
preserved overlay remains local and may be restored to `active`.

### `ingested`

The source contributes an actionable item that becomes an MC-owned task.
There may be no durable upstream task entity.

Examples:

- Scout-curated email, Teams, meeting, or cross-source action items.

Ordinary fields are locally editable. Inbound pushes are enrichments and use
override-aware merging. Provenance remains source-controlled.

## Field Taxonomy

The mutation policy operates on logical fields rather than HTTP request
shapes.

| Group | Fields | Default owner |
|---|---|---|
| Identity/provenance | `sourceId`, connector IDs, linked source IDs, source type | Source |
| Content | `title`, `description` | Model-dependent |
| Lifecycle | `status`, `statusReason`, `completedAt` | Model-dependent |
| Planning | `priority`, `dueDate`, `effort`, estimate, recurrence, reminder, snooze, micro-status | Usually MC unless mapped upstream |
| Organization | tags, hub projects, phases, My Day, Focus, Kanban placement/order | MC |
| Structure | parent, subtasks, dependencies | Model/capability-dependent |
| Sync bookkeeping | sync status, retry count, source snapshots, cursors | System |

Identity, provenance, and sync bookkeeping are never accepted as ordinary
client-editable task fields.

## Field Mutation Modes

Every requested field resolves to one mutation mode:

| Mode | Behavior |
|---|---|
| `local` | Persist in MC; never call the connector |
| `write-through` | Persist optimistically and enqueue or attempt upstream write |
| `pull-write-back` | Persist in MC; source observes through a status/change feed |
| `blocked` | Reject with a field-specific reason |

This mode is distinct from whether an inbound source is allowed to refresh the
field.

## Connector Contract

### Capability additions

Add source semantics without changing the meaning of existing `write`:

```ts
type TaskSourceModel =
  | 'mc-owned'
  | 'remote-managed'
  | 'remote-mirror'
  | 'ingested';

type WriteBackMode =
  | 'none'
  | 'direct'
  | 'queued'
  | 'pull';

interface ConnectorCapabilities {
  read: boolean;
  write: boolean; // Upstream task mutation support
  delete: boolean; // Upstream task deletion/close support
  taskSourceModel?: TaskSourceModel;
  statusWriteBack?: WriteBackMode;
  pullWriteBackWhenDisabled?: boolean;
  // Existing field-specific capabilities remain.
}
```

Runtime defaults provide backward compatibility:

| Existing connector shape | Default source model |
|---|---|
| Local connector | `mc-owned` |
| `write: true` | `remote-managed` with write-through |
| `write: false` | `remote-mirror` |
| Scout | Explicit `ingested` |

Field-level profiles express hybrid ownership without introducing a fifth
source model. For example, a `remote-managed` connector may write status
through while keeping effort and project membership local.

All currently registered connectors also have an explicit classification in
`task-source-profiles.ts`; these defaults now serve only unknown or legacy
connector types. Custom REST resolves its model per instance from
`updateEndpoint`, while Document Intelligence uses a status-only write profile.

### Why `write` is retained

Renaming the stored capability would require immediate migration of connector
configuration, settings UI, and external contracts. Retaining it as upstream
write support is compatible and accurate. New code must not use it directly
as a blanket local-edit permission.

## Server-Side Policy Resolver

Create one shared resolver used by mutation routes:

```ts
type TaskField =
  | 'title'
  | 'description'
  | 'status'
  | 'statusReason'
  | 'priority'
  | 'dueDate'
  | 'effort'
  | 'estimatedDuration'
  | 'recurrence'
  | 'reminderAt'
  | 'snoozedUntil'
  | 'microStatus'
  | 'tags'
  | 'projects'
  | 'phases'
  | 'dependencies'
  | 'kanbanPlacement';

interface FieldPolicy {
  field: TaskField;
  mutation: 'local' | 'write-through' | 'pull-write-back' | 'blocked';
  inbound: 'source-wins' | 'local-wins' | 'merge';
  reason?: string;
}

function resolveTaskFieldPolicy(
  task: TaskSourceIdentity,
  capabilities: ConnectorCapabilities | null,
  field: TaskField,
): FieldPolicy;
```

The resolver must be pure and exhaustively tested. Connector-specific code
may supply a policy profile, but mutation routes must not accumulate
`connectorType === ...` exceptions.

## Scout Policy

Scout declares:

```ts
{
  read: true,
  write: false,
  delete: false,
  taskSourceModel: 'ingested',
  statusWriteBack: 'pull',
  pullWriteBackWhenDisabled: true,
}
```

### Scout field matrix

| Field/group | Local mutation | Inbound Scout behavior | Write-back |
|---|---|---|---|
| Title | Allowed | Merge; preserve override | None |
| Description | Allowed | Merge; preserve override | None |
| Status/reason | Allowed | MC wins | Pull status feed |
| Priority | Allowed | Merge; preserve override | None |
| Due date | Allowed | Merge; preserve override | None |
| Effort/estimate | Allowed | MC wins | None |
| Reminder/recurrence/snooze | Allowed | MC wins | Snooze/status feed where applicable |
| Micro-status | Allowed | MC wins | None |
| Tags/projects/phases | Allowed | MC wins | None |
| My Day/Focus/Kanban | Allowed | MC wins | None |
| Dependencies/subtasks | Allowed when locally supported | MC wins | None |
| Source identity | Blocked | Scout owns | N/A |
| Scout context/snapshot | Blocked | Scout owns/merges | N/A |
| Delete | Local archive/cancel/remove | Closed items suppress re-push | Pull status feed for cancellation |

Scout completion does not call `completeTask()` on the connector. Updating the
task timestamp makes the change available to the existing Scout status-change
feed.

## Persisting Source Values and Local Overrides

### Requirements

The system must know:

- The last value observed from the source.
- Whether the current task value was intentionally edited locally.
- When each side changed.
- Whether an override can safely be cleared.

### Persistence table

Add a generic field-state table:

```ts
taskFieldStates {
  taskId: string;
  fieldName: TaskField;
  sourceValue: unknown;       // JSON
  locallyOverridden: boolean;
  sourceObservedAt: string | null;
  localEditedAt: string | null;
  updatedAt: string;
}
```

Primary key: `(taskId, fieldName)`.

`taskId` is a cascading foreign key to `tasks.id`. Add an index supporting
field-state reads by task; the composite primary key also prevents duplicate
snapshots.

The canonical rendered value remains in the existing task column. The table
stores source comparison state and ownership metadata, not a duplicate local
record.

This table is preferred over embedding override markers in `tasks.metadata`:

- Ingest currently replaces connector metadata.
- Generic mutation code should not understand Scout metadata structure.
- Override state needs independent constraints and tests.
- Future hybrid connectors can reuse the same mechanism.

### Override lifecycle

1. Initial ingest writes the task value and source value with
   `locallyOverridden = false`.
2. A local edit to a mergeable field sets `locallyOverridden = true`.
3. A later inbound value updates `sourceValue` and `sourceObservedAt`.
4. If overridden, the task column remains unchanged.
5. A "Use source value" action applies `sourceValue` and clears the override.
6. If a user changes the field back to the current source value, the server
   may automatically clear the override.

### Three-way merge

For every mergeable inbound field:

```text
previous source value + current MC value + incoming source value
```

| Condition | Result |
|---|---|
| No local override | Apply incoming value |
| Local override | Preserve MC value; record incoming source value |
| Incoming equals MC value | Clear override |
| Task completed/cancelled | Suppress ordinary Scout re-push |
| Task snoozed | Suppress until snooze expires |

Description merging must not append arbitrary source text to user-authored
content. Preserve the local description and retain the new source summary in
the source snapshot until explicitly accepted.

## Mutation API Behavior

### Request processing

The task PATCH route should:

1. Parse and validate requested fields.
2. Resolve a policy for every field.
3. Reject blocked fields before any write.
4. Partition accepted fields by mutation mode.
5. Persist local state and override markers atomically.
6. Mark only write-through fields `pending_push`.
7. Dispatch direct or queued source writes after the local transaction.
8. Expose pull-write-back fields through their connector feed.

Mixed requests are allowed only when every field is valid. The route remains
atomic from the client's perspective; it must not apply local fields while
silently rejecting another field.

### Disabled connectors

Connector enablement is evaluated after resolving every requested field:

- `local` fields remain editable while the connector is disabled.
- `write-through` and other source-dependent fields are blocked with a
  field-specific reason.
- `pull-write-back` remains available only when the connector explicitly sets
  `pullWriteBackWhenDisabled`; Scout does because its authenticated status feed
  is independent of ingest enablement. Scout local edits remain available,
  while disabling Scout continues to reject new ingest.
- A mixed request containing any blocked field is rejected before all writes.

Disabling a connector never silently detaches its tasks or converts them to
MC ownership.

### Metadata boundary

The ordinary task PATCH contract does not accept `metadata`. User-editable
behavior must use typed first-class fields. Existing metadata remains readable
for compatibility.

Only trusted ingest and synchronization code may update metadata. Those
boundaries merge owned namespaces rather than replacing the entire object:
Scout may update Scout provenance while preserving unrelated MC-owned
namespaces. Clients cannot mutate connector identity, provenance, linked-source
identity, snapshots, or synchronization bookkeeping through generic metadata.

### Response

The existing success response may remain for compatibility. A richer response
should be available to clients:

```json
{
  "success": true,
  "fields": {
    "status": { "mode": "pull-write-back", "persisted": true },
    "effort": { "mode": "local", "persisted": true }
  }
}
```

Blocked responses identify fields and reasons:

```json
{
  "error": "Some fields cannot be changed for this task source",
  "blockedFields": {
    "title": "Title is controlled by the read-only upstream task"
  }
}
```

### Related routes

The same resolver must be used by:

- Main task PATCH and DELETE.
- Tag mutation routes.
- Status and bulk-status routes.
- Task detail, row, Quick Sort, Today, Kanban, and mobile mutations.
- Subtask and dependency mutations.
- Same-source move operations.
- Cross-source move/copy validation.

Organization-only routes may use a precomputed MC-local policy profile, but
they must not independently reinterpret connector `write`.

## Delete, Close, Dismiss, and Remove Semantics

The current `delete` capability also describes upstream behavior, not every
local lifecycle action.

| Source model | Primary action |
|---|---|
| `mc-owned` | Delete or archive locally |
| `remote-managed` | Close/delete upstream when supported |
| `remote-mirror` | Dismiss or hide locally; only an independently declared delete capability permits explicit upstream deletion |
| `ingested` | Cancel/archive/remove locally and suppress re-ingest |

For Scout, "Delete" should not attempt an upstream connector call. Prefer a
recoverable local archive or cancellation, with hard delete available only
through an explicit destructive action.

The normal Scout removal action sets the task status to `cancelled`, preserves
provenance and field snapshots, and exposes the cancellation through the Scout
status-change feed. A separate explicit hard-delete action:

```ts
taskIngestSuppressions {
  connectorInstanceId: string;
  sourceId: string;
  reason: 'hard-deleted';
  createdAt: string;
}
```

The suppression key is unique on `(connectorInstanceId, sourceId)`. Hard delete
creates the tombstone and removes the task graph atomically. Ingest checks the
tombstone before creating or linking a task, preventing recreation after the
task row is gone.

Scout exposes this destructive contract as
`DELETE /api/tasks/{taskId}/hard-delete`. The ordinary
`DELETE /api/tasks/{taskId}` route remains recoverable cancellation and does
not create a tombstone. Non-Scout tasks reject the Scout hard-delete contract.

For a true remote mirror, `localDisposition` is stored on the task with an
`active` default. `handled` means the user considers the item addressed in MC;
`dismissed` means it is intentionally hidden or irrelevant. Neither value
changes upstream `status`. This prevents "done in MC" from falsely representing
"done upstream."

## UI Contract

### Replace blanket `canWrite`

UI surfaces should receive field permissions:

```ts
interface TaskEditPolicy {
  editableFields: TaskField[];
  deletableLocally: boolean;
  sourceDeleteSupported: boolean;
  sourceModel: TaskSourceModel;
  fieldReasons: Partial<Record<TaskField, string>>;
}
```

The server resolves this contract for each task using the same resolver that
authorizes mutations. Task-detail responses include the resolved policy.
List responses may deduplicate identical policies into a top-level
`policyProfiles` map and return a `policyId` on each task. Connector-instance
capabilities alone are not an authorization contract because task context can
change the result.

### Control behavior

- Enable each control based on its field policy.
- Explain disabled controls with source-specific text.
- Distinguish "saved in Mission Control" from "synced to source."
- For Scout, show ordinary editing without a read-only banner.
- Preserve provenance and "Open source" actions separately from editing.
- For remote mirrors, label local disposition actions clearly.
- Quick Sort must only offer actions valid for the top task's field policy.

### Optimistic updates

Optimistic UI behavior must use the same policy result returned by the server.
Do not infer write-through solely from connector type. A local Scout update
should complete immediately without entering a pending-push state.

## Inbound Sync and Ingest

### Standard pull connectors

`remote-managed` and `remote-mirror` connectors continue to ingest
source-native values. Field-state tracking is required only for fields whose
policy is `merge`.

### Scout

Scout ingest must:

1. Look up the existing task and field states.
2. Continue suppressing completed, cancelled, and actively snoozed tasks.
3. Merge title, description, priority, and due date independently.
4. Preserve locally overridden fields.
5. Update source snapshots even when local values are preserved.
6. Merge namespaced provenance metadata rather than replacing MC-owned
   metadata.
7. Report which fields were applied, preserved, or unchanged.

Example response item:

```json
{
  "sourceId": "scout:email:message-id",
  "mcTaskId": "task-id",
  "action": "updated",
  "appliedFields": ["description"],
  "preservedOverrides": ["priority", "dueDate"],
  "unchangedFields": ["title"]
}
```

All three diagnostic arrays are always present on every item result, including
created, skipped, suppressed, linked, and triaged results.

## Provenance Boundaries

Provenance fields must not become editable merely because the task is
MC-owned:

- Stable source IDs remain immutable.
- Connector identity changes only through an explicit move/copy operation.
- Scout source type and related source IDs are source-managed.
- Full private source content is not copied into override or snapshot state.
- Source snapshots contain only normalized task field values already accepted
  for storage in `tasks`.

Cross-source deduplication remains represented by linked source records. A
Scout-linked source attached to a Microsoft Todo task does not change that
task's authority.

## Migration and Compatibility

### Phase 1: Policy foundation

- Add source model and write-back capability types.
- Add the central resolver and exhaustive unit tests.
- Preserve current defaults for existing connectors.
- Route status-only Scout handling through the resolver.

No UI behavior changes in this phase.

### Phase 2: Override persistence and Scout ingest

- Add `task_field_states`.
- Backfill Scout source snapshots from current task values with no overrides.
- Make Scout re-ingest merge-safe.
- Mark local Scout edits as overrides.
- Add ingest-suppression tombstones and check them before create/link.
- Add ingest response diagnostics and audit logging.

### Phase 3: Scout editing

- Classify Scout as MC-authoritative.
- Permit ordinary task edits and local lifecycle actions.
- Keep provenance fields immutable.
- Ensure no direct connector write or pending-push state is created.

### Phase 4: UI policy adoption

- Return task edit policies from shared APIs.
- Replace `canWrite` across desktop, mobile, Today, Kanban, task rows, detail
  panels, Quick Sort, and bulk actions.
- Add disabled-field explanations and local/source sync indicators.

### Phase 5: Remote mirror semantics

- Implement #2119 after the policy contract in #2023 is stable.
- Audit all task-producing connectors, including per-instance capability
  differences.
- Classify task-producing connectors separately from notification-only
  connectors.
- Add `localDisposition` with an `active` default.
- Preserve handled and dismissed disposition during inbound refresh.
- Document connector-specific policy overrides.

### Backward compatibility

- Existing connector configurations without `taskSourceModel` use defaults.
- Existing `write`, `delete`, and field-specific capabilities remain valid.
- Existing task PATCH clients continue receiving `{ success: true }`.
- No existing writable connector loses source write-through.

## Testing Strategy

### Policy unit tests

Use a matrix covering every source model, field group, and relevant
capability:

- Local task ordinary fields are local.
- Writable source-native fields write through.
- Read-only mirror source-native fields are blocked.
- Read-only mirror MC overlays remain local.
- Scout ordinary fields are local or pull-write-back.
- Provenance fields are always blocked.

### API integration tests

- Mixed-field requests are atomic.
- Local-only changes never set `pending_push`.
- Write-through changes do set retry state.
- Disabled connectors allow local mutations and reject source-dependent
  mutations.
- Scout status changes appear in the status-change feed.
- Scout non-status edits persist without connector calls.
- Generic metadata mutation is rejected.
- Field-specific error responses remain stable.

### Scout ingest tests

- No override applies incoming changes.
- Override preserves the local value.
- Source snapshots advance while overrides are retained.
- Returning to the source value clears an override.
- Closed and snoozed suppression remains unchanged.
- Metadata merge preserves MC-owned namespaces.
- Hard deletion creates a suppression tombstone atomically.
- Tombstoned items are not recreated or linked.
- Multiple items and repeated pushes remain idempotent.

### UI tests

- Each control follows its field permission.
- Scout tasks expose ordinary editing.
- Remote mirrors expose local overlays but not source-owned fields.
- Remote mirrors expose handled and dismissed disposition without changing
  upstream status.
- Quick Sort hides or disables invalid actions.
- Tooltips explain blocked fields.
- Desktop and mobile surfaces use the same policy.

### Regression tests

- Microsoft Todo and GitHub write-through behavior is unchanged.
- Tag write-back still occurs only when supported.
- Cross-source move remains available for read-only sources.
- Local task editing remains unrestricted.

## Observability and Audit

Log policy decisions at mutation boundaries with:

- Task and connector IDs.
- Source model.
- Fields grouped by mutation mode.
- Blocked reasons.
- Write-back result.
- Override creation or clearing.

Do not log task descriptions or private source content.

Task history should distinguish:

- Local user edit.
- Inbound source refresh.
- Preserved local override.
- Accepted source value.
- Pull write-back acknowledgment.

## Security and Privacy

- The server is authoritative; UI permissions are advisory.
- Connector enablement and credentials remain required for direct source
  writes.
- Source identity and sync bookkeeping cannot be patched by clients.
- Override storage contains only normalized task values.
- Scout status polling remains authenticated when `MC_API_KEY` is configured.
- No new Scout behavior sends messages or mutates M365 content.

## Alternatives Considered

### Treat every connector task as fully editable

Rejected. Source refresh would overwrite edits, and MC could misrepresent
upstream status.

### Treat every `write: false` task as fully read-only

Rejected. It blocks legitimate MC-local planning and incorrectly demotes
ingested tasks such as Scout items.

### Add more Scout-specific exceptions

Rejected as the long-term design. It would spread connector-type conditions
across routes and UI components without solving other read-only sources.

### Store overrides only in connector metadata

Rejected. Connector metadata is source-owned, currently replaceable, and not
a stable cross-connector policy boundary.

### Never refresh existing Scout tasks

Rejected. Scout can provide meaningful new context before the user edits a
task. Override-aware merge preserves both enrichment and user intent.

## Acceptance Criteria

The design is complete when:

- Connector upstream write support and local editability are distinct.
- Every task-producing connector has a source model.
- One server-side policy resolver governs API and UI field permissions.
- Scout tasks can edit all ordinary fields locally.
- Scout re-ingest cannot overwrite local edits.
- Scout hard deletion creates a durable suppression tombstone.
- Provenance remains immutable and queryable.
- Generic metadata is not accepted by ordinary task PATCH requests.
- True remote mirrors retain source authority while allowing MC overlays and
  local handled/dismissed disposition.
- Disabled connectors allow local fields and block source-dependent fields.
- Existing writable connector sync behavior remains intact.

## Tracking Issues

| Issue | Scope | Dependency |
|---|---|---|
| #2021 | Parent epic and cross-cutting acceptance criteria | None |
| #2023 | Task authority policy, field resolver, and override persistence | Foundation |
| #2024 | Scout local editing and merge-safe re-ingest | #2023 |
| #2022 | Replace blanket UI `canWrite` gating with field policies | #2023; coordinates with #2024 |
| #2119 | Connector classification and remote-mirror disposition | #2023; may run alongside #2022 and #2024 |
