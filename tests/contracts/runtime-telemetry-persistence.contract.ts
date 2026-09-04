import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  RuntimeTelemetryPersistence,
} from '@/lib/telemetry/runtime-persistence';
import type {
  RuntimeMemoryValues,
  RuntimeMetrics,
} from '@/lib/telemetry/runtime';

export interface RuntimeTelemetryPersistenceHarness {
  persistence: RuntimeTelemetryPersistence;
  instanceId: string;
  close(): Promise<void> | void;
}

const MEMORY: RuntimeMemoryValues = {
  rssBytes: 100,
  heapUsedBytes: 50,
  heapTotalBytes: 75,
  externalBytes: 10,
  arrayBuffersBytes: 5,
};

export function runtimeMetricsFixture(
  sampledAt: string,
  role: RuntimeMetrics['role'] = 'worker',
): RuntimeMetrics {
  return {
    schemaVersion: 2,
    role,
    sampledAt,
    buildSha: 'contract-sha',
    runtimeMode: 'test',
    eventLoop: {
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3,
      maxMs: 4,
      intervalDriftMs: 0,
      sustainedLagSamples: 0,
      degraded: false,
    },
    process: {
      pid: 4242,
      uptimeSeconds: 1,
      cpuPercent: 1,
      ...MEMORY,
      rssHighWaterBytes: MEMORY.rssBytes,
      rssP95Bytes: MEMORY.rssBytes,
      memorySampleCount: 1,
      activeOperationCategories: [],
      rssHighWaterOperationCategories: [],
      nativeResidualBytes: 15,
      activeResourceCount: 0,
      activeResources: {},
    },
    memory: {
      intervalHighWater: MEMORY,
      intervalFloor: MEMORY,
      postGcFloor: MEMORY,
      instanceHighWater: MEMORY,
    },
    garbageCollection: { count: 0, durationMs: 0, byKind: {} },
    requests: { completed: 0, requestsPerSecond: 0, active: 0, peakActive: 0 },
    workload: { active: [], activeExpensive: 0, queuedExpensive: 0 },
    host: {
      cpuCount: 1,
      loadAverage: [0, 0, 0],
      totalMemoryBytes: 100,
      freeMemoryBytes: 50,
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
      restartCountSource: 'unavailable',
      unavailable: [],
    },
  };
}

export function describeRuntimeTelemetryPersistenceContract(
  name: string,
  createHarness: () => (
    RuntimeTelemetryPersistenceHarness
    | Promise<RuntimeTelemetryPersistenceHarness>
  ),
): void {
  describe(`${name} runtime telemetry persistence contract`, () => {
    let harness: RuntimeTelemetryPersistenceHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('registers, persists, and reads current and historical telemetry', async () => {
      const sampledAt = new Date().toISOString();
      const metrics = runtimeMetricsFixture(sampledAt);
      await harness.persistence.registerInstance({
        instanceId: harness.instanceId,
        role: 'worker',
        pid: metrics.process.pid,
        startedAt: sampledAt,
        restartCount: null,
        buildSha: metrics.buildSha,
        runtimeMode: metrics.runtimeMode,
        highWaterMetrics: metrics.memory.instanceHighWater,
        restartReason: 'instance_replaced',
      });
      await harness.persistence.persist({
        role: 'worker',
        instanceId: harness.instanceId,
        pid: metrics.process.pid,
        startedAt: sampledAt,
        metrics,
        resolutionSeconds: 10,
        highWaterMetrics: metrics.memory.instanceHighWater,
      });

      const current = await harness.persistence.getCurrent();
      expect(current.find((entry) => entry.instanceId === harness.instanceId))
        .toMatchObject({ role: 'worker', metrics: { buildSha: 'contract-sha' } });

      const history = await harness.persistence.getHistory({
        role: 'worker',
        since: new Date(Date.now() - 60_000).toISOString(),
        limit: 10,
      });
      expect(history.find((entry) => entry.instanceId === harness.instanceId))
        .toMatchObject({ resolutionSeconds: 10, metrics: { buildSha: 'contract-sha' } });

      const alerts = await harness.persistence.getAlertHistory(1);
      expect(alerts.some((entry) => entry.instanceId === harness.instanceId)).toBe(true);
    });

    it('honors an explicit history limit while preserving chronological output', async () => {
      const firstAt = new Date(Date.now() - 1_000).toISOString();
      const secondAt = new Date().toISOString();
      await harness.persistence.registerInstance({
        instanceId: harness.instanceId,
        role: 'worker',
        pid: 4242,
        startedAt: firstAt,
        restartCount: null,
        buildSha: 'contract-sha',
        runtimeMode: 'test',
        highWaterMetrics: MEMORY,
        restartReason: 'instance_replaced',
      });
      for (const sampledAt of [firstAt, secondAt]) {
        const metrics = runtimeMetricsFixture(sampledAt);
        await harness.persistence.persist({
          role: 'worker',
          instanceId: harness.instanceId,
          pid: metrics.process.pid,
          startedAt: firstAt,
          metrics,
          resolutionSeconds: 10,
          highWaterMetrics: metrics.memory.instanceHighWater,
        });
      }

      const bounded = await harness.persistence.getHistory({
        role: 'worker',
        since: new Date(new Date(firstAt).getTime() - 1_000).toISOString(),
        limit: 1,
      });
      expect(bounded.filter((entry) => entry.instanceId === harness.instanceId))
        .toHaveLength(1);
      expect(bounded.find((entry) => entry.instanceId === harness.instanceId)?.sampledAt)
        .toBe(secondAt);
    });

    it('records terminal telemetry and instance metadata', async () => {
      const sampledAt = new Date().toISOString();
      const metrics = runtimeMetricsFixture(sampledAt, 'web');
      await harness.persistence.registerInstance({
        instanceId: harness.instanceId,
        role: 'web',
        pid: metrics.process.pid,
        startedAt: sampledAt,
        restartCount: 3,
        buildSha: metrics.buildSha,
        runtimeMode: metrics.runtimeMode,
        highWaterMetrics: metrics.memory.instanceHighWater,
        restartReason: 'instance_replaced',
      });
      await harness.persistence.recordStop({
        instanceId: harness.instanceId,
        reason: 'contract_shutdown',
        terminalMetrics: metrics,
      });

      const instances = await harness.persistence.getInstances(1);
      expect(instances.find((entry) => entry.instanceId === harness.instanceId))
        .toMatchObject({
          role: 'web',
          restartCount: 3,
          terminalReason: 'contract_shutdown',
          terminalMetrics: { buildSha: 'contract-sha' },
        });
    });
  });
}
