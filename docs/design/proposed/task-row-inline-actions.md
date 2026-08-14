---
title: "Task Row Inline Actions"
status: proposed
created: 2026-08-01
last_reviewed: 2026-08-01
category: design
related:
  - "[TaskRow Consolidation](../taskrow-consolidation.md)"
  - "[Todoist vs Mission Control](../../research/todoist-vs-mc-analysis.md)"
  - "[Interactive mockup](../../mockups/mockup-task-row-inline-actions.html)"
  - "GitHub issue #1257"
---

# Task Row Inline Actions

## Summary

Add width-aware task-row shortcuts for due date, notes, status, priority, and
snooze without replacing the task detail surfaces or context menu. Actions
appear on pointer hover or keyboard focus. Existing task state remains visible
when applicable, so users can scan a row without first interacting with it.

The interactive design is available at
[`docs/mockups/mockup-task-row-inline-actions.html`](../../mockups/mockup-task-row-inline-actions.html).
It demonstrates Dashboard and My Day rows at full, medium, and narrow container
widths, with dated/undated, existing/empty notes, keyboard-focus, menu, and
read-only states.

## Decisions

1. **Actions appear on hover or keyboard focus.** State indicators remain visible
   when applicable: active My Day membership, notes presence, due date, priority,
   and non-default status.
2. **Do not add inline title editing.** Renaming is less frequent than scheduling
   or state changes, and an edit control adds row density, validation, mutation,
   and My Day drag complexity. Double-click continues to open the full detail
   dialog, where the title can be edited.
3. **The displayed due date is the editor trigger.** When a task has a date, its
   date pill opens the due-date popover. When it has no date, a calendar action
   appears on hover/focus. Never show both for the same task.
4. **Notes reuse the existing expanded Notes dialog.** If notes exist, clicking
   the persistent notes indicator opens the dialog in Read mode. For an empty
   writable task, the hover action opens it in Edit mode. No new notes preview or
   detail-panel destination is introduced.
5. **Priority and Status use popover pickers.** Dashboard badges keep their
   existing filter behavior. Separate hover actions perform edits so state
   display and filtering do not silently change semantics.
6. **Snooze becomes a popover.** Replace the opaque one-click "tomorrow" action
   with Later Today, Tomorrow, Next Monday, Pick Date, and Unsnooze.
7. **Use CSS container queries.** Dashboard rows already establish an
   `@container`; the shared row shell should do the same for My Day. Do not add a
   `ResizeObserver` for visual breakpoints.
8. **Actions respect connector capabilities.** Local My Day membership remains
   available for read-only tasks. Remote task mutations are disabled or omitted.
9. **Mobile keeps its existing action sheet.** Hover actions are not a touch
   interaction. Narrow rows show applicable state only; the action sheet remains
   the complete editing fallback.

## Goals

- Reduce friction for common task changes without making every row noisy.
- Make task state scannable without duplicating state and action controls.
- Give mouse and keyboard users equivalent access to row shortcuts.
- Share behavior across Dashboard `TaskRow` and My Day `SortableTaskRow`.
- Reuse existing mutation callbacks, date handling, and expanded Notes dialog.

## Non-goals

- Adding task comments, comment counts, or inline comment threads.
- Adding inline title editing.
- Replacing the detail panel, detail dialog, context menu, or mobile action sheet.
- Changing Dashboard priority/status badge filtering.
- General inline editing of tags, projects, recurrence, effort, or micro-status.
- Fully merging the Dashboard and My Day row components.

## Visibility model

There are two categories of trailing controls:

| Category | Visibility | Examples |
|---|---|---|
| State indicator | Persistent when applicable | My Day active, notes present, due date, priority, non-default status |
| Mutation shortcut | Hover or keyboard focus, width permitting | Add to My Day, add notes, add date, snooze, status picker, priority picker |

An applicable state indicator may also be interactive. The notes indicator opens
Notes; the due-date pill opens the date picker. Priority and Status badges are
the exception on Dashboard because they already filter the task list.

