import { NextResponse } from 'next/server';
import {
  getAsyncAIModel,
  getAsyncAIProviderConfiguration,
  getAsyncAIRouteOutcome,
} from '@/lib/ai/provider-runtime';
import { generateText } from 'ai';
import { z } from 'zod';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';
import {
  buildPhasePlanningTaskContext,
  normalizePhaseProposal,
  parsePhaseProposalText,
  PHASE_PLANNING_COLORS,
} from '@/lib/projects/phase-planning';
import {
  getHubProject,
  listPhasePlanningTasks,
} from '@/lib/projects/organization-service';
import type { PhasePlanningContextTask } from '@/db/persistence/project-organization';

const requestSchema = z.object({
  projectId: z.string().trim().min(1),
  currentPhases: z.array(z.object({
    name: z.string().trim().min(1),
    taskIds: z.array(z.string().trim().min(1)),
  })).min(1),
  instruction: z.string().trim().max(4000).optional(),
});

async function fetchPlanningTasks(taskIds: string[]) {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) {
    return [] as PhasePlanningContextTask[];
  }
  return listPhasePlanningTasks(uniqueTaskIds);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsedBody = requestSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { projectId, currentPhases, instruction } = parsedBody.data;
    const project = await getHubProject(projectId);

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const phaseTaskIds = [...new Set(currentPhases.flatMap((phase) => phase.taskIds))];
    const projectTasks = await fetchPlanningTasks(phaseTaskIds);

    if (projectTasks.length === 0) {
      return NextResponse.json({
        proposal: {
          phases: [],
          overallReasoning: 'No matching tasks were found to refine.',
          suggestedNewTasks: [],
          suggestedClosures: [],
        },
      });
    }

    if (!(await getAsyncAIProviderConfiguration()).configured) {
      return NextResponse.json({ error: 'AI provider is not configured' }, { status: 503 });
    }

    const route = await getAsyncAIModel('project-phase-refinement', {
      sources: projectTasks.map((task) => task.connectorType),
    });
    const today = getLocalToday();
    const taskContext = buildPhasePlanningTaskContext(projectTasks);
    const currentPhaseContext = currentPhases
      .map((phase, index) => `${index + 1}. ${phase.name}: ${phase.taskIds.join(', ') || 'no tasks'}`)
      .join('\n');

    const result = await generateText({
      model: route.model,
      system: `You are a project planning assistant refining an existing phase plan.

Consider:
- semantic clustering by theme or domain
- shared tags and category overlap
- higher priority and more urgent due dates earlier
- rough effort balancing across phases
- inferred dependencies, prerequisites, and setup work before downstream work
- missing tasks or gaps that should be added
- stale, duplicate, or outdated tasks that should be closed instead of planned

Rules:
- Use ONLY the provided task IDs.
- Put each task in at most one phase.
- If a task should not be worked, put it in suggestedClosures instead of a phase.
- You may rename, reorder, merge, or split phases when it improves the plan.
- Use colors from this palette when possible: ${PHASE_PLANNING_COLORS.join(', ')}.

Respond in JSON format with this exact structure:
{
  "phases": [
    {
      "name": "string",
      "description": "string",
      "color": "#hex",
      "estimatedDays": 5,
      "taskIds": ["id1", "id2"],
      "reasoning": "Why these tasks go together"
    }
  ],
  "overallReasoning": "High-level explanation of the plan",
  "suggestedNewTasks": [
    {
      "title": "string",
      "description": "string",
      "phase": "Phase Name",
      "reasoning": "Why this task is needed"
    }
  ],
  "suggestedClosures": [
    {
      "taskId": "string",
      "title": "string",
      "reasoning": "Why this task should be closed"
    }
  ]
}

Return JSON only.`,
      messages: [{
        role: 'user',
        content: [
          `Today: ${today}`,
          `Project: ${project.name} — ${project.description || 'no description'}`,
          `Instruction: ${instruction || 'none'}`,
          '',
          'Current phases:',
          currentPhaseContext,
          '',
          `Tasks (${projectTasks.length}):`,
          taskContext,
        ].join('\n'),
      }],
    });

    const proposal = normalizePhaseProposal(
      parsePhaseProposalText(result.text),
      projectTasks,
      { kind: 'refine', currentPhases, instruction },
    );

    return NextResponse.json({
      proposal,
      routing: getAsyncAIRouteOutcome(route, result.response),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to refine phase suggestion', error);
  }
}
