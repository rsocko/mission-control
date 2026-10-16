---
title: "Contextual Planning"
status: proposed
created: 2026-10-16
last_reviewed: 2026-10-16
category: design
issues:
  - "#2313 — Contextual planning epic"
  - "#2314 — Scope and candidate retrieval contracts"
  - "#2315 — Planning API and recommendation result surface"
  - "#2316 — Balanced portfolio policy and explanations"
  - "#2317 — Contextual entry points and guided controls"
  - "#2318 — Planning intent and decaying momentum"
  - "#2319 — Evaluation, telemetry, and staged rollout"
  - "#2320 — Smart Score importance/execution-fit separation"
  - "#2321 — Houston page-context integration"
related:
  - "[AI Assistant Completion](../active/ai-assistant-completion.md)"
  - "[Wave Planning](../active/wave-planning.md)"
  - "[Search UX Redesign](../active/search-ux-redesign.md)"
  - "[Task Activity History](https://github.com/rsocko/mission-control/issues/2094)"
  - "[Daily Capacity Planning](https://github.com/rsocko/mission-control/issues/1589)"
---

# Contextual Planning

## Summary

Contextual Planning is Mission Control's shared answer to:

> Given the work I am looking at and the session I have available, what is the
> best balanced set of things to do next?

It replaces the current collection of narrow planning behaviors with one
scope-aware recommendation contract used by My Day, projects, project phases,
source/list views, ad hoc selected scopes, and Houston.

Contextual Planning does **not** redefine Smart Score. Smart Score remains a
deterministic measure of attention-worthiness and importance across the user's
work. Contextual Planning combines importance with current execution fit,
explicit intent, momentum, commitments, available time, energy, scope, and
portfolio balance.

The planner returns a small, explainable portfolio rather than a single opaque
ranking:

- **Anchor work** — the consequential item worth making meaningful progress on
- **Explicit commitments** — work the user put in My Day, Focus, a schedule, or
  an active phase
- **Quick wins** — bounded work that fits the available session and creates
  momentum
- **Maintenance/admin** — necessary upkeep that prevents avoidable backlog or
  operational drag

The mix adapts to the request. A 15-minute session may contain only a quick win
or maintenance item. A project-scoped 3-hour session should normally include an
anchor and a supporting commitment. Portfolio dimensions are policy goals, not
four mandatory slots.

## Product Boundary

### Smart Score

Smart Score answers:

> Which tasks deserve attention?

It should be stable enough to support sorting, triage, and cross-scope
importance comparisons. It may use priority, urgency, entity relevance,
planning horizon, source trust, freshness, and anti-neglect signals.

Execution fit should be removed from Smart Score. A short task is not inherently
more important than a long task, and missing effort or duration is not evidence
that work matters less.

### Contextual Planning

Contextual Planning answers:

> Which attention-worthy work fits this scope and this moment, and what
> combination gives the user a credible next session?

It can use Smart Score as one importance signal, but candidate retrieval must
not be only the top N Smart Score results. It explicitly reasons over distinct
candidate pools, execution context, user intent, momentum, and portfolio
coverage.

### Phase Planning

Project phase planning answers:

> How should a body of work be organized and sequenced?

Contextual Planning may use the current project phase as scope or context, but
it does not replace phase creation, phase ordering, dependency planning, or
Gantt-style planning.

## Goals

- Make "what should I do next?" available from the place where the user is
  already working.
- Return a balanced and credible session plan, not only the easiest or
  highest-scoring tasks.
- Treat explicit user intent as first-class evidence.
- Preserve momentum without allowing stale In Progress work to dominate
  forever.
- Use recent My Day history as decaying intent, including incomplete prior-day
  commitments.
- Explain why each recommendation was selected, what evidence is missing, and
  how confident the planner is.
- Share one contract across deterministic UI, AI-assisted explanation, Houston,
  desktop, mobile, SQLite, and PostgreSQL.
- Keep recommendations reviewable and non-destructive until the user explicitly
  applies an action.

## Non-Goals

- Replacing Smart Score with an AI-generated score
- Automatically completing, rescheduling, reprioritizing, or changing source
  tasks without review
