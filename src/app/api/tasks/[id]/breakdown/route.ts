import { NextResponse } from 'next/server';
import { generateText, Output } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import db from '@/db';
import { hubProjects, tags, taskProjects, tasks, taskTags } from '@/db/schema';
import { getAIModel, getAIRouteOutcome, getResolvedAIConfig } from '@/lib/ai';
import {
  aiBreakdownOutputSchema,
  buildBreakdownPrompt,
  createBreakdownContextVersion,
  normalizeBreakdownProposals,
} from '@/lib/ai/task-breakdown';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import logger from '@/lib/logger';

const taskIdSchema = z.string().trim().min(1).max(200);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsedId = taskIdSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const taskId = parsedId.data;

  try {
    const [task] = await db.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      effort: tasks.effort,
      sourceListName: tasks.sourceListName,
      connectorType: tasks.connectorType,
      updatedAt: tasks.updatedAt,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!getResolvedAIConfig().configured) {
      return NextResponse.json({ error: 'AI provider is not configured' }, { status: 503 });
    }

    const [existingSubtasks, taskTagRows, projectRows] = await Promise.all([
      db.select({ title: tasks.title })
        .from(tasks)
        .where(eq(tasks.parentId, taskId))
        .limit(30),
      db.select({ name: tags.name })
        .from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(eq(taskTags.taskId, taskId))
        .limit(20),
      db.select({ name: hubProjects.name })
        .from(taskProjects)
        .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
        .where(eq(taskProjects.taskId, taskId))
        .limit(10),
    ]);

    let output: unknown;
    let routing;
    try {
      const route = getAIModel('task-breakdown', {
        sources: [task.connectorType],
      });
      const result = await generateText({
        model: route.model,
        output: Output.object({ schema: aiBreakdownOutputSchema }),
        system: 'You are a precise task decomposition assistant. Return only the requested structured output.',
        prompt: buildBreakdownPrompt({
          ...task,
          tags: taskTagRows.map((row) => row.name),
          projects: projectRows.map((row) => row.name),
          existingSubtasks: existingSubtasks.map((row) => row.title),
        }),
        maxOutputTokens: 1400,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(30_000),
      });
      output = result.output;
      routing = getAIRouteOutcome(route.context, result.response);
    } catch (error) {
      logger.warn({ err: error, taskId }, 'AI task breakdown generation failed');
      return NextResponse.json(
        { error: 'AI could not generate a valid task breakdown' },
        { status: 502 },
      );
    }

    const proposals = normalizeBreakdownProposals(
      output,
      existingSubtasks.map((row) => row.title),
    );
    if (proposals.length === 0) {
      return NextResponse.json(
        { error: 'AI returned no new usable subtasks' },
        { status: 422 },
      );
    }

    const tagNames = taskTagRows.map((row) => row.name);
    const projectNames = projectRows.map((row) => row.name);
    const subtaskTitles = existingSubtasks.map((row) => row.title);

    return NextResponse.json({
      contextVersion: createBreakdownContextVersion({
        updatedAt: task.updatedAt,
        tags: tagNames,
        projects: projectNames,
        existingSubtasks: subtaskTitles,
      }),
      proposals,
      routing,
    });
  } catch (error) {
    logger.error({ err: error, taskId }, 'Task breakdown request failed');
    return NextResponse.json({ error: 'Failed to generate task breakdown' }, { status: 500 });
  }
}
