import db from '@/db';
import { sourceLists, tasks } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  getGitHubIdentityModeSnapshot,
  persistExternalIdentityBatch,
} from '@/lib/external-identities';
import type {
  ExternalIdentityEvidence,
  ExternalIdentityWrite,
} from '@/lib/external-identities/types';
import type { TransferIdentityRefresh } from '@/lib/connectors';

interface TaskIdentityInput {
  taskId: string;
  connectorInstanceId: string;
  sourceId: string;
  sourceListId?: string | null;
  evidence?: ExternalIdentityEvidence;
}

export function persistCreatedTaskIdentity(input: TaskIdentityInput): void {
  if (!input.evidence) return;
  persistIdentityWrites(
    input.connectorInstanceId,
    input.taskId,
    input.sourceId,
    input.sourceListId,
    input.evidence,
  );
}

export function reconcileTransferIdentity(
  taskId: string,
  connectorInstanceId: string,
  refresh: TransferIdentityRefresh,
): void {
  persistIdentityWrites(
    connectorInstanceId,
    taskId,
    refresh.task.sourceId,
    refresh.task.sourceListId,
    refresh.task.externalIdentity,
    refresh.sourceLists,
  );

  const current = db.select({ metadata: tasks.metadata })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .get();
  const metadata = {
    ...parseMetadata(current?.metadata),
    ...parseMetadata(refresh.task.metadata),
  };
  db.update(tasks).set({
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
    metadata: JSON.stringify(metadata),
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
  }).where(and(
    eq(tasks.id, taskId),
    eq(tasks.connectorInstanceId, connectorInstanceId),
  )).run();
}

function persistIdentityWrites(
  connectorInstanceId: string,
  taskId: string,
  sourceId: string,
  sourceListId: string | null | undefined,
  taskEvidence: ExternalIdentityEvidence | undefined,
  refreshedSourceLists: TransferIdentityRefresh['sourceLists'] = [],
): void {
  if (!taskEvidence) return;
  const writes: ExternalIdentityWrite[] = [];
  const sourceListEvidence = new Map(
    refreshedSourceLists.map((sourceList) => [sourceList.sourceId, sourceList.evidence]),
  );
  if (sourceListId && taskEvidence.repository) {
    sourceListEvidence.set(sourceListId, { entity: taskEvidence.repository });
  }

  for (const [listSourceId, evidence] of sourceListEvidence) {
    const localList = db.select({ id: sourceLists.id })
      .from(sourceLists)
      .where(and(
        eq(sourceLists.connectorInstanceId, connectorInstanceId),
        eq(sourceLists.sourceId, listSourceId),
      ))
      .limit(1)
      .get();
    if (!localList) continue;
    writes.push({
      target: {
        connectorInstanceId,
        bindingType: 'source_list',
        localId: localList.id,
        legacyIdentity: listSourceId,
      },
      evidence,
    });
  }

  writes.push({
    target: {
      connectorInstanceId,
      bindingType: 'task',
      localId: taskId,
      legacyIdentity: sourceId,
    },
    evidence: taskEvidence,
  });
  persistExternalIdentityBatch(
    writes,
    getGitHubIdentityModeSnapshot(connectorInstanceId),
  );
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
