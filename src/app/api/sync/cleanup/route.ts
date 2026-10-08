import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { syncLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';

interface GitHubTransferCleanupCandidate {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  title: string;
  nodeId: string | null;
}

function parseGitHubSourceId(sourceId: string): {
  owner: string;
  repository: string;
  issueNumber: number;
} | null {
  const match = /^([^/:]+)\/([^/:]+):([1-9]\d*)$/.exec(sourceId);
  if (!match) return null;
  return {
    owner: match[1],
    repository: match[2],
    issueNumber: Number(match[3]),
  };
}

async function findVerifiedTransferOrphans(
  candidates: readonly GitHubTransferCleanupCandidate[],
): Promise<string[]> {
  const groups = new Map<string, GitHubTransferCleanupCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.connectorInstanceId}\0${candidate.title}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const orphanIds = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const bySourceId = new Map(group.map((task) => [task.sourceId.toLowerCase(), task]));
    const connector = await getOrInitializeConnector(group[0].connectorInstanceId);
    if (!connector?.resolveTaskIdentity) continue;
    for (const candidate of group) {
      const route = parseGitHubSourceId(candidate.sourceId);
      if (!route) continue;
      try {
        const identity = await connector.resolveTaskIdentity(candidate.sourceId);
        const destination = bySourceId.get(identity.sourceId.toLowerCase());
        if (
          destination
          && destination.id !== candidate.id
          && destination.nodeId === identity.stableId
        ) {
          orphanIds.add(candidate.id);
        }
      } catch (error) {
        syncLogger.warn(
          { err: error, taskId: candidate.id },
          'Could not verify possible GitHub transfer orphan',
        );
      }
    }
  }
  return [...orphanIds];
}

/**
 * POST /api/sync/cleanup — Remove duplicate tasks and clean up recurring task instances.
 *
 * The route no longer owns any SQL, transaction, or schema DDL. It delegates to
 * the operational-utility maintenance subport, which performs discovery and all
 * deletions inside one backend transaction and returns the exact counts only
 * after that transaction commits.
 *
 * Phase 1: transferred GitHub orphans whose destination URL has an exact
 * canonical task row are removed.
 * Phase 2: duplicates identified by (sourceId, connectorInstanceId) pairs; the
 * most recently synced/updated row wins.
 * Phase 3: completed recurring instances grouped by (title, sourceListId,
 * connectorInstanceId); the most recently completed instance wins.
 * Phase 4: open recurring instances in the same grouping; the nearest due date
 * wins, nulls last.
 */
export async function POST() {
  try {
    const { operationalUtility } = await getWorkerPersistenceRepositories();
    if (!operationalUtility) {
      return NextResponse.json(
        { error: 'Operational utility persistence is not available in the selected backend' },
        { status: 503 },
      );
    }

    const verifiedTransferOrphans = operationalUtility.maintenance.listGitHubTransferCandidates
      ? await findVerifiedTransferOrphans(
          await operationalUtility.maintenance.listGitHubTransferCandidates(),
        )
      : [];
    const verifiedTransfersRemoved =
      operationalUtility.maintenance.deleteVerifiedGitHubTransferOrphans
        ? await operationalUtility.maintenance.deleteVerifiedGitHubTransferOrphans(
            verifiedTransferOrphans,
          )
        : 0;

    const result = await operationalUtility.maintenance.runDuplicateCleanup();

    return NextResponse.json({
      success: true,
      duplicateGroupsFound: result.duplicateGroupsFound,
      tasksRemoved: result.tasksRemoved + verifiedTransfersRemoved,
      recurringInstancesRemoved: result.recurringInstancesRemoved,
      openRecurringInstancesRemoved: result.openRecurringInstancesRemoved,
    });
  } catch (error) {
    syncLogger.error({ err: error }, 'Cleanup failed');
    return ApiErrors.internal('Cleanup failed', error);
  }
}
