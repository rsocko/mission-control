import { z } from 'zod';

export const PHASE_PLANNING_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#14b8a6',
] as const;

export interface PhasePlanningTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  tags: string[];
}

export interface PhasePlanningContextTask extends PhasePlanningTask {
  status: string;
  connectorType: string;
  sourceListName: string | null;
  updatedAt: string;
  description: string | null;
  projectNames: string[];
}

export interface PhaseProposal {
  phases: Array<{
    name: string;
    description: string;
    color: string;
    estimatedDays: number;
    taskIds: string[];
    reasoning: string;
  }>;
  overallReasoning: string;
  suggestedNewTasks: Array<{
    title: string;
    description: string;
    phase: string;
    reasoning: string;
  }>;
  suggestedClosures: Array<{
    taskId: string;
    title: string;
    reasoning: string;
  }>;
}

export type PhaseProposalBehavior =
  | {
      kind: 'suggest';
      phaseCount?: number;
    }
  | {
      kind: 'refine';
      currentPhases: Array<{ name: string; taskIds: string[] }>;
      instruction?: string;
    };

export const aiPhaseProposalSchema = z.object({
  phases: z.array(z.object({
    name: z.string().catch('Untitled phase'),
    description: z.string().catch(''),
    color: z.string().nullable().optional().catch(undefined),
    estimatedDays: z.union([z.number(), z.string()]).nullable().optional().catch(undefined),
    taskIds: z.array(z.string()).catch([]),
    reasoning: z.string().catch(''),
  })).catch([]),
  overallReasoning: z.string().catch(''),
  suggestedNewTasks: z.array(z.object({
    title: z.string().catch('Follow-up task'),
    description: z.string().catch(''),
    phase: z.string().catch(''),
    reasoning: z.string().catch(''),
  })).catch([]),
  suggestedClosures: z.array(z.object({
    taskId: z.string().catch(''),
    title: z.string().catch(''),
    reasoning: z.string().catch(''),
  })).catch([]),
});

function priorityWeight(priority: string) {
  switch (priority) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    default:
      return 1;
  }
}

function normalizeColor(color: string | null | undefined, index: number) {
  return color && /^#[0-9a-fA-F]{6}$/.test(color)
    ? color.toLowerCase()
    : PHASE_PLANNING_COLORS[index % PHASE_PLANNING_COLORS.length];
}

function coerceEstimatedDays(
  value: string | number | null | undefined,
  taskCount: number,
) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return Math.max(1, Math.ceil(taskCount / 3));
}

function buildDuplicateClosureSuggestions(projectTasks: PhasePlanningTask[]) {
  const titleMap = new Map<string, PhasePlanningTask[]>();

  for (const task of projectTasks) {
    const normalized = task.title.trim().toLowerCase();
    if (!normalized) continue;
    const bucket = titleMap.get(normalized) || [];
    bucket.push(task);
    titleMap.set(normalized, bucket);
  }

  return [...titleMap.values()]
    .filter((bucket) => bucket.length > 1)
    .flatMap((bucket) => bucket.slice(1))
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      reasoning: 'This appears to duplicate another task with the same title and may be safe to close or merge.',
    }));
}

function sortFallbackTasks(projectTasks: PhasePlanningTask[]) {
  return [...projectTasks].sort((a, b) => {
    const dueA = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const dueB = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const scoreA = priorityWeight(a.priority) * 1000 - dueA;
    const scoreB = priorityWeight(b.priority) * 1000 - dueB;
    return scoreB - scoreA;
  });
}

