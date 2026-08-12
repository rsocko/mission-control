import { describe, expect, it } from 'vitest';
import { getRuntimeAlerts } from '@/lib/telemetry/analysis';
import type {
  RuntimeMetrics,
  RuntimeTelemetryInstance,
  RuntimeTelemetryRecord,
  RuntimeTelemetrySample,
} from '@/lib/telemetry/runtime';

function metrics(overrides: {
  sampledAt?: string;
  rss?: number;
  heapFloor?: number;
  external?: number;
  eventLoopDegraded?: boolean;
  cgroupCurrent?: number;
  cgroupLimit?: number;
} = {}): RuntimeMetrics {
  const rss = overrides.rss ?? 100 * 1024 ** 2;
  const external = overrides.external ?? 10 * 1024 ** 2;
  const memory = {
    rssBytes: rss,
    heapUsedBytes: overrides.heapFloor ?? 50 * 1024 ** 2,
    heapTotalBytes: 100 * 1024 ** 2,
    externalBytes: external,
    arrayBuffersBytes: external / 2,
  };
  return {
    schemaVersion: 2,
    role: 'web',
    sampledAt: overrides.sampledAt ?? '2026-08-06T12:00:00.000Z',
    buildSha: 'sha',
    runtimeMode: 'test',
    eventLoop: {
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: overrides.eventLoopDegraded ? 500 : 3,
      maxMs: overrides.eventLoopDegraded ? 500 : 4,
      intervalDriftMs: 0,
      sustainedLagSamples: overrides.eventLoopDegraded ? 3 : 0,
      degraded: overrides.eventLoopDegraded ?? false,
    },
    process: { pid: 1, uptimeSeconds: 10, cpuPercent: 1, ...memory },
    memory: {
      intervalHighWater: memory,
      intervalFloor: memory,
      postGcFloor: memory,
      instanceHighWater: memory,
    },
    workload: { active: [], activeExpensive: 0, queuedExpensive: 0 },
    host: {
      cpuCount: 1,
      loadAverage: [0, 0, 0],
      totalMemoryBytes: 1,
      freeMemoryBytes: 1,
    },
    container: {
      detected: true,
      cpuUsageUsec: 1,
      cpuThrottledUsec: 0,
      cpuThrottleEvents: 0,
      cpuQuotaCores: 1,
      memoryCurrentBytes: overrides.cgroupCurrent ?? 100 * 1024 ** 2,
      memoryLimitBytes: overrides.cgroupLimit ?? 1024 ** 3,
      restartCount: 0,
      unavailable: [],
    },
  };
}

function record(value: RuntimeMetrics): RuntimeTelemetryRecord {
  return {
    role: 'web',
    instanceId: 'web-1',
    pid: 1,
    startedAt: '2026-08-06T10:00:00.000Z',
    heartbeatAt: value.sampledAt,
    metrics: value,
  };
}

function sample(id: number, value: RuntimeMetrics): RuntimeTelemetrySample {
  return {
    id,
    role: 'web',
    instanceId: 'web-1',
    sampledAt: value.sampledAt,
    resolutionSeconds: 300,
    metrics: value,
  };
}

describe('runtime telemetry alerts', () => {
  it('distinguishes external pressure, event-loop lag, and low cgroup headroom', () => {
    const current = record(metrics({
      rss: 800 * 1024 ** 2,
      external: 300 * 1024 ** 2,
      eventLoopDegraded: true,
      cgroupCurrent: 950,
      cgroupLimit: 1_000,
    }));

    expect(getRuntimeAlerts([current]).map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        'external-pressure',
        'event-loop-lag',
        'low-cgroup-headroom',
      ]),
    );
  });

  it('alerts on sustained heap-floor growth and repeated restarts', () => {
    const first = metrics({
      sampledAt: '2026-08-06T10:00:00.000Z',
      heapFloor: 50 * 1024 ** 2,
    });
    const last = metrics({
      sampledAt: '2026-08-06T11:00:00.000Z',
      heapFloor: 150 * 1024 ** 2,
    });
    const instances = [
      ['old-1', new Date(Date.now() - 10 * 60_000).toISOString()],
      ['old-2', new Date(Date.now() - 30 * 60_000).toISOString()],
    ].map(([instanceId, stoppedAt]) => ({
      instanceId,
      role: 'web',
      pid: 1,
      startedAt: '2026-08-06T10:00:00.000Z',
      lastSeenAt: stoppedAt,
      stoppedAt,
      terminalReason: 'oom',
      restartCount: 1,
      buildSha: 'sha',
      runtimeMode: 'test',
      highWaterMetrics: first.memory.instanceHighWater,
      terminalMetrics: first,
    })) satisfies RuntimeTelemetryInstance[];

    expect(getRuntimeAlerts(
      [record(last)],
      [sample(1, first), sample(2, last)],
      instances,
    ).map((alert) => alert.code)).toEqual(
      expect.arrayContaining(['heap-growth', 'repeated-restarts']),
    );
  });
});
