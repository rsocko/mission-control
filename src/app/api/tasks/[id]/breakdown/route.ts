import { NextResponse } from 'next/server';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import {
  getAsyncAIModel,
  getAsyncAIProviderConfiguration,
  getAsyncAIRouteOutcome,
} from '@/lib/ai/provider-runtime';
import {
  aiBreakdownOutputSchema,
  buildBreakdownPrompt,
  createBreakdownContextVersion,
  normalizeBreakdownProposals,
} from '@/lib/ai/task-breakdown';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
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
    const context = await (await getAIWorkflowPersistence()).getTaskBreakdownContext(taskId);

    if (!context) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const { task, subtaskTitles, tagNames, projectNames } = context;

    if (!(await getAsyncAIProviderConfiguration()).configured) {
      return NextResponse.json({ error: 'AI provider is not configured' }, { status: 503 });
    }

    let output: unknown;
    let routing;
    try {
      const route = await getAsyncAIModel('task-breakdown', {
        sources: [task.connectorType],
      });
      const result = await generateText({
        model: route.model,
        output: Output.object({ schema: aiBreakdownOutputSchema }),
        system: 'You are a precise task decomposition assistant. Return only the requested structured output.',
        prompt: buildBreakdownPrompt({
          ...task,
          tags: tagNames,
          projects: projectNames,
          existingSubtasks: subtaskTitles,
        }),
        maxOutputTokens: 1400,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(30_000),
      });
      output = result.output;
      routing = getAsyncAIRouteOutcome(route, result.response);
    } catch (error) {
      logger.warn({ err: error, taskId }, 'AI task breakdown generation failed');
      return NextResponse.json(
        { error: 'AI could not generate a valid task breakdown' },
        { status: 502 },
      );
    }

    const proposals = normalizeBreakdownProposals(
      output,
      subtaskTitles,
    );
    if (proposals.length === 0) {
      return NextResponse.json(
        { error: 'AI returned no new usable subtasks' },
        { status: 422 },
      );
    }

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
