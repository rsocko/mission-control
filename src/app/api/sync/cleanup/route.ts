import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { syncLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

interface GitHubIssueRouteResponse {
  html_url?: unknown;
  node_id?: unknown;
}

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

function sourceIdFromGitHubUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (
      segments.length !== 4
      || segments[2].toLowerCase() !== 'issues'
      || !/^[1-9]\d*$/.test(segments[3])
    ) return null;
    return `${segments[0]}/${segments[1]}:${segments[3]}`.toLowerCase();
  } catch {
    return null;
  }
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
    for (const candidate of group) {
      const route = parseGitHubSourceId(candidate.sourceId);
      if (!route) continue;
      try {
        const response = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repository)}/issues/${route.issueNumber}`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'mission-control-transfer-cleanup',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            cache: 'no-store',
          },
        );
        if (!response.ok) continue;
        const issue = await response.json() as GitHubIssueRouteResponse;
        const canonicalSourceId = sourceIdFromGitHubUrl(issue.html_url);
        const destination = canonicalSourceId ? bySourceId.get(canonicalSourceId) : null;
        if (
          destination
          && destination.id !== candidate.id
          && typeof issue.node_id === 'string'
          && destination.nodeId === issue.node_id
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
