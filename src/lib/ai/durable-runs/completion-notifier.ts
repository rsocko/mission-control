import 'server-only';

import { createNotification } from '@/lib/notifications/service';
import type { DurableAiRun } from './types';

export async function notifyDurableAiRunCompletion(
  run: DurableAiRun,
): Promise<void> {
  const succeeded = run.status === 'succeeded';
  await createNotification({
    sourceId: `ai-run:${run.id}`,
    connectorType: 'mission-control',
    connectorInstanceId: 'durable-ai-runs',
    title: succeeded ? 'AI run completed' : `AI run ${run.status.replace('_', ' ')}`,
    body: `${run.featureId} via ${run.executionRoute}`,
    level: succeeded ? 'info' : 'warning',
    category: 'ai-run',
    dedupeKey: `ai-run:${run.id}:${run.status}`,
    navigationTarget: '/settings/ai',
    relatedEntityType: 'ai-run',
    relatedEntityId: run.id,
    metadata: {
      runId: run.id,
      correlationId: run.correlationId,
      status: run.status,
      executionRoute: run.executionRoute,
    },
  });
}
