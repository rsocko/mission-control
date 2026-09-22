import type {
  GitHubDeletionFenceRecord,
} from '@/db/persistence/connector-execution';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export type RestoreMode = 'local' | 'source';
export type GitHubDeletionFence = GitHubDeletionFenceRecord;

export interface GitHubRecoveryPreflight {
  (route: {
    targets: ReadonlyArray<{
      role: string;
      owner: string;
      repository: string;
      issueNumber: number | null;
    }>;
  }): Promise<{
    targets: Record<string, { repositoryStableId: string; issueStableId?: string }>;
  }>;
}

export async function archiveAndDeleteTask(
  taskId: string,
  reason: string,
  expectedGitHubFence?: GitHubDeletionFence,
): Promise<{ snapshotId: string; taskTitle: string; sourceId: string } | null> {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.execution.deletions.archiveAndDeleteTask(
    taskId,
    reason,
    expectedGitHubFence,
  );
}

export async function restoreDeletionSnapshot(
  snapshotId: string,
  mode: RestoreMode,
  githubPreflight?: GitHubRecoveryPreflight,
): Promise<{ taskId: string; alreadyRestored: boolean }> {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.execution.deletions.restoreDeletionSnapshot(
    snapshotId,
    mode,
    githubPreflight,
  );
}
