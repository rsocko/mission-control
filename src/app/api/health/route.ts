import { performance } from 'node:perf_hooks';
import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import { getRuntimeLifecycleSnapshot, isRuntimeReady } from '@/lib/runtime/lifecycle';
import { publicRuntimeRelease } from '@/lib/runtime/release';
import {
  readWorkerHealthSnapshot,
  type MaterializedHealthSummary,
} from '@/lib/telemetry/health-snapshot';
import {
  classifyWorkerHealthSnapshot,
  mergeHealthDatabaseSeverity,
  type WorkerHealthSnapshotState,
} from '@/lib/telemetry/health-snapshot-status';
import {
  getFreshDatabaseSeverity,
  getRuntimeDegradations,
} from '@/lib/telemetry/health';
import { getRuntimeTelemetry } from '@/lib/telemetry/runtime';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unavailableSummary(message: string): MaterializedHealthSummary {
  return {
    overall: 'attention',
    message,
    database: { status: 'error', message: 'Worker health snapshot unavailable' },
    connectors: [],
    ai: { status: 'error', message: 'Worker health snapshot unavailable' },
    disabledFeatures: [],
    runtime: {
      processes: [],
      syncQueue: {
        queued: 0,
        running: 0,
        retrying: 0,
        cancelled: 0,
        oldestQueuedAgeMs: 0,
        missedSchedules: 0,
        oldestScheduleOverdueMs: 0,
        overBudget: 0,
        expiredLeases: 0,
      },
      degradations: [message],
    },
  };
}

function snapshotStateMessage(status: WorkerHealthSnapshotState): string {
  if (status === 'missing') return 'Worker health snapshot is missing';
  if (status === 'stale') return 'Worker health snapshot is stale';
  if (status === 'worker-down') return 'Sync worker is not reporting';
  return '';
}

export async function GET() {
  const startedAt = performance.now();
  try {
    const snapshot = await readWorkerHealthSnapshot();
    const currentProcesses = await getRuntimeTelemetry();
    const webRuntime = currentProcesses.find((runtime) => runtime.role === 'web');
    const workerRuntime = currentProcesses.find((runtime) => runtime.role === 'worker');
    const telemetryStaleMs = positiveInteger(process.env.MC_TELEMETRY_STALE_MS, 30_000);
    const state = classifyWorkerHealthSnapshot(snapshot, workerRuntime, {
      snapshotStaleMs: positiveInteger(process.env.MC_HEALTH_SNAPSHOT_STALE_MS, 150_000),
      telemetryStaleMs,
    });
    const stateMessage = snapshotStateMessage(state.status);
    const summary = snapshot?.summary ?? unavailableSummary(stateMessage);
    const webDegradations = webRuntime
      ? getRuntimeDegradations([webRuntime], summary.runtime.syncQueue, {
          durableSyncMode: false,
          telemetryStaleMs,
        })
      : ['web telemetry is unavailable'];
    const webDatabaseSeverity = getFreshDatabaseSeverity(
      webRuntime ? [webRuntime] : [],
      Date.now(),
      telemetryStaleMs,
    );
    const mergedDatabaseSeverity = mergeHealthDatabaseSeverity(
      summary.database.status,
      webDatabaseSeverity,
    );
    const database = summary.database.status === 'error' || mergedDatabaseSeverity === 'healthy'
      ? summary.database
      : {
          ...summary.database,
          status: mergedDatabaseSeverity,
          message: mergedDatabaseSeverity === 'critical'
            ? 'Critical database degradation detected'
            : 'Database degradation detected',
        };
    const degradations = [
      ...summary.runtime.degradations,
      ...webDegradations,
      ...(stateMessage ? [stateMessage] : []),
    ].filter((message, index, all) => all.indexOf(message) === index);
    const lifecycle = getRuntimeLifecycleSnapshot();
    const healthySnapshot = state.status === 'healthy';

    const response = {
      ...summary,
      database,
      overall: healthySnapshot && summary.overall !== 'attention' && webDegradations.length === 0
        ? summary.overall
        : 'attention',
      message: stateMessage || webDegradations[0] || summary.message,
      uptime: process.uptime(),
      version: process.env.npm_package_version || '0.1.0',
      runtime: {
        ...summary.runtime,
        processes: [
          ...summary.runtime.processes.filter((runtime) => runtime.role === 'worker'),
          ...(webRuntime ? [webRuntime] : []),
        ],
        degradations,
      },
      snapshot: {
        status: state.status,
        schemaVersion: snapshot?.schemaVersion ?? null,
        generatedAt: snapshot?.generatedAt ?? null,
        ageMs: state.ageMs,
        generationDurationMs: snapshot?.generationDurationMs ?? null,
        readLatencyMs: Math.round(performance.now() - startedAt),
        workerInstanceId: snapshot?.worker.instanceId ?? null,
        workerRevision: snapshot?.worker.revision ?? null,
      },
      web: {
        live: true,
        ready: isRuntimeReady(),
        revision: publicRuntimeRelease(),
        lifecycle,
      },
    };
    logger.info(
      {
        overall: response.overall,
        snapshotStatus: state.status,
        snapshotAgeMs: state.ageMs,
        readLatencyMs: response.snapshot.readLatencyMs,
      },
      'Health snapshot read completed',
    );
    return NextResponse.json(response);
  } catch (error) {
    logger.error({ err: error }, 'Health snapshot read failed');
    const summary = unavailableSummary('Failed to read worker health snapshot');
    return NextResponse.json({
      ...summary,
      uptime: process.uptime(),
      version: process.env.npm_package_version || '0.1.0',
      snapshot: {
        status: 'missing',
        schemaVersion: null,
        generatedAt: null,
        ageMs: null,
        generationDurationMs: null,
        readLatencyMs: Math.round(performance.now() - startedAt),
        workerInstanceId: null,
        workerRevision: null,
      },
      web: {
        live: true,
        ready: isRuntimeReady(),
        revision: publicRuntimeRelease(),
        lifecycle: getRuntimeLifecycleSnapshot(),
      },
    });
  }
}
