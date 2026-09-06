import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { syncLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/sync/cleanup — Remove duplicate tasks and clean up recurring task instances.
 *
 * The route no longer owns any SQL, transaction, or schema DDL. It delegates to
 * the operational-utility maintenance subport, which performs discovery and all
 * deletions inside one backend transaction and returns the exact counts only
 * after that transaction commits.
 *
 * Phase 1: duplicates identified by (sourceId, connectorInstanceId) pairs; the
 * most recently synced/updated row wins.
 * Phase 2: completed recurring instances grouped by (title, sourceListId,
 * connectorInstanceId); the most recently completed instance wins.
 * Phase 3: open recurring instances in the same grouping; the nearest due date
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

    const result = await operationalUtility.maintenance.runDuplicateCleanup();

    return NextResponse.json({
      success: true,
      duplicateGroupsFound: result.duplicateGroupsFound,
      tasksRemoved: result.tasksRemoved,
      recurringInstancesRemoved: result.recurringInstancesRemoved,
      openRecurringInstancesRemoved: result.openRecurringInstancesRemoved,
    });
  } catch (error) {
    syncLogger.error({ err: error }, 'Cleanup failed');
    return ApiErrors.internal('Cleanup failed', error);
  }
}
