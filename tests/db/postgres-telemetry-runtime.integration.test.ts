import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  getPostgresRuntimeTelemetry,
  getPostgresRuntimeTelemetryHistory,
  getPostgresRuntimeTelemetryInstances,
  maintainPostgresRuntimeTelemetryHistory,
  persistPostgresRuntimeTelemetry,
  recordPostgresRuntimeTelemetryStop,
  registerPostgresRuntimeInstance,
} from '@/db/postgres/telemetry-runtime';
import type { RuntimeMetrics } from '@/lib/telemetry/runtime';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

function fakeMetrics(overrides: Partial<RuntimeMetrics> = {}): RuntimeMetrics {
  return {
    schemaVersion: 2,
    role: 'worker',
    sampledAt: new Date().toISOString(),
    buildSha: 'sha-test',
    runtimeMode: 'test',
    eventLoop: {
      p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4, intervalDriftMs: 0, sustainedLagSamples: 0, degraded: false,
    },
    process: {
      pid: process.pid, uptimeSeconds: 1, cpuPercent: 1,
      rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 75, externalBytes: 0, arrayBuffersBytes: 0,
      rssHighWaterBytes: 100, rssP95Bytes: 100, memorySampleCount: 1,
      activeOperationCategories: [], rssHighWaterOperationCategories: [],
      nativeResidualBytes: 0, activeResourceCount: 0, activeResources: {},
    },
    memory: {
      intervalHighWater: { rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 75, externalBytes: 0, arrayBuffersBytes: 0 },
      intervalFloor: { rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 75, externalBytes: 0, arrayBuffersBytes: 0 },
      postGcFloor: null,
      instanceHighWater: { rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 75, externalBytes: 0, arrayBuffersBytes: 0 },
    },
    garbageCollection: { count: 0, durationMs: 0, byKind: {} },
    requests: { completed: 0, requestsPerSecond: 0, active: 0, peakActive: 0 },
    workload: { active: [], activeExpensive: 0, queuedExpensive: 0 },
    host: { cpuCount: 1, loadAverage: [0, 0, 0], totalMemoryBytes: 100, freeMemoryBytes: 50 },
    container: {
      detected: false, cpuUsageUsec: null, cpuThrottledUsec: null, cpuThrottleEvents: null, cpuQuotaCores: null,
      memoryCurrentBytes: null, memoryLimitBytes: null, memoryHeadroomBytes: null, memoryUtilizationPercent: null,
      memoryPressure: 'unavailable', memoryWarningPercent: 70, memoryCriticalPercent: 85, memoryEvents: null,
      restartCount: null, restartCountSource: 'unavailable', unavailable: [],
    },
    ...overrides,
  } as RuntimeMetrics;
}