- Requiring duration, effort, energy tags, or complete task history before the
  planner can work
- Building a full calendar constraint solver in the first release
- Replacing project phase planning or daily capacity planning
- Treating every task update as meaningful progress
- Persisting model chain-of-thought

## Current State

Mission Control already has several partial planning systems:

- My Day exposes `AI Plan Day`, Focus 3 suggestions, planning-signal groups,
  due/overdue groups, recent work, carried-forward work, and schedule data.
- `/api/ai/whats-next` retrieves only the top 20 Smart Score tasks and asks a
  model to select 1-3 actions from the top 10.
- `suggestDayPlan` retrieves only overdue, due-today, critical, and high
  priority tasks.
- `/api/ai/plan-day` uses My Day plus a truncated set of open high-priority
  tasks and calendar events.
- Houston receives a small global context of overdue, due-today, and In
  Progress tasks, but not the route or selected scope.
- Project pages already have Tasks and Plan/Phase tabs with robust filtering.
- My Day planning history already records committed, withdrawn, missed, focus,
  schedule-elapsed, and overdue transition events.
- Focus time activities, task schedules, subtask counts, project/phase
  membership, estimated duration, effort, and task timestamps already exist.

The problem is not missing surfaces. It is that each surface uses a different,
narrow candidate definition and no shared recommendation policy.

## Core User Journeys

### 1. My Day: build or repair today's plan

The user opens My Day and chooses **Plan this session** or **Plan my day**.

The scope defaults to:

- current My Day items;
- recent My Day commitments with decay;
- active Focus items;
- due/overdue work;
- In Progress work;
- a bounded cross-scope importance and quick-fit expansion.

The guided planner asks only for context that materially changes the result:

- available time;
- energy/focus;
- desired output size;
- optional emphasis or exclusions.

The result is a portfolio with an anchor, commitments, quick wins, and
maintenance as appropriate. The user can start one item, add items to My Day,
schedule them, replace a recommendation, or ask Houston to revise the plan.

### 2. Project: decide the next useful move

From a project Overview, Tasks, or Plan tab, the user selects **What next?**.
The project is the hard scope. The planner may use phase status, blockers,
priority, due dates, task momentum, and unfinished commitments, but it must not
leak unrelated tasks into the result.

If the project has phases, the planner defaults to active phases plus unassigned
project tasks. The user can narrow to one phase.

### 3. Project phase: execute the active slice

From a phase card or phase view, **Plan this phase** uses that phase as the hard
scope. The planner can recommend dependency-clearing or maintenance work in the
same project only when the user enables **Include supporting work**.

### 4. Source or list: work within an external context

From a source/list filter, the user selects **What should I do here?**. The
source or list is the hard scope. Source provenance remains visible in every
recommendation and all actions obey source edit policy.

### 5. Ad hoc scope: plan across selected lists or scopes

A **Plan selection** action appears when the user has:

- selected tasks;
- selected multiple lists;
- selected multiple projects/phases; or
- built a filtered task view.

The scope summary is explicit and editable before generation. A selected task
set is closed by default: the planner cannot add unrelated candidates unless
the user enables **Suggest supporting work**.

### 6. Houston: conversational planning

The user can ask:

- "What should I do next?"
- "I have 45 minutes and low energy."
- "What should I do next in Mission Control?"
- "Plan work from these three lists."
- "Give me an anchor and two quick wins from this phase."
- "Why did you choose this instead of the other GitHub issue?"

Houston resolves pronouns such as "this project" or "this list" from explicit
page context. It confirms the resolved scope in the response and uses the same
planner contract as the guided UI.

## Entry Points

| Surface | Entry point | Default scope |
|---|---|---|
| My Day | `Plan` split button | My Day plus bounded contextual expansion |
| Project Overview | `What next?` | Project |
| Project Tasks | Toolbar `Plan` | Current project and active filters |
| Project Plan/Phase | Phase menu `Plan this phase` | Phase |
| Tasks/source/list view | Toolbar or source/list menu `Plan within this` | Current canonical filters |
| Multi-select | Bulk action `Plan selection` | Selected task IDs |
| Houston | Prompt/chip/voice | Current page context, otherwise global |
| Mobile My Day | Primary `Plan next` action | My Day/contextual expansion |

