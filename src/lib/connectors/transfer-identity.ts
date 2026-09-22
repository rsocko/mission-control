import { getGitHubTransferIdentityRepository } from '@/lib/external-identities/worker-persistence';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import type { TransferIdentityRefresh } from '@/lib/connectors';
import { decodeLenientJsonObject } from '@/db/persistence/value-codecs';

interface TaskIdentityInput {
  taskId: string;
  connectorInstanceId: string;
  sourceId: string;
  sourceListId?: string | null;
  evidence?: ExternalIdentityEvidence;
}

export async function persistCreatedTaskIdentity(input: TaskIdentityInput): Promise<void> {
  if (!input.evidence) return;
  await (await getGitHubTransferIdentityRepository()).persist({
    taskId: input.taskId,
    connectorInstanceId: input.connectorInstanceId,
    sourceId: input.sourceId,
    sourceListId: input.sourceListId ?? null,
    taskEvidence: input.evidence,
    sourceLists: [],
    observedAt: new Date().toISOString(),
  });
}

export async function reconcileTransferIdentity(
  taskId: string,
  connectorInstanceId: string,
  refresh: TransferIdentityRefresh,
): Promise<void> {
  await (await getGitHubTransferIdentityRepository()).persist({
    taskId,
    connectorInstanceId,
    sourceId: refresh.task.sourceId,
    sourceListId: refresh.task.sourceListId ?? null,
    taskEvidence: refresh.task.externalIdentity,
    sourceLists: refresh.sourceLists,
    reconcileTask: {
      sourceId: refresh.task.sourceId,
      sourceListId: refresh.task.sourceListId ?? null,
      sourceListName: refresh.task.sourceListName ?? null,
      title: refresh.task.title,
      description: refresh.task.description ?? null,
      status: refresh.task.status,
      statusReason: refresh.task.statusReason ?? null,
      priority: refresh.task.priority,
      effort: refresh.task.effort ?? null,
      microStatus: refresh.task.microStatus ?? null,
      assignee: refresh.task.assignee ?? null,
      updatedAt: refresh.task.updatedAt,
      completedAt: refresh.task.completedAt ?? null,
      metadata: decodeLenientJsonObject(refresh.task.metadata),
    },
    observedAt: new Date().toISOString(),
  });
}
