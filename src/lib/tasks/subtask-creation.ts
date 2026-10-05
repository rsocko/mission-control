import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import { persistCreatedTaskIdentity } from '@/lib/connectors/transfer-identity';
import {
  executeFencedGitHubTaskMutation,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';
import logger from '@/lib/logger';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { logWriteThrough } from '@/lib/sync/write-through-log';
import type {
  TaskCoreTaskRow,
  TaskMoveTaskInsert,
} from '@/lib/tasks/core/contracts';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { ConnectorConfig } from '@/types';

export async function getOrRefreshSubtaskConnector(connectorInstanceId: string) {
  const registry = getConnectorRegistry();
  const existing = registry.getConnector(connectorInstanceId);
  if (existing) return existing;
  const repositories = await getWorkerPersistenceRepositories();
  const config = await repositories.connectors.get(connectorInstanceId);
  if (!config) return null;
  repositories.execution.support.assertConfigSupported(config);
  const resolvedConfig: ConnectorConfig = {
    ...config,
    syncMode: config.syncMode || 'poll',
    pollIntervalMinutes: config.pollIntervalMinutes ?? 5,
  };
  return registry.replaceConnector(resolvedConfig);
}

export function buildSubtaskTask(
  parent: TaskCoreTaskRow,
  input: {
    id: string;
    title: string;
    priority: TaskCoreTaskRow['priority'];
    planningHorizon: TaskCoreTaskRow['planningHorizon'];
    dueDate: string | null;
    effort: number | null;
    now: string;
    syncStatus: string;
  },
): TaskMoveTaskInsert {
  return {
    id: input.id,
    sourceId: input.id,
    connectorType: parent.connectorType,
    connectorInstanceId: parent.connectorInstanceId,
    title: input.title,
    description: null,
    status: 'todo',
    localDisposition: 'active',
    priority: input.priority,
    planningHorizon: input.planningHorizon,
    dueDate: input.dueDate,
    pushCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    completedAt: null,
    recurrenceGeneratedFromTaskId: null,
    parentId: parent.id,
    depth: parent.depth + 1,
    isChecklistItem: true,
    sourceListId: parent.sourceListId,
    sourceListName: parent.sourceListName,
    assignee: null,
    microStatus: null,
    statusReason: null,
    metadata: {},
    syncStatus: input.syncStatus,
    lastSyncedAt: input.now,
    pushRetryCount: 0,
    kanbanColumn: null,
    kanbanOrder: null,
    snoozedUntil: null,
    reminderAt: null,
    reminderRelative: null,
    reminderDueTime: null,
    effort: input.effort,
    isBulkImport: false,
  };
}

export async function writeThroughSubtask(params: {
  subtaskId: string;
  title: string;
  parentTaskId: string;
  parentSourceId: string;
  connectorInstanceId: string;
}) {
  try {
    const connector = await getOrRefreshSubtaskConnector(params.connectorInstanceId);
    if (!connector?.createSubTask) return;

    const createRemote = () => connector.createSubTask!(params.parentSourceId, {
      title: params.title,
      // Connector contracts still expose their own status union.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: 'todo' as any,
    });
    const created = connector.type === 'github-issues'
      ? await executeFencedGitHubTaskMutation({
          connectorInstanceId: params.connectorInstanceId,
          taskId: params.subtaskId,
          operation: 'sub_issue',
          connector,
          participantTaskIds: [{ role: 'parent_issue', taskId: params.parentTaskId }],
          write: createRemote,
        })
      : await createRemote();

    if (connector.type === 'github-issues') {
      if (!created.externalIdentity) {
        throw new Error('GitHub subtask creation returned without stable identity evidence');
      }
      await persistCreatedTaskIdentity({
        taskId: params.subtaskId,
        connectorInstanceId: params.connectorInstanceId,
        sourceId: created.sourceId,
        sourceListId: created.sourceListId,
        evidence: created.externalIdentity,
      });
    }

    const { ancillary } = await getTaskCorePersistence();
    await ancillary.completeSubtaskWriteThrough({
      taskId: params.subtaskId,
      expectedSyncStatus: 'pending_push',
      sourceId: created.sourceId,
      metadata: created.metadata || {},
      now: new Date().toISOString(),
    });
    await logWriteThrough({
      connectorId: params.connectorInstanceId,
      action: 'subtask_created',
      taskId: params.subtaskId,
      taskTitle: params.title,
      taskSourceId: created.sourceId,
    });
  } catch (error) {
    logger.error({ err: error, subtaskId: params.subtaskId }, 'Write-through subtask request failed');
    if (error instanceof GitHubUnknownWriteOutcomeError) {
      const { ancillary } = await getTaskCorePersistence();
      await ancillary.failSubtaskWriteThrough({
        taskId: params.subtaskId,
        expectedSyncStatus: 'pending_push',
      });
    }
  }
}