## Responsive contract

Widths refer to the row container, not the viewport.

| Container width | Persistent state | Hover/focus shortcuts |
|---|---|---|
| `>= 768px` | My Day, notes, due date, priority, non-default status | Surface actions plus add date, add notes, Status, Priority |
| `480-767px` | My Day, notes, due date, compact priority/status | Surface actions plus add date; omit secondary pickers |
| `< 480px` | Compact applicable state that fits without title overlap | No new desktop shortcuts; use mobile action sheet |

The trailing area never wraps or covers task metadata. Lower-priority state
collapses before the title loses its useful reading width. Opening a popover pins
its trigger visible until the popover closes.

Use container variants supported by the repository's Tailwind version, such as
`@min-[480px]` and `@min-[768px]`.

## Interaction contract

| Interaction | Result |
|---|---|
| Click row | Select task and open detail panel |
| Double-click row or title | Preserve current behavior: open full detail dialog |
| Click existing due-date pill | Open due-date popover |
| Click calendar on undated task | Open due-date popover |
| Click notes indicator | Open existing expanded Notes dialog in Read mode |
| Click notes action on empty task | Open existing expanded Notes dialog in Edit mode |
| Click Status action | Open anchored status picker |
| Click Priority action | Open anchored priority picker |
| Click Snooze action | Open anchored snooze picker |
| Click Dashboard priority/status badge | Preserve existing list-filter behavior |
| Press Tab into a row | Reveal the action set available at that width |
| Press Enter or Space on an action | Activate without selecting the row |
| Right-click row | Preserve the complete context menu |

Buttons stop row click and double-click propagation. Popovers close on Escape,
outside click, successful selection, or when their task leaves the list. Focus
returns to the trigger after close.

## Due-date control

The control has mutually exclusive representations:

- **Dated task:** interactive date pill labeled "Change due date."
- **Undated writable task:** calendar action shown on hover/focus.
- **Undated read-only task:** no calendar action.
- **Dated read-only task:** non-interactive date text.

The popover contains:

- Today
- Tomorrow
- Next Monday
- Pick date
- Clear due date, only when a date exists

Use **Next Monday**, not ambiguous **Next Week**. If today is Monday, Next Monday
means seven days later. Today and Tomorrow use browser-local date helpers.

Extract a shared `TaskDueDatePopover` from the context-menu behavior instead of
copying date arithmetic or `DayPicker` markup.

## Notes control

Mission Control stores one task description and has no task-comment collection.
List APIs expose only:

```ts
hasDescription: boolean;
```

Compute this in SQL so null, empty, and whitespace-only descriptions are false.
Do not return full descriptions in list responses solely for the indicator.

The row opens the existing expanded Notes dialog implemented by
`TaskDetailPanel`:

- `hasDescription === true`: open in Read mode.
- `hasDescription === false && canWrite`: open in Edit mode with the textarea
  focused.
- `hasDescription === false && !canWrite`: omit the action.

Extract the expanded dialog as a reusable `TaskNotesDialog`, or expose a typed
controller that allows a selected task to open it directly. Do not duplicate its
markdown reader, editor/preview split, focus trap, or save behavior.

Suggested controller:

```ts
interface OpenTaskNotesOptions {
  mode: 'read' | 'edit';
}

openTaskNotes(taskId: string, options: OpenTaskNotesOptions): void;
```

## Status picker

Use the same canonical status values and labels as `TaskContextMenu`:

- To Do
- In Progress
- Done
- Cancelled

Completion remains available through the completion circle. Status still belongs
in the picker because moving between To Do, In Progress, and Cancelled cannot be
expressed through that control.

On Dashboard, the visible status badge remains a filter trigger. The separate
CircleDot action opens the picker at full width. On My Day, use the same explicit
action for consistency in the first release.

## Priority picker

Use the same canonical options and colors as `TaskContextMenu`:
Critical, High, Medium, Low, and None.

The visible Dashboard priority badge remains a filter trigger. A separate Flag
action opens the picker at full width. Extract option definitions to a shared
module or component; do not create another local copy.

