import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.fn();
const all = vi.fn(() => []);
const prepare = vi.fn(() => ({ run, all }));
vi.mock('@/db', () => ({
  sqlite: {
    prepare,
  },
  getDatabaseTelemetry: vi.fn(() => ({
    sampledAt: '2026-08-03T00:00:10.000Z',
    windowStartedAt: '2026-08-03T00:00:00.000Z',
    sampleInterval: {
      startedAt: '2026-08-03T00:00:00.000Z',
      operationCount: 2,
      synchronousDatabaseTimeMs: 12,
      contentionFailureCount: 0,
      busyTimeoutCount: 0,
    },
    operations: {
      total: {
        count: 2,
        failureCount: 0,
        totalDurationMs: 12,
        maxDurationMs: 8,
        p50Ms: 4,
        p95Ms: 8,
        p99Ms: 8,
      },
      byCategory: {
        read: {
          count: 2,
          failureCount: 0,
          totalDurationMs: 12,
          maxDurationMs: 8,
          p50Ms: 4,
          p95Ms: 8,
          p99Ms: 8,
        },
      },
      byOperation: {},
    },
    contention: {
      writerAcquisitionCount: 0,
      writerAcquisitionDurationMs: 0,
      writerAcquisitionP95Ms: 0,
      writerAcquisitionP99Ms: 0,
      successfulWaitCount: 0,
      successfulWaitDurationMs: 0,
      busyFailureCount: 0,
      busyTimeoutCount: 0,
      lastBusyAt: null,
    },
    wal: {
      available: true,
      sizeBytes: 0,
      checkpointBusy: false,
      logFrames: 0,
      checkpointedFrames: 0,
      pendingFrames: 0,
      checkpointAgeMs: 0,
      checkpointAttemptedAt: '2026-08-03T00:00:10.000Z',
      starved: false,
      errorCode: null,
    },
    slowOperations: [],
    thresholds: {
      slowOperationMs: 100,
      latencyP95WarningMs: 100,
      latencyP99CriticalMs: 500,
      busyWaitWarningMs: 100,
      busyTimeoutMs: 5_000,
      walWarningBytes: 67_108_864,
      walCriticalBytes: 268_435_456,
      checkpointStarvationMs: 60_000,
      checkpointPendingFrames: 1_000,
      checkpointProbeIntervalMs: 60_000,
      observationWindowMs: 300_000,
    },
    severity: 'healthy',
    reasons: [],
  })),
  withoutDatabaseObservation: <T>(callback: () => T) => callback(),
}));
vi.mock('@/lib/logger', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('runtime telemetry', () => {
  let cgroupRoot: string;

  beforeEach(() => {
    cgroupRoot = mkdtempSync(join(tmpdir(), 'mc-cgroup-'));
    writeFileSync(join(cgroupRoot, 'cpu.stat'), [
      'usage_usec 10000',
      'nr_throttled 3',
      'throttled_usec 2500',
    ].join('\n'));
    writeFileSync(join(cgroupRoot, 'cpu.max'), '50000 100000');
    writeFileSync(join(cgroupRoot, 'memory.current'), '1048576');
    writeFileSync(join(cgroupRoot, 'memory.max'), '2097152');
    writeFileSync(join(cgroupRoot, 'memory.events'), [
      'low 0',
      'high 1',
      'max 2',
      'oom 3',
      'oom_kill 1',
    ].join('\n'));
    process.env.MC_CGROUP_ROOT = cgroupRoot;
    process.env.MC_DEPLOYMENT_REVISION = 'sha-test';
    process.env.MC_EVENT_LOOP_LAG_THRESHOLD_MS = '1';
    process.env.MC_EVENT_LOOP_LAG_SUSTAINED_SAMPLES = '1';
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.MC_CGROUP_ROOT;
    delete process.env.MC_EVENT_LOOP_LAG_THRESHOLD_MS;
    delete process.env.MC_EVENT_LOOP_LAG_SUSTAINED_SAMPLES;
    delete process.env.MC_MEMORY_CRITICAL_SAMPLES;
    delete process.env.MC_CGROUP_PATH;
    delete process.env.MC_PROC_ROOT;
    delete process.env.MC_CONTAINER_RESTART_COUNT;
    delete process.env.MC_DEPLOYMENT_REVISION;
    rmSync(cgroupRoot, { recursive: true, force: true });
  });

  it.each(['web', 'worker'] as const)(
    'captures event-loop, process, host, and cgroup pressure for %s',
    async (role) => {
      const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
      const monitor = new RuntimeTelemetryMonitor(role);
      const metrics = await monitor.sampleAndPersist(performance.now() + 20_000);

      expect(metrics.buildSha).toBe('sha-test');
      expect(metrics.eventLoop.degraded).toBe(true);
      expect(metrics.process.pid).toBe(process.pid);
    expect(metrics.process.externalBytes).toBeGreaterThanOrEqual(0);
    expect(metrics.process.arrayBuffersBytes).toBeGreaterThanOrEqual(0);
    expect(metrics.memory).toHaveProperty('postGcFloor');
    expect(metrics.process).toMatchObject({
      nativeResidualBytes: expect.any(Number),
      activeResourceCount: expect.any(Number),
      activeResources: expect.any(Object),
    });
    expect(metrics.garbageCollection).toEqual({
      count: 0,
      durationMs: 0,
      byKind: {},
    });
    expect(metrics.requests).toEqual({
      completed: 0,
      requestsPerSecond: 0,
      active: 0,
      peakActive: 0,
    });
    expect(metrics.host.cpuCount).toBeGreaterThan(0);
    expect(metrics.container).toMatchObject({
      detected: true,
      cpuUsageUsec: 10000,
      cpuThrottledUsec: 2500,
      cpuThrottleEvents: 3,
      cpuQuotaCores: 0.5,
      memoryCurrentBytes: 1048576,
      memoryLimitBytes: 2097152,
      memoryHeadroomBytes: 1048576,
      memoryUtilizationPercent: 50,
      memoryPressure: 'healthy',
      memoryEvents: {
        low: 0,
        high: 1,
        max: 2,
        oom: 3,
        oomKill: 1,
      },
      restartCount: null,
      restartCountSource: 'unavailable',
      unavailable: expect.arrayContaining([
        'restartCount: container runtime metadata is not available in-process',
      ]),
    });
    expect(metrics.process).toMatchObject({
      externalBytes: expect.any(Number),
      arrayBuffersBytes: expect.any(Number),
      rssHighWaterBytes: expect.any(Number),
      rssP95Bytes: expect.any(Number),
      memorySampleCount: 1,
      activeOperationCategories: [],
      rssHighWaterOperationCategories: [],
    });
    expect(metrics.database?.eventLoopCorrelation).toMatchObject({
      synchronousDatabaseTimeMs: 12,
      operationCount: 2,
    });
      expect(run).toHaveBeenCalledTimes(3);
      expect(prepare.mock.calls.some(([sql]) =>
        String(sql).includes('ON CONFLICT(instance_id, sampled_at, resolution_seconds)'),
      )).toBe(true);
      await monitor.stop();
    },
  );

  it('resolves cgroup v2 metrics from the process cgroup path', async () => {
    const nestedRoot = join(cgroupRoot, 'containers', 'web');
    const procRoot = join(cgroupRoot, 'proc');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nestedRoot, { recursive: true });
    mkdirSync(join(procRoot, 'self'), { recursive: true });
    writeFileSync(join(procRoot, 'self', 'cgroup'), '0::/containers/web\n');
    writeFileSync(join(nestedRoot, 'memory.current'), '524288');
    writeFileSync(join(nestedRoot, 'memory.max'), '1048576');
    writeFileSync(join(nestedRoot, 'memory.events'), 'oom 0\noom_kill 0\n');
    process.env.MC_PROC_ROOT = procRoot;

    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('web');
    const metrics = monitor.sample();

    expect(metrics.container).toMatchObject({
      detected: true,
      memoryCurrentBytes: 524288,
      memoryLimitBytes: 1048576,
      memoryUtilizationPercent: 50,
    });
    await monitor.stop();
  });

  it('records configured restart-count provenance without guessing invalid values', async () => {
    process.env.MC_CONTAINER_RESTART_COUNT = '4';
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const configured = new RuntimeTelemetryMonitor('worker');
    expect(configured.sample().container).toMatchObject({
      restartCount: 4,
      restartCountSource: 'environment',
    });
    await configured.stop();

    process.env.MC_CONTAINER_RESTART_COUNT = 'unknown';
    const unavailable = new RuntimeTelemetryMonitor('worker');
    expect(unavailable.sample().container).toMatchObject({
      restartCount: null,
      restartCountSource: 'unavailable',
      unavailable: expect.arrayContaining([
        'restartCount: MC_CONTAINER_RESTART_COUNT is not a non-negative integer',
      ]),
    });
    await unavailable.stop();
  });

  it('warns before requesting a restart after sustained critical memory pressure', async () => {
    writeFileSync(join(cgroupRoot, 'memory.current'), '1572864');
    const { default: logger } = await import('@/lib/logger');
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const warningMonitor = new RuntimeTelemetryMonitor('web', {
      onCriticalMemory: vi.fn(),
    });
    const warning = warningMonitor.sample(performance.now() + 10_000);
    expect(warning.container.memoryPressure).toBe('warning');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: expect.objectContaining({ pressure: 'warning' }),
      }),
      'Container memory pressure warning',
    );
    await warningMonitor.stop();

    writeFileSync(join(cgroupRoot, 'memory.current'), '1887437');
    process.env.MC_MEMORY_CRITICAL_SAMPLES = '2';
    const onCriticalMemory = vi.fn();
    const monitor = new RuntimeTelemetryMonitor('web', { onCriticalMemory });

    const first = monitor.sample(performance.now() + 20_000);
    const second = monitor.sample(performance.now() + 40_000);

    expect(first.container.memoryPressure).toBe('critical');
    expect(first.container.memoryHeadroomBytes).toBeGreaterThan(0);
    expect(second.container.memoryPressure).toBe('critical');
    expect(onCriticalMemory).toHaveBeenCalledOnce();
    expect(onCriticalMemory).toHaveBeenCalledWith(expect.objectContaining({
      pressure: 'critical',
      containerLimitBytes: 2097152,
      containerOomKillEvents: 1,
    }));
    await monitor.stop();
  });

  it('ignores malformed cgroup event values without emitting NaN diagnostics', async () => {
    writeFileSync(join(cgroupRoot, 'memory.events'), 'oom\nbad nope\noom_kill 2');
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('worker');

    const metrics = monitor.sample(performance.now() + 20_000);

    expect(metrics.container.memoryEvents).toMatchObject({
      oom: 0,
      oomKill: 2,
    });
    expect(metrics.container.unavailable).toEqual(
      expect.arrayContaining([expect.stringContaining('memory.events: invalid entry')]),
    );
    await monitor.stop();
  });

  it('keeps monitoring when telemetry persistence fails', async () => {
    run.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { default: logger } = await import('@/lib/logger');
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('worker');

    await expect(monitor.sampleAndPersist(performance.now() + 20_000)).resolves.not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker' }),
      'Runtime telemetry persistence failed',
    );
    await monitor.stop();
  });

  it('returns parsed historical samples in query order', async () => {
    all.mockReturnValueOnce([{
      id: 1,
      role: 'web',
      instanceId: 'web-1',
      pid: 123,
      sampledAt: '2026-08-03T00:00:10.000Z',
      metrics: JSON.stringify({
        eventLoop: {},
        process: {},
        garbageCollection: {},
        requests: {},
        host: {},
        container: { unavailable: ['memory.max: ENOENT'] },
      }),
    }]);
    const { getRuntimeTelemetryHistory } = await import('@/lib/telemetry/runtime');

    const samples = await getRuntimeTelemetryHistory({
      role: 'web',
      since: '2026-08-03T00:00:00.000Z',
      limit: 10,
    });

    expect(samples).toEqual([expect.objectContaining({
      id: 1,
      role: 'web',
      metrics: expect.objectContaining({
        requests: {},
        container: expect.objectContaining({
          restartCount: null,
          restartCountSource: 'unavailable',
          unavailable: [
            'memory.max: ENOENT',
            'restartCount: not recorded by this historical sample',
          ],
        }),
      }),
    })]);
    expect(all).toHaveBeenCalledWith('2026-08-03T00:00:00.000Z', 'web', 10);
  });

  it('releases request concurrency on completion and disconnect', async () => {
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('worker');
    await monitor.start();
    const requestChannel = channel('http.server.request.start');

    const abortedResponse = new EventEmitter();
    requestChannel.publish({ response: abortedResponse });
    expect(monitor.sample().requests.active).toBe(1);
    abortedResponse.emit('close');
    expect(monitor.sample().requests).toMatchObject({ active: 0, completed: 0 });

    const completedResponse = new EventEmitter();
    requestChannel.publish({ response: completedResponse });
    completedResponse.emit('finish');
    expect(monitor.sample().requests).toMatchObject({ active: 0, completed: 1 });
    await monitor.stop();
  });

  it('retains a short-lived external-memory spike in interval high-water metrics', async () => {
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('web');
    const current = process.memoryUsage();
    monitor.observeMemoryUsage({
      ...current,
      rss: current.rss + 64 * 1024 ** 2,
      external: current.external + 48 * 1024 ** 2,
      arrayBuffers: current.arrayBuffers + 32 * 1024 ** 2,
    });

    const metrics = monitor.sample(performance.now() + 20_000);

    expect(metrics.memory.intervalHighWater.externalBytes)
      .toBeGreaterThanOrEqual(current.external + 48 * 1024 ** 2);
    expect(metrics.memory.intervalHighWater.arrayBuffersBytes)
      .toBeGreaterThanOrEqual(current.arrayBuffers + 32 * 1024 ** 2);
    await monitor.stop();
  });

  it('deserializes records written before external-memory fields were added', async () => {
    const { deserializeRuntimeMetrics } = await import('@/lib/telemetry/runtime');
    const metrics = deserializeRuntimeMetrics(JSON.stringify({
      role: 'web',
      sampledAt: '2026-08-03T00:00:10.000Z',
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
        pid: 1,
        uptimeSeconds: 10,
        cpuPercent: 1,
        rssBytes: 100,
        heapUsedBytes: 50,
        heapTotalBytes: 75,
      },
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
        restartCount: null,
        unavailable: [],
      },
    }));

    expect(metrics.schemaVersion).toBe(2);
    expect(metrics.process.externalBytes).toBe(0);
    expect(metrics.memory.intervalHighWater.rssBytes).toBe(100);
    expect(metrics.memory.postGcFloor).toBeNull();
    expect(metrics.workload.active).toEqual([]);
  });

  it('downsamples old raw samples, preserves peaks, and expires retained history', async () => {
    const {
      maintainRuntimeTelemetryHistory,
      RuntimeTelemetryMonitor,
    } = await import('@/lib/telemetry/runtime');
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE runtime_telemetry_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        role TEXT NOT NULL,
        pid INTEGER NOT NULL,
        sampled_at TEXT NOT NULL,
        resolution_seconds INTEGER NOT NULL,
        metrics TEXT NOT NULL,
        UNIQUE(instance_id, sampled_at, resolution_seconds)
      );
      CREATE TABLE runtime_telemetry_instances (
        instance_id TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL
      );
    `);
    const monitor = new RuntimeTelemetryMonitor('worker');
    const base = monitor.sample(performance.now() + 20_000);
    await monitor.stop();
    const now = new Date('2026-08-06T12:00:00.000Z');
    const insert = database.prepare(`
      INSERT INTO runtime_telemetry_samples
        (instance_id, role, pid, sampled_at, resolution_seconds, metrics)
      VALUES (?, 'worker', 42, ?, 10, ?)
    `);
    const first = structuredClone(base);
    first.memory.intervalHighWater.externalBytes = 900;
    first.process.activeResourceCount = base.process.activeResourceCount + 12;
    first.requests.peakActive = 8;
    insert.run('worker-1', '2026-08-06T04:01:00.000Z', JSON.stringify(first));
    const second = structuredClone(base);
    second.memory.intervalHighWater.externalBytes = 100;
    insert.run('worker-1', '2026-08-06T04:02:00.000Z', JSON.stringify(second));
    insert.run('expired', '2026-08-03T04:00:00.000Z', JSON.stringify(base));
    database.prepare(`
      INSERT INTO runtime_telemetry_instances (instance_id, last_seen_at)
      VALUES ('worker-1', '2026-08-06T04:02:00.000Z'),
        ('expired', '2026-08-03T04:00:00.000Z')
    `).run();

    maintainRuntimeTelemetryHistory(database, now);

    const rows = database.prepare(`
      SELECT instance_id AS instanceId, resolution_seconds AS resolutionSeconds, metrics
      FROM runtime_telemetry_samples ORDER BY instance_id
    `).all() as Array<{ instanceId: string; resolutionSeconds: number; metrics: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instanceId: 'worker-1', resolutionSeconds: 300 });
    expect(JSON.parse(rows[0].metrics)).toMatchObject({
      memory: { intervalHighWater: { externalBytes: 900 } },
      process: { activeResourceCount: base.process.activeResourceCount + 12 },
      requests: { peakActive: 8 },
    });
    expect(database.prepare(`
      SELECT instance_id AS instanceId FROM runtime_telemetry_instances
    `).all()).toEqual([{ instanceId: 'worker-1' }]);
    database.close();
  });

  it('persists a terminal sample and restart reason on shutdown', async () => {
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('worker');
    await monitor.start();
    await monitor.stop('SIGTERM');

    expect(run.mock.calls.some((call) => call.includes('SIGTERM'))).toBe(true);
  });

  it('registers and removes web shutdown telemetry handlers', async () => {
    const sigtermListeners = process.listenerCount('SIGTERM');
    const sigintListeners = process.listenerCount('SIGINT');
    const { startRuntimeTelemetry, stopRuntimeTelemetry } =
      await import('@/lib/telemetry/runtime');

    await startRuntimeTelemetry('web');

    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners + 1);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners + 1);

    await stopRuntimeTelemetry('test_shutdown');

    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  });
});
