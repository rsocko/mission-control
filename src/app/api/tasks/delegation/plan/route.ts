import { NextResponse } from 'next/server';
import { getAsyncAIProviderConfiguration } from '@/lib/ai/provider-runtime';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  getTaskDelegationContext,
} from '@/lib/external-agents/task-delegation';
import { getExternalAgentControlPersistence } from '@/lib/external-agents/persistence';
import { proposeDelegationPlan } from '@/lib/external-agents/delegation-planner';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import logger from '@/lib/logger';

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const body = await request.json() as {
      taskIds?: string[];
      agentId?: string;
      repository?: string;
    };
    if (!Array.isArray(body.taskIds) || body.taskIds.length < 2 || !body.agentId) {
      throw new ExternalAgentError(
        'Auto planning requires at least two task IDs and an agentId',
        'VALIDATION_ERROR',
        422,
      );
    }
    if (!(await getAsyncAIProviderConfiguration()).configured) {
      throw new ExternalAgentError(
        'AI provider is not configured',
        'PROVIDER_UNAVAILABLE',
        503,
      );
    }
    const taskIds = [...new Set(body.taskIds)];
    const context = await getTaskDelegationContext(taskIds);
    const target = context.targets.find(({ id }) => id === body.agentId);
    if (!target || target.type !== 'copilot-cloud') {
      throw new ExternalAgentError(
        'Auto planning is currently available only for GitHub Copilot Cloud',
        'CAPABILITY_MISMATCH',
        422,
      );
    }
    const eligible = target.eligibility.filter(({ ready }) => ready);
    const repositories = new Map<string, string>();
    for (const task of eligible) {
      const repository = task.repositoryLocked ? task.repository : body.repository;
      if (!repository) {
        throw new ExternalAgentError(
          'Choose a repository before generating an Auto proposal',
          'VALIDATION_ERROR',
          422,
        );
      }
      repositories.set(task.taskId, repository);
    }
    const snapshot = await (
      await getExternalAgentControlPersistence()
    ).payloads.snapshot({ taskIds: eligible.map(({ taskId }) => taskId) });
    const plan = await proposeDelegationPlan({
      tasks: snapshot.tasks,
      repositories,
    });
    return NextResponse.json({
      ...plan,
      blocked: target.eligibility.filter(({ ready }) => !ready),
      taskTitles: Object.fromEntries(context.tasks.map(({ id, title }) => [id, title])),
    });
  } catch (error) {
    logger.warn({ err: error }, 'Auto delegation planning failed');
    return externalAgentErrorResponse(error);
  }
}