## Snooze picker

Snooze means hide until a point in time; it is distinct from a due date. The
Dashboard clock action opens:

- Later Today
- Tomorrow
- Next Monday
- Pick Date
- Unsnooze, only when currently snoozed

My Day does not add Snooze because removal from My Day is the established local
planning action. The mobile action sheet remains the touch fallback.

## Dashboard and My Day composition

| Concern | Dashboard | My Day |
|---|---|---|
| Existing surface actions | Snooze, My Day | Focus, time-block, remove from My Day |
| Priority badge | Filter control | Display only |
| Status badge | Filter control | Usually absent for default To Do |
| Drag behavior | None | Actions must not start drag |
| New full-width actions | Add/change date, Notes, Status, Priority | Add/change date, Notes, Status, Priority |

My Day is denser because it already has Focus and time-block. Preserve its
surface-specific actions first, then show Status and Priority only when the
container has enough room. Never allow actions to overlap trailing metadata.

## Component direction

Build shared primitives under `src/components/task-row/`:

```text
TaskRowActions
TaskDueDateControl
TaskDueDatePopover
TaskNotesIndicator
TaskStatusPopover
TaskPriorityPopover
TaskSnoozePopover
```

`TaskRowActions` owns responsive visibility and presentation, not data fetching.
Consumers pass supported callbacks and capability flags. Missing callbacks omit
the action.

This work can precede the broader shared-layout phase in
`docs/design/taskrow-consolidation.md`, while remaining compatible with its
eventual `TaskRowLayout` action slot.

## Accessibility

- Every icon button has an explicit accessible name and tooltip.
- Hover actions also reveal through `:focus-within` and remain in logical tab
  order.
- Controls unavailable at a width use `display: none`, not opacity alone.
- Interactive state pills have visible hover/focus styling and action-oriented
  labels such as "Change due date."
- Popovers support arrow keys, Enter/Space, Escape, outside dismissal, and focus
  restoration.
- Notes presence is not conveyed only by the blue dot; accessible text says
  "Open notes" or "Add notes."
- Touch targets are at least 32px on desktop and 44px in mobile action sheets.
- Reduced-motion preferences disable nonessential opacity/scale transitions.

## Error and capability behavior

- Disable only the affected action while its mutation is pending.
- On mutation failure, retain visible task state and show the standard error
  toast.
- At full width, read-only write actions may remain disabled with an explanatory
  tooltip. At medium/narrow widths, omit them to conserve space.
- Local My Day actions remain enabled for read-only connectors.
- Capability changes after sync update controls without a page reload.

## Rollout

1. Add `hasDescription` to Dashboard and My Day list contracts.
2. Extract or expose the existing expanded Notes dialog and wire its controller.
3. Extract shared due-date, Status, Priority, and Snooze popovers.
4. Add the shared responsive action composition to Dashboard and My Day.
5. Validate keyboard, read-only, compact, bulk-selection, drag, and mobile paths.

## Acceptance criteria

- Action icons appear on hover/focus; applicable state remains visible without
  interaction.
- Dated tasks use the date pill as the only due-date trigger; undated tasks use a
  calendar shortcut.
- Notes open the existing expanded Notes dialog in Read or Edit mode as defined.
- No inline title-edit action is added.
- Status, Priority, and Snooze open the documented pickers.
- Dashboard priority/status badges continue filtering.
- Dashboard and My Day share action/popover primitives.
- No `ResizeObserver` is introduced for visual breakpoints.
- List APIs expose notes presence without returning full descriptions.
- All task mutations honor connector write capability.
- Hover, keyboard focus, right-click, bulk selection, compact mode, My Day drag,
  and mobile action-sheet behavior have automated coverage.

## Open implementation question

My Day's Focus and time-block actions make its full-width row denser than
Dashboard. Test realistic long titles and metadata at 768px. If the complete
group cannot fit, raise the My Day threshold for Status and Priority instead of
allowing overlap.
