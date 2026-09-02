import 'server-only';

import { createNotification } from '@/lib/notifications/service';
import type { DurableAiRunRepository } from './repository';
import { getDurableAiRunRepository } from './runtime';
import type { DurableAiRun } from './types';

export async function notifyDurableAiRunCompletion(
  run: DurableAiRun,
  repository?: DurableAiRunRepository,
): Promise<void> {
  const durableRuns = repository ?? await getDurableAiRunRepository();
  const persistedRun = await durableRuns.getRun(run.id);
  if (!persistedRun) {
    throw new Error(`Durable AI run ${run.id} was not found.`);
  }
  if (persistedRun.status !== run.status) {
    throw new Error(`Durable AI run ${run.id} changed before completion notification.`);
  }
  const succeeded = persistedRun.status === 'succeeded';
  await createNotification({
    sourceId: `ai-run:${persistedRun.id}`,
    connectorType: 'mission-control',
    connectorInstanceId: 'durable-ai-runs',
    title: succeeded
      ? 'AI run completed'
      : `AI run ${persistedRun.status.replace('_', ' ')}`,
    body: `${persistedRun.featureId} via ${persistedRun.executionRoute}`,
    level: succeeded ? 'info' : 'warning',
    category: 'ai-run',
    dedupeKey: `ai-run:${persistedRun.id}:${persistedRun.status}`,
    navigationTarget: '/settings/ai',
    relatedEntityType: 'ai-run',
    relatedEntityId: persistedRun.id,
    metadata: {
      runId: persistedRun.id,
      correlationId: persistedRun.correlationId,
      status: persistedRun.status,
      executionRoute: persistedRun.executionRoute,
    },
  });
}