The action label should reflect scope when space permits: **Plan My Day**,
**Plan this project**, **Plan this phase**, **Plan these lists**, or **Plan
selection**. Avoid a context-free sparkle button.

## Guided Planner

The guided surface is a compact sheet or side panel, not a multi-step wizard.
It uses progressive disclosure.

### Always visible

- **Scope** — human-readable summary with item count and Edit action
- **Available time** — 15m, 30m, 60m, 2h, Half day, Flexible
- **Energy/focus** — Low, Medium, High, Unspecified
- **Plan shape** — Next action, Focus set, Session plan, Day plan

### Advanced controls

- Include supporting work outside the hard scope
- Prefer commitments / balanced / clear backlog
- Include maintenance/admin
- Avoid high-energy work
- Require known duration
- Maximum recommendation count
- Excluded tasks/tags/sources

Defaults come from the invocation surface and saved user preference. The planner
must remain useful when the user accepts all defaults.

## Scope Contract

All entry points normalize into the same versioned request:

```ts
interface ContextualPlanningRequestV1 {
  scope: {
    kind:
      | 'global'
      | 'my-day'
      | 'project'
      | 'phase'
      | 'source'
      | 'list'
      | 'filtered-view'
      | 'selected-tasks'
      | 'composite';
    projectIds?: string[];
    phaseIds?: string[];
    connectorInstanceIds?: string[];
    sourceListIds?: string[];
    taskIds?: string[];
    canonicalFilter?: TaskFilterSpec;
    includeSupportingWork: boolean;
  };
  session: {
    availableMinutes?: number;
    energy?: 'low' | 'medium' | 'high';
    focusMode?: 'deep' | 'balanced' | 'light';
    startAt?: string;
  };
  output: {
    shape: 'next-action' | 'focus-set' | 'session-plan' | 'day-plan';
    maxItems: number;
    includeMaintenance: boolean;
  };
  preferences?: {
    commitmentBias?: 'prefer' | 'balanced' | 'deemphasize';
    excludedTaskIds?: string[];
  };
  invocation: {
    surface: 'my-day' | 'project' | 'phase' | 'tasks' | 'houston' | 'mobile';
    route?: string;
  };
}
```

Scope IDs are resolved server-side. The client must not send task content as
authority. Canonical filters use the shared task-filter grammar rather than
inventing planner-only filters.

## Candidate Retrieval

Candidate retrieval is deterministic, backend-neutral, bounded, and observable.
It produces a diverse union before ranking.

### Candidate pools

1. **Importance pool**
   - highest Smart Score in scope;
   - critical/high priority;
   - priority entity matches;
   - `planningHorizon = next`.
2. **Commitment pool**
   - current My Day;
   - recent My Day history;
   - Focus 3 today/week;
   - scheduled/time-blocked work;
   - current active phase commitments.
3. **Momentum pool**
   - In Progress with decayed recency;
   - recent completed subtasks;
   - recent focus sessions;
   - meaningful task content or progress edits.
4. **Deadline/risk pool**
   - overdue;
   - due today/soon;
   - blocked work whose blocker is now cleared;
   - repeated deferrals or missed commitments.
5. **Session-fit pool**
   - known duration within available time;
   - effort compatible with requested focus/energy;
   - tasks with a clear next action;
   - quick wins.
6. **Maintenance pool**
   - stale but necessary admin;
   - review/cleanup work;
   - recurring upkeep;
   - small dependency-clearing tasks.
7. **Selected pool**
   - every explicitly selected task, subject only to completion, access, and
     local-disposition eligibility.

Each applicable pool returns a small quota, normally 10-25. The deduplicated
union is capped before enrichment, normally at 100 candidates. Pool membership
is retained as explanation evidence.

The planner must not retrieve only `topSmartScore.slice(0, N)`. That pattern
systematically hides explicit commitments, stale In Progress work, quick-fit
items, and maintenance.