function buildSuggestFallback(
  projectTasks: PhasePlanningTask[],
  phaseCount?: number,
): PhaseProposal {
  const sortedTasks = sortFallbackTasks(projectTasks);
  const targetPhaseCount = Math.max(
    1,
    Math.min(
      phaseCount || Math.ceil(sortedTasks.length / 5) || 1,
      Math.min(sortedTasks.length, 6),
    ),
  );
  const perPhase = Math.ceil(sortedTasks.length / targetPhaseCount);

  const phases = Array.from({ length: targetPhaseCount }, (_, index) => {
    const slice = sortedTasks.slice(index * perPhase, (index + 1) * perPhase);
    const tagCounts = new Map<string, number>();
    for (const task of slice) {
      for (const tag of task.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }

    const dominantTag = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      name: dominantTag ? `Phase ${index + 1}: ${dominantTag}` : `Phase ${index + 1}`,
      description: dominantTag
        ? `Focus on ${dominantTag.toLowerCase()} work while keeping urgent tasks early.`
        : 'Balanced fallback grouping based on urgency and rough workload.',
      color: PHASE_PLANNING_COLORS[index % PHASE_PLANNING_COLORS.length],
      estimatedDays: Math.max(1, Math.ceil(slice.length / 3)),
      taskIds: slice.map((task) => task.id),
      reasoning: dominantTag
        ? 'Grouped tasks with similar tags and placed higher-priority work earlier in the sequence.'
        : 'Grouped tasks by priority and due date to create a sensible execution order.',
    };
  }).filter((phase) => phase.taskIds.length > 0);

  return {
    phases,
    overallReasoning: 'Fallback plan grouped tasks by urgency first, then balanced the workload across phases.',
    suggestedNewTasks: [],
    suggestedClosures: buildDuplicateClosureSuggestions(projectTasks),
  };
}

function buildRefineFallback(
  projectTasks: PhasePlanningTask[],
  currentPhases: Array<{ name: string; taskIds: string[] }>,
  instruction?: string,
): PhaseProposal {
  const sortedTasks = sortFallbackTasks(projectTasks);
  const phaseCount = Math.max(
    1,
    Math.min(currentPhases.length, Math.max(1, sortedTasks.length)),
  );
  const perPhase = Math.ceil(sortedTasks.length / phaseCount);

  const phases = currentPhases.slice(0, phaseCount).map((phase, index) => {
    const slice = sortedTasks.slice(index * perPhase, (index + 1) * perPhase);
    return {
      name: phase.name,
      description: `Refined placement for ${phase.name.toLowerCase()}.`,
      color: PHASE_PLANNING_COLORS[index % PHASE_PLANNING_COLORS.length],
      estimatedDays: Math.max(1, Math.ceil(slice.length / 3)),
      taskIds: slice.map((task) => task.id),
      reasoning: 'Rebalanced tasks by urgency while keeping the existing phase structure.',
    };
  }).filter((phase) => phase.taskIds.length > 0);

  return {
    phases,
    overallReasoning: instruction
      ? `Fallback refinement applied the instruction "${instruction}" as closely as possible by rebalancing urgent work earlier.`
      : 'Fallback refinement rebalanced urgent work earlier while preserving the existing phase structure.',
    suggestedNewTasks: [],
    suggestedClosures: buildDuplicateClosureSuggestions(projectTasks),
  };
}

function buildFallbackProposal(
  projectTasks: PhasePlanningTask[],
  behavior: PhaseProposalBehavior,
) {
  return behavior.kind === 'suggest'
    ? buildSuggestFallback(projectTasks, behavior.phaseCount)
    : buildRefineFallback(projectTasks, behavior.currentPhases, behavior.instruction);
}

function fallbackPhaseName(index: number, behavior: PhaseProposalBehavior) {
  if (behavior.kind === 'refine') {
    return behavior.currentPhases[index]?.name || `Phase ${index + 1}`;
  }
  return `Phase ${index + 1}`;
}

export function parsePhaseProposalText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced?.[1]?.trim()
    || text.match(/\{[\s\S]*\}/)?.[0]?.trim()
    || null;

  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
}

