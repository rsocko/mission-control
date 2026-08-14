# Matrix View Redesign

> Interactive implementation mockup: [Matrix view redesign](../../mockups/mockup-matrix-redesign.html)

## Decision

Replace the card-filled Matrix with one **density-aware scatter renderer** that supports two axis presets:

| Preset | X-axis | Y-axis | Default size | Default color | Primary question |
|---|---|---|---|---|---|
| Priority x Urgency | Urgency | Priority | Smart Score | Project | What deserves attention now? |
| Priority x Effort | Effort | Priority | Smart Score | Urgency | What work provides the best return? |

Users can change the visual channels independently:

- **Size:** Smart Score, Effort, Urgency, or Uniform
- **Color:** Project, Urgency, Status, or Priority

Changing a visual channel must not change task position. Persist axis, size, and color selections as view preferences.

This is a scatter plot with spatial aggregation, not a force-directed graph. Position must remain deterministic and explainable. At low density, one dot represents one task. At high density, nearby tasks become counted clusters that resolve into individual tasks as the user filters or zooms.

## Existing work

There was no Matrix-specific mockup before this proposal. Related work includes:

- [`MatrixBoard.tsx`](../../../src/components/dashboard/matrix/MatrixBoard.tsx), the current card implementation.
- [`ticktick-competitive-analysis.md`](../../research/ticktick-competitive-analysis.md), which recommends an Eisenhower view.
- [`graph-view-exploration.html`](../graph-view-exploration.html) and [issue #1723](https://github.com/rsocko/mission-control/issues/1723), which propose Priority x Effort as a separate scatter.
- [`graph-visualization-system.md`](../graph-visualization-system.md), which establishes semantic zoom and renderer thresholds.

Priority x Effort should now be an axis preset in the Matrix rather than a separate visualization implementation. [Issue #1831](https://github.com/rsocko/mission-control/issues/1831) is the authoritative implementation tracker and supersedes the overlapping concepts in #1723 and #910.

### Replacement scope

This is a full replacement, not a compatibility redesign:

- remove the current card-based `MatrixBoard`;
- remove Matrix-only manual quadrant override controls and API behavior;
- ignore existing `metadata.eisenhower` values without migration;
- preserve the standard task fields, filters, and task-detail workflow;
- do not retain the old board as an alternate mode.

## Why cards fail

Cards optimize for reading and direct manipulation. A matrix optimizes for distribution, outliers, and relative position. The current implementation:

- gives every task equal visual weight;
- turns each quadrant into a scrollable list;
- hides relative urgency and effort inside discrete buckets;
- loses the overall distribution after a few dozen tasks;
- loads all filtered tasks without an aggregate representation.

Compact cards postpone the problem but do not solve it.

## Axis calculations

All normalized axis values use a `0..100` scale. Keep calculation functions pure, shared, and unit-tested.

### Priority

Priority is the categorical Y-axis in both presets:

| Task priority | Plot value |
|---|---:|
| Critical | 100 |
| High | 75 |
| Medium | 50 |
| Low | 25 |
| None | Needs data |

Render labeled horizontal priority bands rather than implying false precision. Collision displacement may separate identical values by a few pixels, but must not move a task into another priority band.

### Urgency

Urgency represents due-date pressure, not importance or Smart Score. Handle missing and invalid dates first, then calculate `daysUntilDue` using local calendar dates and linearly interpolate between the dated anchors:

| Due-date state | Urgency |
|---|---:|
| Overdue | 100 |
| Due today | 95 |
| Due in 1 day | 85 |
| Due in 3 days | 65 |
| Due in 7 days | 45 |
| Due in 14 days | 30 |
| Due in 30 days | 15 |
| Due in 90 or more days | 5 |
| No due date | 0, handled before interpolation |
| Invalid due date | Needs data, handled before interpolation |

Overdue tasks share an urgency value of 100 and receive an additional overdue ring. Their tooltip shows days overdue. Reminders and creation age do not alter urgency in the first implementation.

This curve is intentionally independent of the current binary `<= 3 days` classifier. The quadrant split for Priority x Urgency remains at urgency `50`, roughly distinguishing near-term work from later work.

### Effort

Mission Control already stores effort as an optional integer from 1 to 5. Normalize it with:

```text
effortPosition = ((effort - 1) / 4) * 100
```

| Effort | Plot value |
|---|---:|
| 1 | 0 |
| 2 | 25 |
| 3 | 50 |
| 4 | 75 |
| 5 | 100 |
| Missing or invalid | Needs data |

Use the existing configured effort labels in tooltips and axis ticks. Do not derive effort from `estimatedDuration`; those fields have different semantics.

## Quadrants

### Priority x Urgency

| Position | Label | Meaning |
|---|---|---|
| High priority, high urgency | Do first | Important and time-sensitive |
| High priority, low urgency | Schedule | Important but not yet pressing |
| Low priority, high urgency | Delegate | Time-sensitive but lower value |
| Low priority, low urgency | Eliminate | Reconsider or defer |

### Priority x Effort

| Position | Label | Meaning |
|---|---|---|
| High priority, low effort | Quick wins | High-value work that is inexpensive to finish |
| High priority, high effort | Strategic | High-value work requiring planning |
| Low priority, low effort | Fill work | Small work for low-energy or batch periods |
| Low priority, high effort | Reconsider | Expensive work with limited value |

The dividing line between high and low priority sits between Medium and High. The effort split sits between values 3 and 4.

## Visual encoding

### Dot size

Default to Smart Score in both presets. Size is user-selectable:

| Setting | Value source | Missing-value behavior |
|---|---|---|
| Smart Score | `task.smartScore` | Minimum visible size |
| Effort | `task.effort` from 1 to 5 | Minimum hollow dot |
| Urgency | normalized urgency from 0 to 100 | Minimum visible size |
| Uniform | fixed value | Not applicable |

Map **area**, not radius, to the selected value. The implementation can calculate a normalized value `n` from `0..1`, then use:

```text
diameter = 8 + sqrt(n) * 10
```

The base diameter remains between 8 and 18 CSS pixels. Scale that range up to 1.8x when filters leave a sparse result set, and show short task labels when no more than 20 tasks are plotted. Keep the interactive hit target at least 24 CSS pixels. Clusters have their own count-driven sizing and do not use the selected task-size metric.

### Dot color

- **Project:** categorical project palette; unassigned tasks use slate.
- **Urgency:** `0..19` slate, `20..49` blue, `50..64` amber, `65..94` orange, `95..100` red.
- **Status:** existing status colors.
- **Priority:** existing priority colors.

Priority x Urgency defaults to Project because urgency is already encoded by position. Priority x Effort defaults to Urgency because urgency is absent from the axes. An overdue ring reinforces overdue state without relying on color alone.

When color represents Project:

- one project uses a solid project color;
- two to four projects use equal pie wedges in a stable project-ID order;
- more than four projects use the first three stable colors plus a neutral "more" wedge;
- the tooltip lists every project membership.

Implement pie markers with an SVG segmented circle or CSS `conic-gradient`. The accessible name must list project names; color wedges are supplementary.

### Other states

- White outer ring: selected task
- Red double ring: overdue
- Hollow center: missing value for the selected size channel
- Reduced opacity: outside the focused quadrant or selection

## Stable placement and overlap

Do not distribute tasks merely to make quadrants look equally full. Equalized placement destroys comparison.

1. Calculate true X and Y values.
2. Map them to the current viewport.
3. Apply deterministic, graph-like collision displacement among identical or near-identical points.
4. Keep displacement within the same priority band and quadrant.
5. Aggregate dense neighbors at the current zoom level.

Use a stable hash of task ID for collision ordering. The same task must return to the same location when its values and filters have not changed.

## Dot, cluster, and density behavior

| Visible density | Representation | Interaction |
|---|---|---|
| Up to roughly 150 tasks | One dot per task | Hover/focus previews; click opens task detail |
| Roughly 150-1,000 tasks | Counted spatial clusters with isolated dots retained | Click cluster to inspect; use Zoom in or the zoom slider |
| More than 1,000 tasks | Binned density overview | Require zoom or filtering before individual dots appear |

Thresholds also account for viewport size and local overlap.

Clusters are temporary viewport aggregates, not persisted entities. A cluster exposes:

- task count;
- X and Y ranges using the active axis labels;
- average Smart Score and effort;
- urgency range and overdue count;
- dominant value for the active color channel;
- when coloring by Project, a project-distribution pie using the same three-colors-plus-neutral cap as task markers;
- top three tasks by Smart Score;
- Zoom in and Inspect all actions.

Zoom re-bins the same data at finer resolution. It must not merely magnify a fixed cluster.

Both cluster inspection and zoom are part of the replacement release:

- clicking a cluster opens its compact inspector;
- the inspector includes Zoom in and Inspect all;
- the toolbar provides a continuous zoom slider and Reset;
- zooming with the slider or cluster action runs the same projection pipeline.

## Interaction model

### Toolbar

The implementation toolbar contains:

1. Axis preset segmented control: Priority x Urgency / Priority x Effort
2. Size select: Smart Score / Effort / Urgency / Uniform
3. Color select: Project / Urgency / Status / Priority
4. Table/Matrix toggle
5. Zoom slider and Reset controls

Switching axis preset applies that preset's default color only until the user explicitly chooses a color. Size remains Smart Score unless the user changes it.

### Hover and focus

Every task tooltip includes:

- title, project, and status;
- priority;
- due date and calculated urgency;
- effort value and configured label;
- Smart Score;
- placement explanation for the active axes.

Hover and keyboard focus expose the same content.

### Click

- **Task dot:** open the existing task detail pane while keeping the plot visible.
- **Cluster:** open a compact cluster inspector.
- **Empty plot area:** clear selection.
- **Quadrant label/count:** focus that quadrant.
- **Needs data count:** open a list grouped by missing Priority, Effort, or valid Due Date.

Do not use a modal.

### Dragging

Do not support free dragging in the first scatter implementation. The plotted values come from task fields, so arbitrary movement would misrepresent data.

A later direct-manipulation phase may map drag operations to explicit field edits:

- vertical drag changes Priority after confirmation;
- horizontal drag in Priority x Effort changes Effort after confirmation;
- horizontal drag in Priority x Urgency changes Due Date only through a date chooser, never by inferring a hidden date from pixels.

## Missing data

- Missing Priority: excluded from both plots and counted in Needs data.
- Missing Effort: excluded only from Priority x Effort; still visible in Priority x Urgency.
- Missing Due Date: urgency `0` and still plotted, but reported as a data gap. This means "no deadline pressure" for placement while keeping incompleteness visible.
- Invalid Due Date: excluded from Priority x Urgency and reported in Needs data.
- Missing Smart Score while sizing by Smart Score: render at minimum size.

The toolbar shows plotted and field-completeness counts regardless of the active mode, for example:

- Priority x Urgency: `383 plotted · 17 need priority · 3 invalid due dates`
- Priority x Effort: `344 plotted · 17 need priority · 42 need effort`

## Accessibility

- Provide a synchronized sortable table with Task, Priority, Urgency, Due Date, Effort, Smart Score, Project, and Status.
- Every dot and cluster must be keyboard focusable in a predictable order.
- Hover and focus expose equivalent tooltip content.
- Announce axis, encoding, selection, and zoom changes through a polite live region.
- Do not encode any state only by color or size.
- Respect reduced-motion preferences.
- Keep interactive hit targets at least 24 CSS pixels.

### Mobile

- Default to the synchronized table on mobile.
- Provide an explicit Full-screen Matrix action.
- Full-screen Matrix retains axis/size/color controls, pinch or button zoom, cluster inspection, and a bottom-sheet task detail.
- Restore the user's last mobile Table/Matrix choice independently of desktop.

### Preference persistence

Persist axis, size, color, zoom reset state, and mobile Table/Matrix choice through the existing persisted dashboard view store. These are per-device view preferences and do not require database schema or API changes.

## Suggested implementation boundaries

```text
src/lib/matrix/scales.ts
  priorityPosition(priority)
  urgencyScore(dueDate, today)
  effortPosition(effort)
  markerDiameter(value, domain)

src/lib/matrix/projection.ts
  projectTask(task, axisMode)
  clusterProjectedTasks(tasks, viewport, zoom)

src/components/dashboard/matrix/
  MatrixScatter.tsx
  MatrixToolbar.tsx
  MatrixTooltip.tsx
  MatrixClusterInspector.tsx
  MatrixDataTable.tsx
```

Suggested types:

```typescript
type MatrixAxisMode = 'priority-urgency' | 'priority-effort';
type MatrixSizeMode = 'smart-score' | 'effort' | 'urgency' | 'uniform';
type MatrixColorMode = 'project' | 'urgency' | 'status' | 'priority';
```

Keep scoring and projection independent of Recharts so calculations and clustering are testable without rendering.

## Delivery path

### Replacement release

- Add the scale functions and boundary tests.
- Render both axis presets with individual task dots.
- Add working size/color selectors and persisted preferences.
- Add tooltip, click-to-detail, keyboard focus, and table fallback.
- Show excluded/missing-data counts.
- Add viewport-aware clustering and semantic zoom.
- Add cluster inspector, cluster Zoom in, toolbar zoom slider, quadrant focus, and reset.
- Replace the current board and remove Matrix-only manual override behavior.
- Default mobile to the table with a full-screen Matrix mode.
- Profile with 100, 500, 1,000, and 5,000-task fixtures.

### Follow-up candidates

- Add box selection if cluster inspection does not cover multi-task workflows.
- Evaluate field-aware dragging only after observing scatter usage.

## Research references

| Reference | Lesson |
|---|---|
| [TickTick analysis](../../research/ticktick-competitive-analysis.md) | Preserve familiar Eisenhower actions |
| [Miro Eisenhower Matrix](https://miro.com/templates/eisenhower-matrix/) | Clear axes are useful; free-form stickies do not scale |
| [Kumu metrics and MICMAC](https://docs.kumu.io/guides/metrics.md) | Computed continuous positions can remain explainable |
| [Observable D3 Hexbin](https://observablehq.com/@d3/hexbin) | Aggregate spatial overlap rather than hiding points |
| [Fibery Impact-Effort Matrix](https://fibery.com/blog/product-management/impact-effort-matrix/) | Priority x Effort supports different decisions from Eisenhower |
| [Mission Control graph design](../graph-visualization-system.md) | Reuse semantic zoom and level-of-detail conventions |
