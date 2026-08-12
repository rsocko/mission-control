import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, appSettings } from '@/db/schema';
import { eq, and, gt, asc } from 'drizzle-orm';
import logger from '@/lib/logger';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';

// ─── Constants ──────────────────────────────────────────────────────────────

const WRITE_BACK_CURSOR_KEY = 'scout_write_back_synced_at';
const DEFAULT_LIMIT = 500;

// ─── Auth ───────────────────────────────────────────────────────────────────

function hasValidApiKey(request: Request): boolean {
  const expected = process.env.MC_API_KEY;
  if (!expected) return true;

  const keyHeader = request.headers.get('x-mc-api-key');
  if (keyHeader && keyHeader === expected) return true;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() === expected;
  }

  return false;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface StatusChange {
  mcTaskId: string;
  sourceId: string;
  sourceType: string;
  title: string;
  status: string;
  statusReason: string | null;
  previousStatus?: string;
  updatedAt: string;
  completedAt: string | null;
  snoozedUntil: string | null;
  suppressRepush: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get the last write-back sync cursor from appSettings.
 * This is separate from the per-task lastSyncedAt used by ingest.
 */
async function getWriteBackCursor(): Promise<string | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, WRITE_BACK_CURSOR_KEY));

  if (!row) return null;
  return typeof row.value === 'string' ? row.value : (row.value as string) || null;
}

// ─── GET Handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  try {
    if (!hasValidApiKey(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const sinceParam = searchParams.get('since');
    const sourceTypesParam = searchParams.get('sourceTypes');
    const limitParam = searchParams.get('limit');
    const limit = Math.min(Math.max(parseInt(limitParam || '', 10) || DEFAULT_LIMIT, 1), 1000);

    // If no explicit `since`, use the last write-back cursor
    let since: string | null = sinceParam;
    if (!since) {
      since = await getWriteBackCursor();
    }

    // Build query conditions
    const conditions = [eq(tasks.connectorType, 'scout')];

    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return NextResponse.json(
          { error: 'Invalid "since" parameter — must be a valid ISO timestamp' },
          { status: 400 },
        );
      }
      conditions.push(gt(tasks.updatedAt, since));
    }

    // Query tasks that have changed (with limit + 1 to detect hasMore)
    const changedTasks = await db
      .select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        title: tasks.title,
        status: tasks.status,
        statusReason: tasks.statusReason,
        updatedAt: tasks.updatedAt,
        completedAt: tasks.completedAt,
        snoozedUntil: tasks.snoozedUntil,
        metadata: tasks.metadata,
      })
      .from(tasks)
      .where(and(...conditions))
      .orderBy(asc(tasks.updatedAt))
      .limit(limit + 1);

    // Detect if there are more results beyond the limit
    const hasMore = changedTasks.length > limit;
    const tasksToProcess = hasMore ? changedTasks.slice(0, limit) : changedTasks;

    // Filter by sourceTypes if specified
    const sourceTypes = sourceTypesParam
      ? sourceTypesParam.split(',').map(s => s.trim()).filter(Boolean)
      : null;

    const changes: StatusChange[] = [];

    for (const task of tasksToProcess) {
      const parsedMetadata = parseTaskMetadataCompat(task.metadata);
      if (parsedMetadata.recoveredLegacy) {
        logger.warn(
          { taskId: task.id },
          '[scout-status-changes] Recovered unstructured legacy task metadata',
        );
      }

      const sourceType = typeof parsedMetadata.metadata.sourceType === 'string'
        ? parsedMetadata.metadata.sourceType
        : 'unknown';

      // Filter by sourceTypes if provided
      if (sourceTypes && !sourceTypes.includes(sourceType)) {
        continue;
      }

      // Determine if Scout should suppress re-push for this item
      const suppressRepush =
        task.status === 'done' ||
        task.status === 'cancelled' ||
        (task.snoozedUntil != null && new Date(task.snoozedUntil) > new Date());

      changes.push({
        mcTaskId: task.id,
        sourceId: task.sourceId,
        sourceType,
        title: task.title,
        status: task.status,
        statusReason: task.statusReason || null,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt || null,
        snoozedUntil: task.snoozedUntil || null,
        suppressRepush,
      });
    }

    logger.info(`[scout-status-changes] Returning ${changes.length} changes (since: ${since || 'all'}, hasMore: ${hasMore})`);

    return NextResponse.json({
      changes,
      count: changes.length,
      hasMore,
      since: since || null,
      cursorSource: sinceParam ? 'explicit' : (since ? 'write_back_cursor' : 'none'),
      queriedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('[scout-status-changes] Error: %s', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