export function normalizePhaseProposal(
  raw: unknown,
  projectTasks: PhasePlanningTask[],
  behavior: PhaseProposalBehavior,
): PhaseProposal {
  const parsed = aiPhaseProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return buildFallbackProposal(projectTasks, behavior);
  }

  const taskIds = new Set(projectTasks.map((task) => task.id));
  const taskTitleById = new Map(projectTasks.map((task) => [task.id, task.title]));
  const closureTaskIds = new Set(
    parsed.data.suggestedClosures
      .filter((task) => task.taskId && taskIds.has(task.taskId))
      .map((task) => task.taskId),
  );
  const assigned = new Set<string>();

  const phases = parsed.data.phases
    .map((phase, index) => {
      const uniqueTaskIds = phase.taskIds.filter((taskId) => {
        if (
          !taskIds.has(taskId)
          || closureTaskIds.has(taskId)
          || assigned.has(taskId)
        ) return false;
        assigned.add(taskId);
        return true;
      });

      return {
        name: phase.name.trim() || fallbackPhaseName(index, behavior),
        description: phase.description.trim(),
        color: normalizeColor(phase.color, index),
        estimatedDays: coerceEstimatedDays(phase.estimatedDays, uniqueTaskIds.length),
        taskIds: uniqueTaskIds,
        reasoning: phase.reasoning.trim(),
      };
    })
    .filter((phase) => phase.taskIds.length > 0);

  const unassignedTaskIds = projectTasks
    .map((task) => task.id)
    .filter((taskId) => !assigned.has(taskId) && !closureTaskIds.has(taskId));

  if (unassignedTaskIds.length > 0) {
    if (phases.length === 0) {
      phases.push({
        name: fallbackPhaseName(0, behavior),
        description: 'Recovered unassigned tasks from the AI response.',
        color: PHASE_PLANNING_COLORS[0],
        estimatedDays: Math.max(1, Math.ceil(unassignedTaskIds.length / 3)),
        taskIds: unassignedTaskIds,
        reasoning: behavior.kind === 'refine'
          ? 'These tasks were not assigned by the model, so they were collected into the first phase.'
          : 'These tasks were not assigned by the model, so they were collected into a single phase.',
      });
    } else {
      phases[phases.length - 1] = {
        ...phases[phases.length - 1],
        taskIds: [...phases[phases.length - 1].taskIds, ...unassignedTaskIds],
        reasoning: phases[phases.length - 1].reasoning
          || 'Unassigned tasks were appended to keep every task represented.',
      };
    }
  }

  if (phases.length === 0) {
    return buildFallbackProposal(projectTasks, behavior);
  }

  return {
    phases,
    overallReasoning: parsed.data.overallReasoning.trim() || (
      behavior.kind === 'refine'
        ? 'The phases were refined to improve sequence, balance, and dependency order.'
        : 'Tasks were grouped into sequential phases based on theme, urgency, and inferred dependencies.'
    ),
    suggestedNewTasks: parsed.data.suggestedNewTasks
      .filter((task) => task.title.trim().length > 0)
      .map((task) => ({
        title: task.title.trim(),
        description: task.description.trim(),
        phase: task.phase.trim(),
        reasoning: task.reasoning.trim(),
      })),
    suggestedClosures: parsed.data.suggestedClosures
      .filter((task) => task.taskId && taskIds.has(task.taskId))
      .map((task) => ({
        taskId: task.taskId,
        title: task.title.trim() || taskTitleById.get(task.taskId) || 'Untitled task',
        reasoning: task.reasoning.trim(),
      })),
  };
}

export function buildPhasePlanningTaskContext(
  projectTasks: PhasePlanningContextTask[],
) {
  return projectTasks.map((task, index) => [
    `${index + 1}. [${task.id}] "${task.title}"`,
    `priority: ${task.priority}`,
    `status: ${task.status}`,
    `due: ${task.dueDate || 'none'}`,
    `tags: ${task.tags.join(', ') || 'none'}`,
    `projects: ${task.projectNames.join(', ') || 'none'}`,
    `source: ${task.connectorType}${task.sourceListName ? ` / ${task.sourceListName}` : ''}`,
    `updated: ${task.updatedAt}`,
    `description: ${(task.description || 'none').replace(/\s+/g, ' ').slice(0, 280)}`,
  ].join(' | ')).join('\n');
}
