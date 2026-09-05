import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimeHealthPersistence,
} from '@/lib/telemetry/database-health-runtime';
import type {
  RuntimeTelemetryPersistence,
} from '@/lib/telemetry/runtime-persistence';
import type { WorkerHealthSnapshot } from '@/lib/telemetry/health-snapshot';
import { runtimeMetricsFixture } from '../contracts/runtime-telemetry-persistence.contract';

vi.mock('@/db', () => {
  throw new Error('SQLite must not be evaluated by PostgreSQL observability routes');
});
vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: () => false,
}));
vi.mock('@/lib/runtime/lifecycle', () => ({
  getRuntimeLifecycleSnapshot: () => ({
    status: 'ready',
    reason: null,
    startedAt: '2026-09-04T00:00:00.000Z',
    drainingAt: null,
    release: 'postgres-observability-test',
    role: 'web',
    activeOperations: {},
    previousExit: null,
  }),
  isRuntimeReady: () => true,
  recordRuntimeMemoryDiagnostics: vi.fn(),
  requestRuntimeRestart: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('poisoned-SQLite PostgreSQL observability routes', () => {
  const now = new Date().toISOString();
  const webMetrics = runtimeMetricsFixture(now, 'web');
  const workerMetrics = runtimeMetricsFixture(now, 'worker');
  const records = [
    {
      role: 'web' as const,
      instanceId: 'web-postgres',
      pid: 101,
      startedAt: now,
      heartbeatAt: now,
      metrics: webMetrics,
    },
    {
      role: 'worker' as const,
      instanceId: 'worker-postgres',
      pid: 102,
      startedAt: now,
      heartbeatAt: now,
      metrics: workerMetrics,
    },
  ];
  const samples = records.map((record, index) => ({
    id: index + 1,
    role: record.role,
    instanceId: record.instanceId,
    pid: record.pid,
    sampledAt: now,
    resolutionSeconds: 10,
    metrics: record.metrics,
  }));
  const snapshot: WorkerHealthSnapshot = {
    schemaVersion: 1,
    generatedAt: now,
    worker: {
      instanceId: 'worker-postgres',
      revision: 'postgres-observability-test',
    },
    generationDurationMs: 5,
    summary: {
      overall: 'healthy',
      message: 'All systems operational',
      database: {
        status: 'healthy',
        message: 'PostgreSQL is available',
        sizeBytes: 4096,
      },
      connectors: [],
      ai: { status: 'disabled', message: 'AI is disabled' },
      disabledFeatures: [],
      runtime: {
        processes: [records[1]],
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
        degradations: [],
      },
    },
  };
  const health: RuntimeHealthPersistence = {
    databaseHealthProbe: {
      inspect: vi.fn(async () => ({
        connected: true,
        severity: 'healthy',
        message: 'PostgreSQL is available',
        sizeBytes: 4096,
        backend: { kind: 'postgres' },
      })),
      hasSeedMarker: vi.fn(async () => true),
    },
    createHealthSnapshotStore: () => ({
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => snapshot),
    }),
  };
  const telemetry: RuntimeTelemetryPersistence = {
    getDatabaseTelemetry: () => undefined,
    registerInstance: vi.fn(async () => undefined),
    persist: vi.fn(async () => undefined),
    recordStop: vi.fn(async () => undefined),
    maintainHistory: vi.fn(async () => undefined),
    getCurrent: vi.fn(async () => records),
    getHistory: vi.fn(async () => samples),
    getAlertHistory: vi.fn(async () => samples),
    getInstances: vi.fn(async () => []),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const healthRuntime = await import('@/lib/telemetry/database-health-runtime');
    const telemetryRuntime = await import('@/lib/telemetry/runtime-persistence');
    healthRuntime.registerRuntimeHealthPersistence(health);
    telemetryRuntime.registerRuntimeTelemetryPersistence(telemetry);
  });

  afterEach(async () => {
    const healthRuntime = await import('@/lib/telemetry/database-health-runtime');
    const telemetryRuntime = await import('@/lib/telemetry/runtime-persistence');
    healthRuntime.clearRuntimeHealthPersistence(health);
    telemetryRuntime.clearRuntimeTelemetryPersistence(telemetry);
  });

  it('serves all six route surfaces through the PostgreSQL composition', async () => {
    const [
      liveRoute,
      readyRoute,
      healthRoute,
      runtimeRoute,
      metricsRoute,
      telemetryRoute,
    ] = await Promise.all([
      import('@/app/api/health/live/route'),
      import('@/app/api/health/ready/route'),
      import('@/app/api/health/route'),
      import('@/app/api/health/runtime/route'),
      import('@/app/api/metrics/route'),
      import('@/app/api/telemetry/runtime/route'),
    ]);

    const live = await liveRoute.GET();
    const ready = await readyRoute.GET();
    const healthResponse = await healthRoute.GET();
    const runtime = await runtimeRoute.GET(new Request(
      'http://localhost/api/health/runtime?role=worker&limit=10',
    ));
    const metrics = await metricsRoute.GET();
    const telemetryResponse = await telemetryRoute.GET(new Request(
      'http://localhost/api/telemetry/runtime?hours=1',
    ));

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(healthResponse.status).toBe(200);
    expect(runtime.status).toBe(200);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('mission_control_runtime_heartbeat_age_seconds');
    expect(telemetryResponse.status).toBe(200);
    expect(await telemetryResponse.json()).toMatchObject({
      current: expect.arrayContaining([
        expect.objectContaining({ instanceId: 'web-postgres' }),
        expect.objectContaining({ instanceId: 'worker-postgres' }),
      ]),
    });
  });
});
