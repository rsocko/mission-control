---
title: "Task Row Inline Actions"
status: proposed
created: 2026-08-01
last_reviewed: 2026-08-25
category: design
related:
  - "[Todoist vs Mission Control](../../research/todoist-vs-mc-analysis.md)"
  - "[Interactive mockup](../../mockups/mockup-task-row-inline-actions.html)"
  - "GitHub issue #1262"
---

# Task Row Inline Actions

## Summary

Add width-aware task-row editors for due date, notes, status, and priority plus
on-demand actions such as snooze, without replacing the task detail surfaces or
context menu. Actions appear on pointer hover or keyboard focus. Existing task
state remains visible when applicable, so users can scan a row without first
interacting with it.

The interactive design is available at
[`docs/mockups/mockup-task-row-inline-actions.html`](../../mockups/mockup-task-row-inline-actions.html).
It demonstrates Dashboard and My Day rows at full, medium, and narrow container
widths, with dated/undated, existing/empty notes, keyboard-focus, menu, and
read-only states. It also includes a mixed-state alignment study with adjacent
tasks that deliberately vary due date, status, priority, and notes presence.

## Alignment follow-up

The original interaction mockup separates hover actions from a trailing state
strip. Because the task copy is flexible, this can make the action group appear
in the middle of the row while persistent state occupies the far-right edge.
That placement is intentional in the original concept, but it does not solve
cross-row comparison when neighboring tasks expose different sets of state.

The mixed-state study records the newer direction from GitHub issue #1262:

- Use shared property columns for values users compare vertically, including
  Score, Horizon, Priority, Effort, Status, and due date. These are individual
  fixed tracks, not a variable-width flex cluster.
- Keep those columns reserved when a value is absent. Hover or keyboard focus
  may reveal an add affordance inside the empty property cell.
- Show the default To Do status quietly rather than removing the status cell.
- Keep notes in a stable indicator cell.
- Keep scheduling controls ordered as Due, My Day, Notes, then Snooze. Pack
  remaining commands into a consistently ordered toolbar anchored at the
  far-right edge; unavailable commands do not leave holes inside the toolbar.
- Collapse whole property columns and toolbar actions at container breakpoints.

The preferred study is intentionally headerless. Stable position, distinctive
shape, semantic color, accessible names, and tooltips identify compact values
without adding a permanent header row or implying spreadsheet behavior.

### Current field inventory and placement

The shipped Dashboard and My Day rows expose more than due date, status,
priority, and notes. The aligned layout should account for every current field
without turning each signal into a permanent column.

| Current field or control | Recommended placement | Alignment decision |
|---|---|---|
| Completion, drag handle, and bulk checkbox | Fixed leading controls | Keep one stable leading region; each mode shows only its applicable control |
| Connector and linked-source state | Leading provenance area | Keep beside the title; do not create data columns |
| Title and external display ID | Primary content | Keep together; title receives remaining width |
| Micro-status / blocked state | Title-adjacent critical state | Keep visible; blocked must not collapse before lower-priority fields |
| Subtask progress | Title-adjacent progress | Keep beside the title rather than reserving a list-wide column |
| Source list, tags, and projects | Secondary metadata line | Keep flexible and wrapping; not comparison columns |
| Smart Score | First aligned property after task content | Include as the prominent 36×28 score badge; blank cell when unavailable |
| Planning horizon | Fixed column after Score | Include at wide widths using compact text and the production semantic color; omit the telescope icon |
| Priority | Fixed column after Horizon | Include textual P0-P3 with the production priority palette; clicking opens the picker |
| Effort | Fixed column after Priority | Include with the production XS-XL green-to-red palette |
| Status | Aligned editable state position | Use the compact semantic status icon at every width; clicking opens the picker |
| Due date | Aligned property column | Include; empty writable cells reveal Add due date on hover/focus |
| Notes presence | Stable indicator column | Include persistent Open notes or hover/focus Add notes |
| Recurrence | Secondary signal strip or overflow | Do not dedicate a column; retain icon and tooltip |
| Reschedule / push count | Secondary signal strip or overflow | Do not dedicate a column; show only when meaningful |
| Snoozed state | Secondary signal strip, then toolbar editor | Keep persistent while active; edit from the toolbar |
| Reminder | Secondary signal strip | Keep persistent while active; no dedicated column |
| Estimated duration | Secondary signal strip | Keep visible at wide widths; scheduled time supersedes it in My Day |
| Scheduled time | My Day secondary metadata | Keep beside source/tags because it is surface-specific |
| My Day membership | Aligned scheduling action after Due | Keep persistent when active; reveal the empty action on hover/focus before Notes and Snooze |
| Focus and time-block | My Day packed action toolbar | Keep as high-frequency My Day commands |
| Snooze and local disposition | Packed toolbar or overflow | Keep direct only where frequent/applicable; otherwise move to overflow |
| Mobile swipe and action sheet | Mobile-only interaction | Preserve; the desktop grid does not replace touch behavior |

At wide widths the preferred scan order is:

```text
Task | Score | Horizon | Priority | Effort | Status | Due | My Day | Notes | [Snooze · More]
```

