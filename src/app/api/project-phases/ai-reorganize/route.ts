import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { z } from 'zod';
import { ApiErrors } from '@/lib/api-error';
import {
  getAsyncAIModel,
  getAsyncAIProviderConfiguration,
  getAsyncAIRouteOutcome,
} from '@/lib/ai/provider-runtime';
import {
  buildPhasePlanningTaskContext,
  parsePhaseProposalText,
  PHASE_PLANNING_COLORS,
} from '@/lib/projects/phase-planning';
import { normalizePhaseReorganizationProposal } from '@/lib/projects/phase-reorganization';
import { getProjectHierarchySnapshot } from '@/lib/projects/hierarchy-service';
import {
  getHubProject,
  listPhasePlanningTasks,
} from '@/lib/projects/organization-service';
import { getLocalToday } from '@/lib/utils/date';

const requestSchema = z.object({
  projectId: z.string().trim().min(1),
  phaseId: z.string().trim().min(1),
  instruction: z.string().trim().max(4000).optional(),
});

export async function POST(request: Request) {
  try {
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return ApiErrors.badRequest('Invalid request body');

    const { projectId, phaseId, instruction } = parsed.data;
    const [project, hierarchy] = await Promise.all([
      getHubProject(projectId),
      getProjectHierarchySnapshot(projectId),
    ]);
    if (!project || !hierarchy) return ApiErrors.notFound('Project');

    const sourcePhase = hierarchy.phases.find((phase) => phase.id === phaseId);
    if (!sourcePhase) return ApiErrors.notFound('Phase');
    const allTaskIds = hierarchy.phases.flatMap((phase) => (
      (hierarchy.phaseItemsByPhase[phase.id] ?? []).map((item) => item.taskId)
    ));
    const projectTasks = await listPhasePlanningTasks([...new Set(allTaskIds)]);
    const sourceTaskIds = new Set(
      (hierarchy.phaseItemsByPhase[phaseId] ?? []).map((item) => item.taskId),
    );

    if (sourceTaskIds.size === 0) {
      return NextResponse.json({
        proposal: normalizePhaseReorganizationProposal(null, hierarchy, phaseId),
      });
    }
    if (!(await getAsyncAIProviderConfiguration()).configured) {
      return NextResponse.json({ error: 'AI provider is not configured' }, { status: 503 });
    }

    const route = await getAsyncAIModel('project-phase-refinement', {
      sources: projectTasks.map((task) => task.connectorType),
    });
    const phaseContext = hierarchy.phases.map((phase, index) => [
      `${index + 1}. [${phase.id}] "${phase.name}"`,
      `status: ${phase.status}`,
      `description: ${phase.description || 'none'}`,
      `tasks: ${(hierarchy.phaseItemsByPhase[phase.id] ?? []).map((item) => item.taskId).join(', ') || 'none'}`,
    ].join(' | ')).join('\n');

    const result = await generateText({
      model: route.model,
      system: `You are a project information-architecture assistant reviewing one large phase.

Prefer the smallest coherent change. You may keep the phase as-is, move some of its tasks into an existing phase, or create focused new phases. Consider every project phase for context, but ONLY assign task IDs that currently belong to the selected phase. Do not create tasks, close tasks, or reorganize tasks from other phases.

Use existing phase IDs exactly as provided. For new phases, use null for phaseId. Use colors from this palette when possible: ${PHASE_PLANNING_COLORS.join(', ')}.

Return JSON only:
{
  "recommendation": "keep" | "reorganize",
  "overallReasoning": "string",
  "destinations": [{
    "kind": "existing" | "new",
    "phaseId": "existing phase ID or null",
    "name": "phase name",
    "description": "string",
    "color": "#hex or null",
    "estimatedDays": 3,
    "taskIds": ["selected-phase-task-id"],
    "reasoning": "Why these tasks belong here"
  }]
}`,
      messages: [{
        role: 'user',
        content: [
          `Today: ${getLocalToday()}`,
          `Project: ${project.name} — ${project.description || 'no description'}`,
          `Selected phase: [${sourcePhase.id}] "${sourcePhase.name}"`,
          `Guidance: ${instruction || 'none'}`,
          '',
          'Current phases:',
          phaseContext,
          '',
          `All project tasks (${projectTasks.length}):`,
          buildPhasePlanningTaskContext(projectTasks),
        ].join('\n'),
      }],
    });

    return NextResponse.json({
      proposal: normalizePhaseReorganizationProposal(
        parsePhaseProposalText(result.text),
        hierarchy,
        phaseId,
      ),
      routing: getAsyncAIRouteOutcome(route, result.response),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to review phase structure', error);
  }
}
