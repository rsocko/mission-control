import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, hubProjects, taskProjects, tags, taskTags } from '@/db/schema';
import { getAIModel, getAIRouteOutcome, getResolvedAIConfig } from '@/lib/ai';
import { generateText } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';

const PHASE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#14b8a6'] as const;

const requestSchema = z.object({
  projectId: z.string().trim().min(1),
  currentPhases: z.array(z.object({
    name: z.string().trim().min(1),
    taskIds: z.array(z.string().trim().min(1)),
  })).min(1),
  instruction: z.string().trim().max(4000).optional(),
});

const aiProposalSchema = z.object({
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

type PlanningTask = typeof tasks.$inferSelect & {
  tags: string[];
  projectNames: string[];
};

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
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : PHASE_COLORS[index % PHASE_COLORS.length];
}

function coerceEstimatedDays(value: string | number | null | undefined, taskCount: number) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return Math.max(1, Math.ceil(taskCount / 3));
}

function extractJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  return objectMatch?.[0]?.trim() || null;
}

function buildDuplicateClosureSuggestions(projectTasks: PlanningTask[]) {
  const titleMap = new Map<string, PlanningTask[]>();

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

function buildFallbackProposal(projectTasks: PlanningTask[], currentPhases: Array<{ name: string; taskIds: string[] }>, instruction?: string) {
  const sortedTasks = [...projectTasks].sort((a, b) => {
    const dueA = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const dueB = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const scoreA = priorityWeight(a.priority) * 1000 - dueA;
    const scoreB = priorityWeight(b.priority) * 1000 - dueB;
    return scoreB - scoreA;
  });

  const phaseCount = Math.max(1, Math.min(currentPhases.length, Math.max(1, sortedTasks.length)));
  const perPhase = Math.ceil(sortedTasks.length / phaseCount);

  const phases = currentPhases.slice(0, phaseCount).map((phase, index) => {
    const slice = sortedTasks.slice(index * perPhase, (index + 1) * perPhase);
    return {
      name: phase.name,
      description: `Refined placement for ${phase.name.toLowerCase()}.`,
      color: PHASE_COLORS[index % PHASE_COLORS.length],
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
    suggestedNewTasks: [] as Array<{ title: string; description: string; phase: string; reasoning: string }>,
    suggestedClosures: buildDuplicateClosureSuggestions(projectTasks),
  };
}

function normalizeProposal(raw: unknown, projectTasks: PlanningTask[], currentPhases: Array<{ name: string; taskIds: string[] }>, instruction?: string) {
  const parsed = aiProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return buildFallbackProposal(projectTasks, currentPhases, instruction);
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
      const uniqueTaskIds = phase.taskIds.filter((taskId) => taskIds.has(taskId) && !assigned.has(taskId));
      uniqueTaskIds.forEach((taskId) => assigned.add(taskId));

      return {
        name: phase.name.trim() || currentPhases[index]?.name || `Phase ${index + 1}`,
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
        name: currentPhases[0]?.name || 'Phase 1',
        description: 'Recovered unassigned tasks from the AI response.',
        color: PHASE_COLORS[0],
        estimatedDays: Math.max(1, Math.ceil(unassignedTaskIds.length / 3)),
        taskIds: unassignedTaskIds,
        reasoning: 'These tasks were not assigned by the model, so they were collected into the first phase.',
      });
    } else {
      phases[phases.length - 1] = {
        ...phases[phases.length - 1],
        taskIds: [...phases[phases.length - 1].taskIds, ...unassignedTaskIds],
        reasoning: phases[phases.length - 1].reasoning || 'Unassigned tasks were appended to keep every task represented.',
      };
    }
  }

  if (phases.length === 0) {
    return buildFallbackProposal(projectTasks, currentPhases, instruction);
  }

  return {
    phases,
    overallReasoning: parsed.data.overallReasoning.trim() || 'The phases were refined to improve sequence, balance, and dependency order.',
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

async function fetchPlanningTasks(taskIds: string[]) {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) {
    return [] as PlanningTask[];
  }

  const [taskRows, tagRows, projectRows] = await Promise.all([
    db.select().from(tasks).where(inArray(tasks.id, uniqueTaskIds)),
    db
      .select({ taskId: taskTags.taskId, tagName: tags.name })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(inArray(taskTags.taskId, uniqueTaskIds)),
    db
      .select({ taskId: taskProjects.taskId, projectName: hubProjects.name })
      .from(taskProjects)
      .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
      .where(inArray(taskProjects.taskId, uniqueTaskIds)),
  ]);

  const tagMap = new Map<string, string[]>();
  for (const row of tagRows) {
    const bucket = tagMap.get(row.taskId) || [];
    bucket.push(row.tagName);
    tagMap.set(row.taskId, bucket);
  }

  const projectNameMap = new Map<string, string[]>();
  for (const row of projectRows) {
    const bucket = projectNameMap.get(row.taskId) || [];
    bucket.push(row.projectName);
    projectNameMap.set(row.taskId, bucket);
  }

  const sortIndex = new Map(uniqueTaskIds.map((id, index) => [id, index]));

  return taskRows
    .map((task) => ({
      ...task,
      tags: tagMap.get(task.id) || [],
      projectNames: projectNameMap.get(task.id) || [],
    }))
    .sort((a, b) => (sortIndex.get(a.id) ?? 0) - (sortIndex.get(b.id) ?? 0));
}

function buildTaskContext(projectTasks: PlanningTask[]) {
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

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsedBody = requestSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { projectId, currentPhases, instruction } = parsedBody.data;
    const project = (await db.select().from(hubProjects).where(eq(hubProjects.id, projectId)).limit(1))[0];

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

    if (!getResolvedAIConfig().configured) {
      return NextResponse.json({ error: 'AI provider is not configured' }, { status: 503 });
    }

    const route = getAIModel('project-phase-refinement', {
      sources: projectTasks.map((task) => task.connectorType),
    });
    const today = getLocalToday();
    const taskContext = buildTaskContext(projectTasks);
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
- Use colors from this palette when possible: ${PHASE_COLORS.join(', ')}.

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

    const jsonText = extractJsonObject(result.text);
    let parsedResult: unknown = null;
    if (jsonText) {
      try {
        parsedResult = JSON.parse(jsonText);
      } catch {
        parsedResult = null;
      }
    }

    const proposal = normalizeProposal(parsedResult, projectTasks, currentPhases, instruction);

    return NextResponse.json({
      proposal,
      routing: getAIRouteOutcome(route.context, result.response),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to refine phase suggestion', error);
  }
}
