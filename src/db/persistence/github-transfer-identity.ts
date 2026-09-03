import type { TaskTransferIdentityRepository } from '@/lib/tasks/core/contracts';
import type {
  ExternalIdentityEvidence,
  ExternalIdentityWrite,
} from '@/lib/external-identities/types';

type ReconcileTaskRefreshInput =
  Parameters<TaskTransferIdentityRepository['reconcileTaskRefresh']>[0];

export interface GitHubTransferIdentityInput {
  readonly taskId: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly sourceListId: string | null;
  readonly taskEvidence?: ExternalIdentityEvidence;
  readonly sourceLists: readonly {
    sourceId: string;
    evidence: ExternalIdentityEvidence;
  }[];
  readonly reconcileTask?: ReconcileTaskRefreshInput['task'];
  readonly observedAt: string;
}

export interface GitHubTransferIdentityPersistence {
  /**
   * Persists task/source-list identity state and an optional task refresh in
   * one adapter-owned transaction. Callers must complete remote I/O first.
   */
  persist(input: GitHubTransferIdentityInput): Promise<void>;
}

export function buildGitHubTransferIdentityWrites(
  input: GitHubTransferIdentityInput,
  resolvedSourceLists: readonly { sourceId: string; localId: string }[],
): ExternalIdentityWrite[] {
  const evidenceBySourceId = new Map(
    input.sourceLists.map((sourceList) => [sourceList.sourceId, sourceList.evidence]),
  );
  if (input.sourceListId && input.taskEvidence?.repository) {
    evidenceBySourceId.set(input.sourceListId, {
      entity: input.taskEvidence.repository,
    });
  }

  const writes: ExternalIdentityWrite[] = [];
  for (const sourceList of resolvedSourceLists) {
    const evidence = evidenceBySourceId.get(sourceList.sourceId);
    if (!evidence) continue;
    writes.push({
      target: {
        connectorInstanceId: input.connectorInstanceId,
        bindingType: 'source_list',
        localId: sourceList.localId,
        legacyIdentity: sourceList.sourceId,
      },
      evidence,
    });
  }
  if (input.taskEvidence) {
    writes.push({
      target: {
        connectorInstanceId: input.connectorInstanceId,
        bindingType: 'task',
        localId: input.taskId,
        legacyIdentity: input.sourceId,
      },
      evidence: input.taskEvidence,
    });
  }
  return writes;
}

export function sourceListIdsForGitHubTransferIdentity(
  input: GitHubTransferIdentityInput,
): string[] {
  const sourceIds = input.sourceLists.map((sourceList) => sourceList.sourceId);
  if (input.sourceListId && input.taskEvidence?.repository) {
    sourceIds.push(input.sourceListId);
  }
  return [...new Set(sourceIds)];
}