describePostgres('PostgreSQL runtime telemetry adapter integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-runtime-telemetry-test',
          }),
        }
      : {}),
  });
  const instanceIds = new Set<string>();

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
  }, 120_000);

  afterAll(async () => {
    for (const id of instanceIds) {
      await backend.context.pool.query('DELETE FROM runtime_telemetry WHERE instance_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM runtime_telemetry_samples WHERE instance_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM runtime_telemetry_instances WHERE instance_id = $1', [id]);
    }
    await backend.shutdown();
  });

  it('registers an instance, persists telemetry, and reads it back with jsonb round-tripping (no JSON.parse needed)', async () => {
    const instanceId = `instance-${randomUUID()}`;
    instanceIds.add(instanceId);
    const startedAt = new Date().toISOString();

    await registerPostgresRuntimeInstance(backend.context.pool, {
      instanceId,
      role: 'worker',
      pid: 4242,
      startedAt,
      restartCount: 2,
      buildSha: 'sha-test',
      runtimeMode: 'test',
      highWaterMetrics: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1, arrayBuffersBytes: 1 },
      restartReason: 'instance_replaced',
    });

    const metrics = fakeMetrics({ sampledAt: new Date().toISOString() });
    await persistPostgresRuntimeTelemetry(backend.context.pool, {
      role: 'worker',
      instanceId,
      pid: 4242,
      startedAt,
      metrics,
      resolutionSeconds: 10,
      highWaterMetrics: metrics.memory.instanceHighWater,
    });

    const instances = await getPostgresRuntimeTelemetryInstances(backend.context.pool, 72);
    const registered = instances.find((instance) => instance.instanceId === instanceId);
    expect(registered).toBeDefined();
    expect(registered?.restartCount).toBe(2);
    expect(registered?.highWaterMetrics).toEqual(metrics.memory.instanceHighWater);

    const history = await getPostgresRuntimeTelemetryHistory(backend.context.pool, {
      since: new Date(Date.now() - 60_000).toISOString(),
      limit: 100,
    });
    const sample = history.find((entry) => entry.instanceId === instanceId);
    expect(sample).toBeDefined();
    expect(sample?.metrics.buildSha).toBe('sha-test');
    expect(sample?.metrics.process.pid).toBe(metrics.process.pid);
  });

  it('recordPostgresRuntimeTelemetryStop marks the instance stopped with a terminal reason', async () => {
    const instanceId = `instance-stop-${randomUUID()}`;
    instanceIds.add(instanceId);
    const startedAt = new Date().toISOString();
    await registerPostgresRuntimeInstance(backend.context.pool, {
      instanceId,
      role: 'web',
      pid: 4343,
      startedAt,
      restartCount: null,
      buildSha: null,
      runtimeMode: 'test',
      highWaterMetrics: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1, arrayBuffersBytes: 1 },
      restartReason: 'instance_replaced',
    });

    const terminalMetrics = fakeMetrics({ role: 'web', sampledAt: new Date().toISOString() });
    await recordPostgresRuntimeTelemetryStop(backend.context.pool, {
      instanceId,
      reason: 'SIGTERM',
      terminalMetrics,
    });

    const instances = await getPostgresRuntimeTelemetryInstances(backend.context.pool, 72);
    const stopped = instances.find((instance) => instance.instanceId === instanceId);
    expect(stopped?.stoppedAt).toBe(terminalMetrics.sampledAt);
    expect(stopped?.terminalReason).toBe('SIGTERM');
    expect(stopped?.terminalMetrics?.role).toBe('web');
  });

  it('getPostgresRuntimeTelemetry returns the latest per-role heartbeat row', async () => {
    const instanceId = `instance-current-${randomUUID()}`;
    instanceIds.add(instanceId);
    const startedAt = new Date().toISOString();
    await registerPostgresRuntimeInstance(backend.context.pool, {
      instanceId,
      role: 'worker',
      pid: 5151,
      startedAt,
      restartCount: null,
      buildSha: null,
      runtimeMode: 'test',
      highWaterMetrics: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1, arrayBuffersBytes: 1 },
      restartReason: 'instance_replaced',
    });
    const metrics = fakeMetrics({ sampledAt: new Date().toISOString() });
    await persistPostgresRuntimeTelemetry(backend.context.pool, {
      role: 'worker',
      instanceId,
      pid: 5151,
      startedAt,
      metrics,
      resolutionSeconds: 10,
      highWaterMetrics: metrics.memory.instanceHighWater,
    });

    const current = await getPostgresRuntimeTelemetry(backend.context.pool);
    const worker = current.find((entry) => entry.role === 'worker');
    expect(worker?.instanceId).toBe(instanceId);
  });

  it('maintainPostgresRuntimeTelemetryHistory downsamples old raw samples and prunes expired instances', async () => {
    const instanceId = `instance-maintain-${randomUUID()}`;
    instanceIds.add(instanceId);
    const now = new Date('2000-08-06T12:00:00.000Z');
    const base = fakeMetrics({ sampledAt: '2000-08-06T04:01:00.000Z' });

    await backend.context.pool.query(
      `INSERT INTO runtime_telemetry_samples (instance_id, role, pid, sampled_at, resolution_seconds, metrics)
       VALUES ($1, 'worker', 42, $2, 10, $3)`,
      [instanceId, '2000-08-06T04:01:00.000Z', JSON.stringify({ ...base, memory: { ...base.memory, intervalHighWater: { ...base.memory.intervalHighWater, externalBytes: 900 } } })],
    );
    await backend.context.pool.query(
      `INSERT INTO runtime_telemetry_samples (instance_id, role, pid, sampled_at, resolution_seconds, metrics)
       VALUES ($1, 'worker', 42, $2, 10, $3)`,
      [instanceId, '2000-08-06T04:02:00.000Z', JSON.stringify({ ...base, memory: { ...base.memory, intervalHighWater: { ...base.memory.intervalHighWater, externalBytes: 100 } } })],
    );
    await backend.context.pool.query(
      `INSERT INTO runtime_telemetry_instances (instance_id, role, pid, started_at, last_seen_at, runtime_mode, high_water_metrics)
       VALUES ($1, 'worker', 42, $2, $2, 'test', '{}')`,
      [instanceId, '2000-08-06T04:02:00.000Z'],
    );

    await maintainPostgresRuntimeTelemetryHistory(backend.context.pool, now);

    const { rows } = await backend.context.pool.query<{ resolutionSeconds: number; metrics: { memory: { intervalHighWater: { externalBytes: number } } } }>(
      `SELECT resolution_seconds AS "resolutionSeconds", metrics FROM runtime_telemetry_samples WHERE instance_id = $1`,
      [instanceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].resolutionSeconds).toBe(300);
    expect(rows[0].metrics.memory.intervalHighWater.externalBytes).toBe(900);
  });
});
