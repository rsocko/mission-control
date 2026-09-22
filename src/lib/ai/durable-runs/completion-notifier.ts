import 'server-only';

import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
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
  const occurredAt = persistedRun.completedAt ?? persistedRun.updatedAt;
  const sourceId = `ai-run:${persistedRun.id}`;
  const dedupeKey = `${sourceId}:${persistedRun.status}`;
  const title = succeeded
    ? 'AI run completed'
    : `AI run ${persistedRun.status.replace('_', ' ')}`;
  await (await getWorkerPersistenceRepositories()).execution.notifications.ingest([{
    input: {
      id: dedupeKey,
      sourceId,
      connectorType: 'mission-control',
      connectorInstanceId: 'durable-ai-runs',
      title,
      body: `${persistedRun.featureId} via ${persistedRun.executionRoute}`,
      level: succeeded ? 'fyi' : 'heads_up',
      category: 'ai-run',
      templateKey: 'durable_ai_run',
      readState: 'unread',
      sourceState: 'active',
      sourceActivityAt: occurredAt,
      sourceActivityKey: dedupeKey,
      reopenPolicy: 'never',
      occurrenceKey: dedupeKey,
      isActionable: false,
      primaryActionId: null,
      receivedAt: occurredAt,
      sortAt: occurredAt,
      dedupeKey,
      relatedTaskId: null,
      relatedProjectId: null,
      relatedEntityType: 'ai-run',
      relatedEntityId: persistedRun.id,
      navigationTarget: '/settings/ai',
      metadata: {
        runId: persistedRun.id,
        correlationId: persistedRun.correlationId,
        status: persistedRun.status,
        executionRoute: persistedRun.executionRoute,
      },
      presentation: {},
    },
    actions: [],
  }]);
}
