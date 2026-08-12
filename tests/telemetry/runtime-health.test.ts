import { describe, expect, it } from 'vitest';
import {
  getFreshDatabaseSeverity,
  getRuntimeDegradations,
  includeRuntimeHealthHistory,
} from '@/lib/telemetry/health';
import type { RuntimeTelemetryRecord } from '@/lib/telemetry/runtime';
import type { SyncQueueMetrics } from '@/lib/sync/job-queue';

const emptyQueue: SyncQueueMetrics = {
  queued: 0,
  running: 0,
  retrying: 0,
  cancelled: 0,
  oldestQueuedAgeMs: 0,
  missedSchedules: 0,
  oldestScheduleOverdueMs: 0,
  overBudget: 0,
  expiredLeases: 0,
};

function runtime(
  role: 'web' | 'worker',
  overrides: {
    degraded?: boolean;
    heartbeatAt?: string;
    startupProbeMissed?: boolean;
    databaseSeverity?: 'healthy' | 'degraded' | 'critical';
  } = {},
): RuntimeTelemetryRecord {
  return {
    role,
    instanceId: `${role}-1`,
    pid: 1,
    startedAt: '2026-08-03T00:00:00.000Z',
    heartbeatAt: overrides.heartbeatAt ?? '2026-08-03T00:00:10.000Z',
    metrics: {
      schemaVersion: 2,
      role,
      sampledAt: '2026-08-03T00:00:10.000Z',
      buildSha: 'test-sha',
      runtimeMode: 'test',
      eventLoop: {
        p50Ms: 1,
        p95Ms: 2,
        p99Ms: 3,
        maxMs: 4,
        intervalDriftMs: 0,
        sustainedLagSamples: overrides.degraded ? 3 : 0,
        degraded: overrides.degraded ?? false,
      },
      ...(overrides.databaseSeverity
        ? {
            database: {
              severity: overrides.databaseSeverity,
              reasons: ['SQLite WAL checkpoint is starved'],
            } as RuntimeTelemetryRecord['metrics']['database'],
          }
        : {}),
      process: {
        pid: 1,
        uptimeSeconds: 10,
        cpuPercent: 1,
        rssBytes: 1,
        heapUsedBytes: 1,
        heapTotalBytes: 1,
        externalBytes: 1,
        arrayBuffersBytes: 1,
        rssHighWaterBytes: 1,
        rssP95Bytes: 1,
        memorySampleCount: 1,
        activeOperationCategories: [],
        rssHighWaterOperationCategories: [],
        nativeResidualBytes: 0,
        activeResourceCount: 0,
        activeResources: {},
      },
      memory: {
        intervalHighWater: {
          rssBytes: 1,
          heapUsedBytes: 1,
          heapTotalBytes: 1,
          externalBytes: 1,
          arrayBuffersBytes: 1,
        },
        intervalFloor: {
          rssBytes: 1,
          heapUsedBytes: 1,
          heapTotalBytes: 1,
          externalBytes: 1,
          arrayBuffersBytes: 1,
        },
        postGcFloor: null,
        instanceHighWater: {
          rssBytes: 1,
          heapUsedBytes: 1,
          heapTotalBytes: 1,
          externalBytes: 1,
          arrayBuffersBytes: 1,
        },
      },
      workload: {
        active: [],
        activeExpensive: 0,
        queuedExpensive: 0,
      },
      garbageCollection: {
        count: 0,
        durationMs: 0,
        byKind: {},
      },
      requests: {
        completed: 0,
        requestsPerSecond: 0,
        active: 0,
        peakActive: 0,
      },
      host: {
        cpuCount: 1,
        loadAverage: [0, 0, 0],
        totalMemoryBytes: 1,
        freeMemoryBytes: 1,
      },
      container: {
        detected: false,
        cpuUsageUsec: null,
        cpuThrottledUsec: null,
        cpuThrottleEvents: null,
        cpuQuotaCores: null,
        memoryCurrentBytes: null,
        memoryLimitBytes: null,
        memoryHeadroomBytes: null,
        memoryUtilizationPercent: null,
        memoryPressure: 'unavailable',
        memoryWarningPercent: 70,
        memoryCriticalPercent: 85,
        memoryEvents: null,
        restartCount: null,
        unavailable: [],
      },
      ...(role === 'web'
        ? {
            liveness: {
              firstProbeAt: null,
              lastProbeAt: null,
              lastHandlerDurationMs: null,
              startupProbeMissed: overrides.startupProbeMissed ?? false,
            },
          }
        : {}),
    },
  };
}

describe('runtime health degradation', () => {
  it('skips historical telemetry for interactive health summaries', () => {
    expect(includeRuntimeHealthHistory('summary')).toBe(false);
    expect(includeRuntimeHealthHistory(null)).toBe(true);
    expect(includeRuntimeHealthHistory('full')).toBe(true);
  });

  it('alerts on sustained lag, stale heartbeat, startup probe failure, and queue pressure', () => {
    const degradations = getRuntimeDegradations(
      [
        runtime('web', {
          degraded: true,
          heartbeatAt: '2026-08-03T00:00:00.000Z',
          startupProbeMissed: true,
        }),
        runtime('worker'),
      ],
      {
        ...emptyQueue,
        missedSchedules: 2,
        overBudget: 1,
        expiredLeases: 1,
      },
      {
        durableSyncMode: true,
        now: new Date('2026-08-03T00:01:00.000Z').getTime(),
        telemetryStaleMs: 30_000,
      },
    );

    expect(degradations).toEqual(expect.arrayContaining([
      'web event-loop lag is sustained',
      'web telemetry heartbeat is stale',
      'liveness health check missed its startup deadline',
      '2 connector schedules are overdue',
      '1 sync job(s) exceeded their duration budget',
      '1 sync job lease(s) expired',
    ]));
  });

  it('alerts when worker mode has no worker heartbeat', () => {
    expect(getRuntimeDegradations(
      [runtime('web')],
      emptyQueue,
      {
        durableSyncMode: true,
        now: new Date('2026-08-03T00:00:20.000Z').getTime(),
      },
    )).toContain('sync worker has not reported telemetry');
  });

  it('marks critical database degradation with the process role', () => {
    expect(getRuntimeDegradations(
      [runtime('worker', { databaseSeverity: 'critical' })],
      emptyQueue,
      {
        durableSyncMode: true,
        now: new Date('2026-08-03T00:00:20.000Z').getTime(),
      },
    )).toContain('critical: worker SQLite WAL checkpoint is starved');
  });

  it('ignores database degradation from a stale process', () => {
    const processes = [runtime('worker', {
      databaseSeverity: 'critical',
      heartbeatAt: '2026-08-03T00:00:00.000Z',
    })];
    const now = new Date('2026-08-03T00:01:00.000Z').getTime();

    expect(getRuntimeDegradations(
      processes,
      emptyQueue,
      { durableSyncMode: true, now, telemetryStaleMs: 30_000 },
    )).not.toContain('critical: worker SQLite WAL checkpoint is starved');
    expect(getFreshDatabaseSeverity(processes, now, 30_000)).toBe('healthy');
  });
});