### Scope rules

- Hard scope is applied inside every primary pool.
- Supporting-work expansion is a separate pool with a lower quota and an
  explicit reason such as "clears a blocker for this phase."
- Completed, cancelled, deleted, snoozed, and inactive-disposition tasks are
  excluded unless the request explicitly includes them.
- Parent tasks and checklist items must not both be recommended for the same
  work unless the subtask is independently actionable.
- Source/list scopes are matched by canonical connector instance and source-list
  identity, not display name.

## Signal Model

The planner keeps importance, momentum, execution fit, commitment, and risk as
separate dimensions. It does not collapse them into a second public "score."

### Importance

- Smart Score and its factor breakdown
- task priority
- entity relevance
- deadline pressure
- planning horizon
- project/phase importance
- anti-neglect evidence

### Explicit intent and commitments

| Signal | Initial strength | Decay |
|---|---:|---|
| Manually added to current My Day | Very strong | No decay during the day |
| Auto-included in current My Day | Strong | No decay during the day |
| Focus 3 today | Very strong | No decay during the day |
| Scheduled/time-blocked today | Very strong | Becomes missed/elapsed evidence after block |
| In active project phase | Moderate | Phase-state dependent |
| Prior My Day, incomplete | Strong | Exponential/step decay over 7 days |
| Prior My Day, explicitly removed | Negative | Decays over 3 days |
| Repeated My Day misses | Mixed | Commitment plus friction; do not blindly boost |

Recent My Day intent can be modeled initially with:

```text
manual My Day weight = 1.00, 0.75, 0.50, 0.30, 0.15 for age 0-4 days
auto My Day weight   = 0.80, 0.55, 0.35, 0.20, 0.10 for age 0-4 days
```

The exact values are configuration, but tests must lock monotonic decay and the
manual-over-auto ordering.

### In Progress momentum

In Progress is strong evidence because the user started the task, but untouched
work must not keep a permanent priority bonus.

Use the latest meaningful activity timestamp, not raw `updatedAt` alone:

```text
age <= 1 day:  1.00 momentum
age <= 3 days: 0.80
age <= 7 days: 0.55
age <= 14 days: 0.30
age <= 30 days: 0.15
age > 30 days: 0.05
```

The floor remains above zero while status is In Progress. Old In Progress work
should often appear as "resume or consciously reset" rather than silently
winning the anchor slot.

### Meaningful activity taxonomy

| Activity | Momentum effect |
|---|---|
| Subtask completed | Strong |
| Focus session started/completed | Strong |
| Task scheduled or time-blocked | Strong intent |
| Status changed to In Progress | Strong, then decays |
| Description, notes, deliverable, or progress content changed | Moderate |
| Due date, priority, effort, phase, or planning horizon changed | Moderate intent, not proof of execution |
| Task created | Small, temporary |
| Tag, display order, source sync timestamp, or connector metadata changed | Little or none |
| Sync-only refresh with no semantic delta | None |

The activity classifier should consume typed task history where available. It
must not infer momentum from every `updatedAt` change.

### Execution fit

- available time versus estimated duration;
- effort/focus demand;
- current energy;
- schedule/calendar constraints;
- interruptibility or natural stopping point when known;
- task readiness and unresolved blockers.

Missing duration or effort is **unknown**, not poor fit. Unknown-fit candidates
remain eligible with neutral fit and lower confidence. A strict **Require known
duration** control may exclude them when the user explicitly chooses it.

## Ranking and Portfolio Construction

### Stage 1: eligibility

Remove ineligible candidates and attach explicit exclusion reasons for
diagnostics.

### Stage 2: dimension scoring

Normalize internal dimensions independently:

- importance;
- commitment;
- momentum;
- deadline/risk;
- execution fit;
- maintenance value;
- confidence.

These internal values are not presented as a single authoritative user-facing
number.

### Stage 3: portfolio selection

Use constrained selection rather than sorting one scalar score:

1. Select the best credible anchor when the session can support one.
2. Preserve an explicit commitment unless it is blocked, impossible, or
   strongly mismatched to the session.