Collapse Horizon first, then Effort. Keep the compact semantic Status icon at
every width. Score and Priority remain visible longer because they are compact,
high-value scanning signals. Critical state, title, completion, My Day, Notes,
and overflow access remain available longest. Secondary signals collapse into
overflow before core property positions disappear.

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
5. **Priority and Status property controls open their popover pickers.** A
   separated footer command offers `Filter by <current value>` and routes through
   the existing list-filter state; clicking the property itself never filters.
   Do not duplicate Priority or Status buttons in the hover toolbar. At
   every width, Status uses a compact semantic state icon while the leading
   completion control retains its existing completion behavior and related
   status coloring.
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
- Making the property click itself a filter gesture; filtering remains an
  explicit picker command or list-filter control.
- General inline editing of tags, projects, recurrence, effort, or micro-status.
- Fully merging the Dashboard and My Day row components.

## Visibility model

There are two categories of trailing controls:

| Category | Visibility | Examples |
|---|---|---|
| Property control or state indicator | Persistent when applicable | Score, Horizon, Priority, Effort, Status, due date, active My Day, notes present |
| Mutation shortcut | Hover or keyboard focus, width permitting | Add to My Day, add notes, add date, snooze, overflow |

An applicable state indicator may also be interactive. The notes indicator opens
Notes; the due-date pill opens the date picker. Priority and Status values open
their property pickers. This intentionally replaces the current Dashboard
badge-click filtering behavior; equivalent filtering stays in the list filter
controls.

## Responsive contract

Widths refer to the row container, not the viewport.

| Container width | Persistent state and properties | Hover/focus shortcuts |
|---|---|---|
| `>= 960px` | Score, Horizon, Priority, Effort, Status icon, Due, active My Day, Notes | Empty Due/My Day/Notes affordances, Snooze, and overflow |
| `480-959px` | Score, Priority, Effort, Status icon, Due, active My Day, Notes; collapse Horizon | Empty Due/My Day/Notes affordances, Snooze, and overflow |
| `< 480px` | Score, Priority, Status icon, active My Day, Notes; collapse Horizon, Effort, and Due | Empty My Day/Notes affordances and overflow; mobile action sheet retains the complete editing surface |

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
| Click Status icon | Open anchored status picker |
| Click Priority value | Open anchored priority picker |
| Click `Filter by <current value>` in either picker | Apply that value through the existing list filter and close the picker |
| Click Snooze action | Open anchored snooze picker |
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
- Blocked
- Done
- Cancelled

Completion remains available through the completion circle. Status still belongs
in the picker because moving between To Do, In Progress, and Cancelled cannot be
expressed through that control.

The compact semantic Status icon is the picker trigger at every width on both
Dashboard and My Day: outline circle for To Do, half-filled circle for In
Progress, pause circle for Blocked, check circle for Done, and X circle for
Cancelled. Color reinforces but does not solely convey the state. The leading
completion circle retains its existing completion behavior and status-aware
coloring, visually relating the two controls without giving them the same
action.

After the status choices, a divider separates `Filter by <current status>`.
This command changes the existing list filter but does not mutate the task.

## Priority picker

Use the same canonical options and colors as `TaskContextMenu`:
Critical, High, Medium, Low, and None.

The visible P0-P3 value is the picker trigger on both Dashboard and My Day. An
empty writable cell reveals the same trigger on hover/focus. Extract option
definitions to a shared module or component; do not create another local copy.

After the priority choices, a divider separates `Filter by <current priority>`.
`No priority` is a valid filter value. This command changes the existing list
filter but does not mutate the task.

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
| Priority property | Direct picker; filtering stays in list filters | Direct picker |
| Status property | Direct picker, including quiet To Do | Direct picker, including quiet To Do |
| Drag behavior | None | Actions must not start drag |
| New full-width actions | Add/change date, Notes, Snooze, overflow | Add/change date, Notes, surface actions, overflow |

My Day is denser because it already has Focus and time-block. Preserve its
surface-specific actions first. Status and Priority remain property controls,
not toolbar actions. Never allow actions to overlap trailing metadata.

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

`TaskRowActions` owns responsive command visibility and presentation, not data
fetching or property layout. Consumers pass supported callbacks and capability
flags. Missing callbacks omit the action.

The shared row primitives should preserve separate property and action regions
so the aligned layout proposed in GitHub issue #1262 can be adopted without
changing the popover behavior.

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
4. Add the shared aligned property layout and responsive action composition to
   Dashboard and My Day; route picker filter commands through the existing list
   filter state.
5. Validate keyboard, read-only, compact, bulk-selection, drag, and mobile paths.

## Acceptance criteria

- Action icons appear on hover/focus; applicable state remains visible without
  interaction.
- Dated tasks use the date pill as the only due-date trigger; undated tasks use a
  calendar shortcut.
- Notes open the existing expanded Notes dialog in Read or Edit mode as defined.
- No inline title-edit action is added.
- Status and Priority property controls, plus Snooze, open the documented
  pickers without duplicate toolbar actions.
- Status and Priority pickers expose a separated `Filter by <current value>`
  command that updates the existing list filter without mutating the task.
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
