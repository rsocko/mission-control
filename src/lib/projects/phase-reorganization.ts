import { z } from 'zod';
import type { ProjectHierarchySnapshot } from './hierarchy-types';

export const LARGE_PHASE_TASK_THRESHOLD = 12;

export interface PhaseReorganizationProposal {
  sourcePhaseId: string;
  hierarchyRevision: number;
  recommendation: 'keep' | 'reorganize';
  overallReasoning: string;
  destinations: Array<{
    kind: 'existing' | 'new';
    phaseId: string | null;
    name: string;
    description: string;
    color: string | null;
    estimatedDays: number | null;
    taskIds: string[];
    reasoning: string;
  }>;
}

const proposalSchema = z.object({
  recommendation: z.enum(['keep', 'reorganize']).catch('reorganize'),
  overallReasoning: z.string().catch(''),
  destinations: z.array(z.object({
    kind: z.enum(['existing', 'new']),
    phaseId: z.string().nullable().optional().catch(null),
    name: z.string().catch(''),
    description: z.string().catch(''),
    color: z.string().nullable().optional().catch(null),
    estimatedDays: z.union([z.number(), z.string()]).nullable().optional().catch(null),
    taskIds: z.array(z.string()).catch([]),
    reasoning: z.string().catch(''),
  })).catch([]),
});

function estimatedDays(value: string | number | null | undefined, taskCount: number) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed)
    : Math.max(1, Math.ceil(taskCount / 3));
}

export function normalizePhaseReorganizationProposal(
  raw: unknown,
  hierarchy: ProjectHierarchySnapshot,
  sourcePhaseId: string,
): PhaseReorganizationProposal {
  const sourcePhase = hierarchy.phases.find((phase) => phase.id === sourcePhaseId);
  if (!sourcePhase) throw new Error('Source phase not found');

  const sourceTaskIds = (hierarchy.phaseItemsByPhase[sourcePhaseId] ?? [])
    .map((item) => item.taskId);
  const allowedTaskIds = new Set(sourceTaskIds);
  const existingById = new Map(hierarchy.phases.map((phase) => [phase.id, phase]));
  const parsed = proposalSchema.safeParse(raw);
  const data = parsed.success ? parsed.data : {
    recommendation: 'keep' as const,
    overallReasoning: '',
    destinations: [],
  };
  const assigned = new Set<string>();

  const destinations: PhaseReorganizationProposal['destinations'] = data.destinations.flatMap((destination, index) => {
    const existing = destination.kind === 'existing' && destination.phaseId
      ? existingById.get(destination.phaseId)
      : null;
    if (destination.kind === 'existing' && !existing) return [];

    const taskIds = destination.taskIds.filter((taskId) => {
      if (!allowedTaskIds.has(taskId) || assigned.has(taskId)) return false;
      assigned.add(taskId);
      return true;
    });
    if (taskIds.length === 0) return [];

    return [{
      kind: destination.kind,
      phaseId: existing?.id ?? null,
      name: existing?.name ?? (destination.name.trim() || `New phase ${index + 1}`),
      description: existing?.description ?? destination.description.trim(),
      color: existing?.color ?? (
        destination.color && /^#[0-9a-fA-F]{6}$/.test(destination.color)
          ? destination.color.toLowerCase()
          : sourcePhase.color
      ),
      estimatedDays: existing?.estimatedDays
        ?? estimatedDays(destination.estimatedDays, taskIds.length),
      taskIds,
      reasoning: destination.reasoning.trim(),
    }];
  });

  const omittedTaskIds = sourceTaskIds.filter((taskId) => !assigned.has(taskId));
  if (omittedTaskIds.length > 0) {
    const sourceDestination = destinations.find((destination) => (
      destination.kind === 'existing' && destination.phaseId === sourcePhaseId
    ));
    if (sourceDestination) {
      sourceDestination.taskIds.push(...omittedTaskIds);
    } else {
      destinations.unshift({
        kind: 'existing',
        phaseId: sourcePhase.id,
        name: sourcePhase.name,
        description: sourcePhase.description ?? '',
        color: sourcePhase.color,
        estimatedDays: sourcePhase.estimatedDays,
        taskIds: omittedTaskIds,
        reasoning: 'These tasks stay in the current phase.',
      });
    }
  }

  const changesPlacement = destinations.some((destination) => (
    destination.kind === 'new'
    || destination.phaseId !== sourcePhaseId
  ));

  return {
    sourcePhaseId,
    hierarchyRevision: hierarchy.revision,
    recommendation: changesPlacement ? 'reorganize' : 'keep',
    overallReasoning: data.overallReasoning.trim() || (
      changesPlacement
        ? 'The proposed destinations make the phase easier to scan and maintain.'
        : 'The phase is cohesive enough to keep as-is.'
    ),
    destinations,
  };
}