3. Add one or more quick wins when they fit remaining capacity.
4. Add maintenance/admin when requested or when operational risk warrants it.
5. Avoid duplicate work, same-project overconcentration in global scope, and
   multiple recommendations that depend on the same blocked prerequisite.
6. Respect total known duration with a small configurable buffer.
7. Allow unknown-duration items, but do not pretend the capacity plan is exact.

For a `next-action` request, choose the best single action from the same
portfolio policy. Do not run a separate ranking algorithm.

### Suggested default portfolio shapes

| Session | Default shape |
|---|---|
| 15 minutes | one quick win or maintenance action |
| 30 minutes | one bounded commitment or quick win |
| 60 minutes | one anchor/commitment plus one quick win |
| 2 hours | one anchor plus one commitment/supporting action |
| Half day | anchor block, commitment, quick win, maintenance if useful |
| Flexible/day | 3-6 item balanced plan with schedule suggestions |

These are defaults, not rigid quotas.

## Recommendation Contract

```ts
interface ContextualPlanV1 {
  id: string;
  request: ContextualPlanningRequestV1;
  scopeSummary: {
    label: string;
    candidateCount: number;
    supportingCandidateCount: number;
  };
  recommendations: ContextualRecommendationV1[];
  omittedDimensions: Array<'anchor' | 'commitment' | 'quick-win' | 'maintenance'>;
  planConfidence: 'high' | 'medium' | 'low';
  planConfidenceReasons: string[];
  warnings: PlanningWarning[];
  generatedAt: string;
  policyVersion: string;
}

interface ContextualRecommendationV1 {
  taskId: string;
  role: 'anchor' | 'commitment' | 'quick-win' | 'maintenance' | 'supporting';
  rank: number;
  reason: string;
  contributingFactors: PlanningFactor[];
  missingFactors: Array<'duration' | 'effort' | 'energy' | 'activity' | 'readiness'>;
  confidence: 'high' | 'medium' | 'low';
  estimatedDuration?: number;
  source: {
    connectorType: string;
    sourceListName?: string;
  };
  actions: Array<
    | 'start-focus'
    | 'add-to-my-day'
    | 'schedule'
    | 'open-task'
    | 'replace'
  >;
}
```

The API returns structured reasons. The LLM may summarize or conversationally
explain them, but it must not invent evidence or alter the selected task IDs.

## Recommendation UI

The result surface is a compact plan, not a chat transcript.

Each recommendation shows:

- portfolio role;
- task title and source;
- one-sentence reason;
- strongest 2-4 contributing factors;
- duration/effort when known;
- confidence and missing-data disclosure;
- primary action;
- `Why this?`, `Replace`, and task detail affordances.

The plan header shows:

- resolved scope;
- session assumptions;
- total known duration plus unknown-duration count;
- plan confidence;
- `Refine with Houston`.

### Apply behavior

Generating a plan is read-only. Each mutation remains explicit:

- **Start** opens focus and may set In Progress only through the existing
  source-aware confirmation/write path.
- **Add all to My Day** previews additions and exclusions.
- **Schedule** opens schedule review.
- **Apply day plan** previews time blocks and never changes source due dates.
- **Replace** requests another candidate for the same portfolio role while
  preserving scope and constraints.

## Houston Contract

Houston receives structured invocation context:

```ts
interface HoustonPlanningContextV1 {
  route: string;
  visibleSurface: string;
  resolvedScope?: ContextualPlanningRequestV1['scope'];
  selectedTaskIds?: string[];
  selectedProjectId?: string;
  selectedPhaseId?: string;
  activeCanonicalFilter?: TaskFilterSpec;
}
```

Houston uses a read-only `getContextualPlan` tool that returns
`ContextualPlanV1`. Follow-up questions use the plan ID and structured evidence.
Mutating actions continue through existing approval and source-authority
contracts.

Houston must:

- state the resolved scope;
- ask only when scope is genuinely ambiguous;
- distinguish recommendation from commitment;
- preserve missing-factor disclosures;
- never imply that Smart Score alone selected the plan;
- never treat recalled memory as current task state;
- avoid exposing hidden candidates or private task content outside the resolved
  scope.

