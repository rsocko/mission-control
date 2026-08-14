---
title: "Sequential Project Next Task"
status: proposed
created: 2026-08-04
last_reviewed: 2026-08-04
category: design
related:
  - "[Issue #1315](https://github.com/rsocko/mission-control/issues/1315)"
  - "[Mindwtr](https://github.com/dongdongbh/Mindwtr)"
---

# Sequential Project Next Task

> UX mockup: [Projects landing and Plan list](../../mockups/mockup-sequential-project-next-task.svg)

## Decision

Implement both discovery surfaces, but keep each one focused on its job:

1. The **Projects landing page** surfaces the action currently available from each sequential project.
2. The project **Plan list** offers an **All tasks / Available now** lens only when sequencing is enabled.

Do not add a generic `Next` task status or a universal `Next` filter. Availability is derived from project settings, task completion, and plan order. The Plan remains the authoritative place to inspect and edit the complete sequence.

## Why

Mindwtr separates planning from execution:

- project rows preview a next action;
- project detail retains the complete task list;
- sequential projects distinguish available work from later work;
- completing an available action advances the sequence.

Mission Control already previews a task as `Next` on up to three recently active project cards. That value is currently the most recently updated incomplete task, not the first incomplete task in plan order. It therefore looks authoritative without following the semantics proposed in #1315.

The UX should answer two different questions:

| Surface | User question | Design response |
|---|---|---|
| Projects landing | What can I pick up across my projects? | Show derived available actions for sequential projects |
| Project Plan | What is the full plan, and what is actionable now? | Show all work by default, with an optional Available now lens |

## Terminology

Use **Available now** in user-facing controls and explanatory copy. It describes derived availability without introducing another persisted task status.

Use compact **Next** and **Later** badges inside the full Plan list:

- **Next**: available under the current sequencing rule;
- **Later**: incomplete but blocked by an earlier task in the same sequence.

Do not label non-sequential tasks `Next` or `Later`.

## Sequencing model

Projects gain:

```ts
isSequential: boolean
sequentialScope: 'project' | 'section'
```

Defaults:

- `isSequential = false`
- `sequentialScope = 'project'`

Availability is computed rather than stored:

- completed and cancelled tasks are excluded;
- project scope exposes the first incomplete task in the project's canonical Plan order;
- section scope exposes the first incomplete task in each section or phase;
- a section without an incomplete task exposes nothing;
- tasks without a phase participate in one separate unassigned sequence when scope is `section`;
- reordering tasks or phases can change availability immediately;
- completing or cancelling the available task advances the sequence.

The implementation must use the same stable ordering as the Plan list. `updatedAt`, due date, priority, and Smart Score must not decide sequence order.

## Projects landing

Add an **Available now** section above the complete active-project list.

### Project scope

Render one row per sequential project:

- project identity;
- `Sequential · by project`;
- one available task;
- navigation to that task in the project.

### Section scope

Render one row per sequential project with up to one available task per section. Show the section name with each task. The row may collapse overflow when a project has many sections, but the count and a route to the project must remain visible.

### Attention state

An active sequential project with no incomplete task should not silently disappear. Show it in the active-project list as:

> Needs attention · no incomplete task

The action opens the project so the user can complete, pause, or add work. This design does not automatically complete a project.

Non-sequential projects remain in the active-project list and do not appear in Available now.

## Plan list

When `isSequential` is enabled and the Plan view is `list`, show a segmented control:

- **All tasks** — default;
- **Available now**.

This control is a lens, not part of the existing text-search field.

### All tasks

- Preserve every phase and task in Plan order.
- Add a **Next** badge to available tasks.
- Add a subdued **Later** badge to incomplete tasks blocked by the sequence.
- Keep completed and cancelled presentation unchanged.
- Reordering remains enabled.

### Available now

- Show only available tasks.
- Preserve their phase headings for context.
- Omit empty phases.
- Keep text search composable with the lens.
- Disable drag-and-drop because hidden tasks make the resulting order ambiguous.
- Keep task completion and task-detail actions available.

The lens is hidden for non-sequential projects and for Gantt, Graph, and Assign views.

### Accessibility

- Implement the lens as an accessible single-select control with visible focus.
- Include sequencing state in task accessible names; do not rely on color.
- Announce the newly available task after completion when the user remains in Available now.
- Preserve logical keyboard order when empty phases are omitted.

## Project settings

Add a **Task sequencing** setting:

- `Parallel` — all incomplete tasks remain available;
- `Sequential by project` — one available task across the project;
- `Sequential by section` — one available task per section.

Changing sequencing updates derived availability immediately. The confirmation copy should explain that tasks are not deleted or moved.

## Empty and transition states

| State | Result |
|---|---|
| Sequential project has no tasks | Needs-attention state with Add task action |
| All tasks are complete or cancelled | Needs-attention state with Review project action |
| Available task is completed in All tasks | Next badge moves to the newly available task |
| Available task is completed in Available now | Completed row leaves; successor appears and is announced |
| Task is reordered ahead of current Next | Availability recomputes from the saved order |
| Section scope has unassigned tasks | First incomplete unassigned task is available |
| Search excludes the available task | Standard no-results state; sequencing does not change |

## Mobile behavior

Mobile project cards should show the same derived available action beneath project progress. Section scope may show the first two actions plus an overflow count.

The mobile project detail sheet keeps the full task list by default and uses a compact All / Available toggle when sequencing is enabled. The derivation and labels must match desktop.

## Out of scope

- A persisted `next` task status
- A global Next smart list
- A generic Next filter for non-sequential projects
- Automatic project completion
- Dependency-aware sequencing beyond canonical Plan order
- Project focus or a maximum focused-project WIP limit

The `isFocused` proposal in #1315 is a separate portfolio-level product decision and should not block sequential task delivery.

## Implementation notes

Likely integration points:

- project schema and API serializers for sequencing settings;
- a shared, pure availability selector used by both Projects and Plan;
- `src/lib/projects-overview/index.ts`, replacing the current recent-update-based `nextTask` derivation;
- `src/app/projects/page.tsx` and `src/components/projects/MobileProjectsView.tsx`;
- the Plan list in `src/app/projects/[id]/page.tsx`.

The shared selector should return available task IDs plus the sequence context needed by the UI. Avoid implementing separate ordering logic in each surface.

## Acceptance criteria

1. Parallel projects behave exactly as they do today.
2. Project-scoped sequencing exposes exactly one incomplete task in canonical Plan order.
3. Section-scoped sequencing exposes at most one incomplete task per section, including the unassigned sequence.
4. Projects landing, desktop Plan, and mobile surfaces agree on which tasks are available.
5. All tasks remains the default Plan lens and preserves complete planning context.
6. Available now shows only derived available tasks and cannot reorder hidden work.
7. Completing, cancelling, or reordering a task recomputes availability without persisting a `next` status.
8. Active sequential projects with no incomplete task receive a visible attention state.
9. Keyboard and screen-reader users can identify and operate the sequencing controls and task states.

## Test coverage

Add unit coverage for the shared selector across project scope, section scope, unassigned tasks, completed/cancelled tasks, empty projects, and reorder transitions.

Update portfolio-pulse tests so `nextTask` is selected by canonical order for sequential projects. Add component or end-to-end coverage for switching Plan lenses and advancing the sequence after completion.
