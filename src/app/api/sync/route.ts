import { NextResponse } from 'next/server';
import { syncScheduler } from '@/lib/sync';
import db from '@/db';
import { syncLog } from '@/db/schema';
import { desc, lt } from 'drizzle-orm';
import { syncLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { isDemoMode } from '@/lib/mode';
import {
  getSyncJobRepository,
  isDurableSyncMode,
} from '@/lib/sync/job-queue';
import { getRuntimeTelemetry } from '@/lib/telemetry/runtime';

async function getScheduleHealth() {
  const jobRepository = await getSyncJobRepository();
  const schedules = await jobRepository.getScheduleHealth();
  const overdue = schedules.filter((schedule) => schedule.overdue);
  const worker = (await getRuntimeTelemetry()).find((runtime) => runtime.role === 'worker');
  const telemetryStaleMs = Math.max(
    30_000,
    Number(process.env.MC_TELEMETRY_STALE_MS) || 30_000,
  );
  const workerAvailable = !!worker
    && Date.now() - new Date(worker.heartbeatAt).getTime() <= telemetryStaleMs;
  const durableMode = isDurableSyncMode();
  const activeWorker = durableMode && workerAvailable ? worker : undefined;

  if (durableMode && schedules.length > 0 && !activeWorker) {
    return {
      status: 'action_required' as const,
      message: overdue.length > 0
        ? `${overdue.length} connector schedule${overdue.length === 1 ? ' is' : 's are'} overdue because the sync worker is not reporting.`
        : 'The sync worker is not reporting, so automatic syncs cannot run.',
      userAction: {
        type: 'restart_worker' as const,
        label: 'Restart sync worker',
        detail: 'Restart the mission-control-worker container. Overdue schedules recover automatically after it starts.',
      },
      worker: worker ? {
        available: false,
        startedAt: worker.startedAt,
        heartbeatAt: worker.heartbeatAt,
      } : null,
      schedules,
    };
  }

  if (overdue.length === 0) {
    return {
      status: 'healthy' as const,
      message: 'Automatic sync schedules are on time.',
      userAction: null,
      worker: worker ? {
        available: workerAvailable,
        startedAt: worker.startedAt,
        heartbeatAt: worker.heartbeatAt,
      } : null,
      schedules,
    };
  }

  return {
    status: 'action_required' as const,
    message: `${overdue.length} connector schedule${overdue.length === 1 ? ' is' : 's are'} overdue while the worker is online.`,
    userAction: {
      type: 'sync_now' as const,
      label: 'Sync overdue connectors now',
      detail: 'Run these syncs now. If they become overdue again, inspect worker event-loop lag.',
    },
    worker: activeWorker ? {
      available: true,
      startedAt: activeWorker.startedAt,
      heartbeatAt: activeWorker.heartbeatAt,
    } : null,
    schedules,
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const connectorId = body.connectorId;
  const full = body.full === true;

  // In demo mode, simulate a successful sync without hitting external APIs
  if (isDemoMode()) {
    const mockResult = (id: string) => ({
      connectorId: id,
      success: true,
      tasksAdded: Math.floor(Math.random() * 3),
      tasksUpdated: Math.floor(Math.random() * 4),
      tasksRemoved: 0,
      notificationsAdded: Math.floor(Math.random() * 2),
      durationMs: 400 + Math.floor(Math.random() * 1500),
    });

    if (connectorId) {
      return NextResponse.json({ results: [mockResult(connectorId)] });
    }
    return NextResponse.json({ results: ['mstodo-1', 'github-1', 'github-2'].map(mockResult) });
  }

  try {
    let results;
    if (connectorId) {
      const result = await syncScheduler.runSync(connectorId, {
        full,
        signal: request.signal,
        source: 'api',
      });
      results = [result];
    } else {
      results = await syncScheduler.runAll(full);
    }

    syncLogger.info({
      connectorId: connectorId || 'all',
      full,
      resultCount: Array.isArray(results) ? results.length : 1,
    }, 'Sync API triggered');

    // Also trigger My Day sync (best-effort, non-blocking for the response)
    try {
      const baseUrl = request.url.replace(/\/api\/sync.*$/, '');
      const { getLocalToday } = await import('@/lib/utils/date');
      await fetch(`${baseUrl}/api/my-day/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: getLocalToday() }),
      });
    } catch {
      // My Day sync failure shouldn't fail the main sync
    }

    return NextResponse.json({ results: Array.isArray(results) ? results : [results] });
  } catch (error) {
    syncLogger.error({ err: error, connectorId }, 'Sync API failed');
    return ApiErrors.internal('Sync failed', error);
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '15', 10), 1), 50);
    const before = url.searchParams.get('before'); // ISO date cursor

    const status = await syncScheduler.getStatus();
    const isSyncing = await syncScheduler.isSyncing();
    const activeSyncs = await syncScheduler.getActiveSyncs();
    const jobRepository = await getSyncJobRepository();

    const baseQuery = before
      ? db.select().from(syncLog).where(lt(syncLog.syncedAt, before))
      : db.select().from(syncLog);
    // Fetch one extra to determine if there are more pages
    const rows = await baseQuery.orderBy(desc(syncLog.syncedAt)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const history = hasMore ? rows.slice(0, limit) : rows;

    return NextResponse.json({
      status,
      isSyncing,
      activeSyncs,
      queue: await jobRepository.getMetrics(),
      scheduleHealth: await getScheduleHealth(),
      history,
      hasMore,
    });
  } catch (error) {
    syncLogger.error({ err: error }, 'Failed to load sync status and history');
    return NextResponse.json({
      status: {},
      isSyncing: false,
      activeSyncs: [],
      queue: null,
      scheduleHealth: null,
      history: [],
      hasMore: false,
    }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    jobId?: string;
    connectorId?: string;
  };
  try {
    const cancellation = await (await getSyncJobRepository()).requestCancellation(body);
    if (cancellation.cancelled === 0 && cancellation.cancellationRequested === 0) {
      return NextResponse.json(
        {
          cancelled: 0,
          cancellationRequested: 0,
          message: 'No queued or running sync matched the request',
        },
        { status: 404 },
      );
    }
    return NextResponse.json(
      cancellation,
      { status: cancellation.cancellationRequested > 0 ? 202 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        cancelled: 0,
        cancellationRequested: 0,
        message: error instanceof Error ? error.message : 'Invalid request',
      },
      { status: 400 },
    );
  }
}