## Confidence

Confidence describes evidence quality, not the value of the task.

### Recommendation confidence

- **High** — strong importance/intent evidence, known readiness, and session-fit
  data.
- **Medium** — credible selection with one or two material unknowns.
- **Low** — sparse activity/fit evidence, ambiguous readiness, or heavy reliance
  on stale metadata.

### Plan confidence

Plan confidence considers:

- candidate coverage across applicable pools;
- duration coverage;
- readiness/blocker coverage;
- recency of meaningful activity;
- scope resolution quality;
- AI provider availability when explanation is requested.

Deterministic selection can still succeed when the LLM is unavailable. The UI
then shows structured reasons without conversational prose.

## Edge Cases

- **No eligible tasks** — show why the scope is empty and offer to broaden it.
- **All tasks blocked** — recommend the best blocker-clearing action or state
  that no executable work is available.
- **Only unknown-duration tasks** — return a plan with low capacity confidence;
  do not assign fake durations.
- **Tiny session** — return one fitting task or honestly say none is known to
  fit.
- **Too many commitments** — show the conflict and select a subset; do not
  pretend all can fit.
- **Stale In Progress** — surface as resume/reset decision, with low momentum.
- **Repeated My Day misses** — treat as commitment plus friction; offer
  rescope/split/defer rather than continually boosting it.
- **Selected completed/cancelled tasks** — exclude with per-item reason.
- **Mixed editable/read-only sources** — recommendations are allowed; actions
  reflect each task's edit policy.
- **Duplicate parent/subtask work** — recommend the actionable child or the
  parent, not both.
- **AI unavailable** — deterministic plan and factor explanations remain
  available.
- **Sync stale or failed** — show source freshness warning and lower confidence.
- **Large scope** — pool quotas and backend filters prevent unbounded loads.
- **Concurrent task changes** — applying actions revalidates task revision,
  status, scope, and edit policy.
- **Mobile** — default to next action/focus set; day-plan editing can open the
  fuller My Day surface.

## Technical Architecture

### Components

1. **Scope resolver**
   - validates IDs and canonical filters;
   - produces hard-scope predicates and a display summary.
2. **Candidate repository**
   - backend-neutral SQLite/PostgreSQL interface;
   - executes bounded pool queries;
   - returns pool membership and exact aggregate counts.
3. **Signal enricher**
   - loads Smart Score breakdown, My Day/focus history, meaningful activity,
     schedule, subtasks, duration/effort, project/phase, blockers, and source
     policy.
4. **Planning policy**
   - pure deterministic eligibility, dimension, confidence, and portfolio
     selection functions;
   - versioned and testable without an AI provider.
5. **Explanation layer**
   - deterministic factor labels first;
   - optional LLM summary over selected structured results only.
6. **Surface adapters**
   - guided UI, My Day, project, phase, list/filter, Houston, and mobile use the
     same request/response contract.

### Persistence

Initial release does not require a durable plan table. A generated plan can use
a signed/opaque short-lived ID and be regenerated from the request.

Persist only what improves the product:

- accepted recommendation actions through existing task/history tables;
- planner telemetry with task IDs pseudonymized or access-controlled;
- optional user feedback (`helpful`, `not relevant`, replacement reason);
- policy version and coarse factor presence;
- no chain-of-thought or raw prompt retention.

If saved or resumable plans are later required, add an explicit retention and
deletion design before storing plan contents.

### API

```text
POST /api/planning/contextual
POST /api/planning/contextual/{planId}/replace
POST /api/planning/contextual/{planId}/feedback
```

`POST /api/planning/contextual` is synchronous for bounded deterministic
selection. Optional explanation generation may stream or degrade independently.
It must not delay the structured plan beyond the interactive performance gate.

### Performance gates

- Scope resolution and candidate retrieval p95: at most 250 ms on the
  representative seeded production dataset.
- Deterministic plan available p95: at most 500 ms.
- LLM explanation never delays structured recommendation rendering.
- At most the configured quota per candidate pool and 100 candidates after
  deduplication.
- No N+1 task-history, project, tag, blocker, or source-policy reads.
- SQLite and PostgreSQL return policy-equivalent candidate sets for fixed
  fixtures.

### Security and privacy

- Enforce the same task access boundary as the invoking surface.
- Treat source task text and history as untrusted data, never instructions.
- Do not send more candidate content to the model than needed to explain the
  already-selected plan.
- Preserve connector sensitivity routing and source provenance.
- Do not expose hidden projects, lists, or tasks through supporting-work
  expansion.
- Revalidate source edit policy before every mutation.
- Telemetry must avoid raw descriptions, notes, external payloads, and secrets.

## Evaluation

### Offline policy fixtures

Create fixed scenarios covering:

- important long anchor versus several easy tasks;
- recent versus stale In Progress;
- current and decayed My Day commitments;
- missing duration handled neutrally;
- subtask completion and focus-session momentum;
- sync-only metadata update ignored;
- project/phase/list hard scoping;
- balanced portfolio with limited capacity;
- all-blocked and all-unknown cases;
- SQLite/PostgreSQL parity.

### Product metrics

- recommendation opened/started;
- recommendation added to My Day or scheduled;
- replacement rate by role;
- explicit "not relevant" rate;
- completion or meaningful activity within 24 hours;
- commitment recovery versus repeated miss;
- portfolio role coverage;
- unknown-duration prevalence;
- time to first structured result;
- explanation availability and failure rate.

Metrics evaluate utility; they do not silently retrain or change policy weights.
Weight changes are versioned and regression-tested.

## Phased Rollout

### Phase 1: Shared planning foundation

- Remove execution fit from Smart Score and preserve migration compatibility.
- Add versioned scope, candidate, signal, plan, explanation, and confidence
  contracts.
- Implement diverse candidate pools and deterministic portfolio policy.
- Implement My Day history and In Progress decay.
- Add policy fixtures, backend parity tests, and diagnostics.

### Phase 2: First-party guided surfaces

- Replace My Day's narrow What's Next/AI Plan entry with the shared planner.
- Add project, phase, source/list, filtered-view, and selected-set entry points.
- Ship recommendation cards, replace/refine, and explicit apply actions.
- Preserve current Focus, schedule, My Day, task detail, and source-write
  behavior.

### Phase 3: Houston and adaptive planning

- Add route/selection scope context to Houston.
- Add `getContextualPlan` and follow-up explanation/refinement.
- Add session/day plan variants and capacity integration.
- Add feedback telemetry, evaluation dashboards, and guarded policy tuning.

### Phase 4: Advanced planning

- Calendar-aware constraint solving.
- Learned personal fit preferences with explicit controls and deletion.
- Cross-session saved plans.
- Proactive suggestions only after usefulness and interruption thresholds are
  established.

## Acceptance Criteria

- Smart Score remains an importance/attention construct and no longer rewards
  short/easy work.
- Every specified entry point resolves to the shared scope contract.
- Candidate retrieval includes distinct importance, commitment, momentum,
  deadline, session-fit, maintenance, and selected pools where applicable.
- Recent My Day and In Progress signals decay monotonically without falling to
  zero solely because of age.
- Missing effort/duration is neutral and visibly lowers confidence rather than
  rank by default.
- Results expose portfolio role, contributing factors, missing factors, and
  confidence.
- The planner can render deterministic recommendations when AI explanation is
  unavailable.
- Applying recommendations uses existing source-aware mutation, confirmation,
  and concurrency protections.
- SQLite and PostgreSQL behavior is covered by equivalent fixtures.
- Entry-point, empty, blocked, stale-sync, unknown-fit, and concurrent-change
  states have automated coverage.

## Decisions Deferred to Implementation Validation

- Exact decay constants and candidate-pool quotas, within the monotonic and
  bounded constraints above
- Whether the first release offers a dedicated global planning page or only
  contextual sheets plus Houston
- Whether plan feedback is retained indefinitely or under a bounded retention
  period
- The point at which saved/resumable plans justify a durable plan entity
