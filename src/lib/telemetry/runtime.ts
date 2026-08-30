import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { channel, type Channel } from 'node:diagnostics_channel';
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type PerformanceEntry,
} from 'node:perf_hooks';
import {
  getDatabaseTelemetry,
  sqlite,
  withoutDatabaseObservation,
} from '@/db';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import logger from '@/lib/logger';
import {
  getRuntimeLifecycleSnapshot,
  recordRuntimeMemoryDiagnostics,
  requestRuntimeRestart,
  type RuntimeMemoryDiagnostics,
} from '@/lib/runtime/lifecycle';
import { runtimeRelease } from '@/lib/runtime/release';
import type { DatabaseTelemetrySnapshot } from './database';
import {
  getRuntimeOperationSnapshot,
  type RuntimeOperationSnapshot,
} from './operations';

export type RuntimeRole = 'web' | 'worker';
export type MemoryPressureLevel = 'healthy' | 'warning' | 'critical' | 'unavailable';

export interface RuntimeMemoryValues {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface RuntimeMetrics {
  schemaVersion: 2;
  role: RuntimeRole;
  sampledAt: string;
  buildSha: string | null;
  runtimeMode: string;
  eventLoop: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    intervalDriftMs: number;
    sustainedLagSamples: number;
    degraded: boolean;
  };
  database?: DatabaseTelemetrySnapshot & {
    eventLoopCorrelation: {
      eventLoopP99Ms: number;
      intervalDriftMs: number;
      synchronousDatabaseTimeMs: number;
      operationCount: number;
    };
  };
  process: {
    pid: number;
    uptimeSeconds: number;
    cpuPercent: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    rssHighWaterBytes: number;
    rssP95Bytes: number;
    memorySampleCount: number;
    activeOperationCategories: string[];
    rssHighWaterOperationCategories: string[];
    nativeResidualBytes: number;
    activeResourceCount: number;
    activeResources: Record<string, number>;
  } & RuntimeMemoryValues;
  memory: {
    intervalHighWater: RuntimeMemoryValues;
    intervalFloor: RuntimeMemoryValues;
    postGcFloor: RuntimeMemoryValues | null;
    instanceHighWater: RuntimeMemoryValues;
  };
  garbageCollection: {
    count: number;
    durationMs: number;
    byKind: Record<string, { count: number; durationMs: number }>;
  };
  requests: {
    completed: number;
    requestsPerSecond: number;
    active: number;
    peakActive: number;
  };
  workload: RuntimeOperationSnapshot;
  host: {
    cpuCount: number;
    loadAverage: number[];
    totalMemoryBytes: number;
    freeMemoryBytes: number;
  };
  container: {
    detected: boolean;
    cpuUsageUsec: number | null;
    cpuThrottledUsec: number | null;
    cpuThrottleEvents: number | null;
    cpuQuotaCores: number | null;
    memoryCurrentBytes: number | null;
    memoryLimitBytes: number | null;
    memoryHeadroomBytes: number | null;
    memoryUtilizationPercent: number | null;
    memoryPressure: MemoryPressureLevel;
    memoryWarningPercent: number;
    memoryCriticalPercent: number;
    memoryEvents: {
      low: number;
      high: number;
      max: number;
      oom: number;
      oomKill: number;
    } | null;
    restartCount: number | null;
    restartCountSource: 'environment' | 'unavailable';
    unavailable: string[];
  };
  liveness?: {
    firstProbeAt: string | null;
    lastProbeAt: string | null;
    lastHandlerDurationMs: number | null;
    startupProbeMissed: boolean;
  };
}

export interface RuntimeTelemetryRecord {
  role: RuntimeRole;
  instanceId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  metrics: RuntimeMetrics;
}

export interface RuntimeTelemetrySample {
  id: number;
  role: RuntimeRole;
  instanceId: string;
  pid: number;
  sampledAt: string;
  resolutionSeconds: number;
  metrics: RuntimeMetrics;
}

export interface RuntimeTelemetryInstance {
  instanceId: string;
  role: RuntimeRole;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  stoppedAt: string | null;
  terminalReason: string | null;
  restartCount: number | null;
  buildSha: string | null;
  runtimeMode: string;
  highWaterMetrics: RuntimeMemoryValues;
  terminalMetrics: RuntimeMetrics | null;
}

interface RuntimeGlobalState {
  firstProbeAt: string | null;
  lastProbeAt: string | null;
  lastHandlerDurationMs: number | null;
  startupProbeMissed: boolean;
  monitor: RuntimeTelemetryMonitor | null;
  startPromise: Promise<RuntimeTelemetryMonitor> | null;
  shutdownHandlers: {
    SIGTERM?: () => void;
    SIGINT?: () => void;
  };
}

interface TelemetryDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  };
}

const GLOBAL_KEY = '__mc_runtime_telemetry__';
const runtimeGlobal = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: RuntimeGlobalState;
};
const globalState = runtimeGlobal[GLOBAL_KEY] ?? {
  firstProbeAt: null,
  lastProbeAt: null,
  lastHandlerDurationMs: null,
  startupProbeMissed: false,
  monitor: null,
  startPromise: null,
  shutdownHandlers: {},
};
runtimeGlobal[GLOBAL_KEY] = globalState;
globalState.shutdownHandlers ??= {};
globalState.startPromise ??= null;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.round(value / 1_000_000 * 100) / 100 : 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentage(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 100 ? parsed : fallback;
}

export function evaluateMemoryPressure(
  currentBytes: number | null,
  limitBytes: number | null,
  warningPercent: number,
  criticalPercent: number,
): {
  headroomBytes: number | null;
  utilizationPercent: number | null;
  pressure: MemoryPressureLevel;
} {
  if (
    currentBytes === null
    || limitBytes === null
    || currentBytes < 0
    || limitBytes <= 0
  ) {
    return {
      headroomBytes: null,
      utilizationPercent: null,
      pressure: 'unavailable',
    };
  }
  const utilizationPercent = Math.round((currentBytes / limitBytes) * 10_000) / 100;
  return {
    headroomBytes: Math.max(0, limitBytes - currentBytes),
    utilizationPercent,
    pressure: utilizationPercent >= criticalPercent
      ? 'critical'
      : utilizationPercent >= warningPercent
        ? 'warning'
        : 'healthy',
  };
}

function runtimeMode(): string {
  return process.env.MC_RUNTIME_MODE
    ?? process.env.MC_SYNC_EXECUTION_MODE
    ?? process.env.NODE_ENV
    ?? 'unknown';
}

function memoryValues(memory: NodeJS.MemoryUsage): RuntimeMemoryValues {
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function mergeMemoryMaximum(
  left: RuntimeMemoryValues,
  right: RuntimeMemoryValues,
): RuntimeMemoryValues {
  return {
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    heapTotalBytes: Math.max(left.heapTotalBytes, right.heapTotalBytes),
    externalBytes: Math.max(left.externalBytes, right.externalBytes),
    arrayBuffersBytes: Math.max(left.arrayBuffersBytes, right.arrayBuffersBytes),
  };
}

function mergeMemoryMinimum(
  left: RuntimeMemoryValues,
  right: RuntimeMemoryValues,
): RuntimeMemoryValues {
  return {
    rssBytes: Math.min(left.rssBytes, right.rssBytes),
    heapUsedBytes: Math.min(left.heapUsedBytes, right.heapUsedBytes),
    heapTotalBytes: Math.min(left.heapTotalBytes, right.heapTotalBytes),
    externalBytes: Math.min(left.externalBytes, right.externalBytes),
    arrayBuffersBytes: Math.min(left.arrayBuffersBytes, right.arrayBuffersBytes),
  };
}

function countActiveResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo()) {
    counts[resource] = (counts[resource] ?? 0) + 1;
  }
  return counts;
}

interface GarbageCollectionEntry extends PerformanceEntry {
  detail?: {
    kind?: number;
  };
}

function readNumber(path: string, unavailable: string[]): number | null {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    if (raw === 'max') return null;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
    unavailable.push(`${path}: invalid number`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : 'read failed';
    unavailable.push(`${path}: ${code}`);
  }
  return null;
}

function readKeyValueNumbers(
  filePath: string,
  unavailable: string[],
): Map<string, number> | null {
  try {
    const values = new Map<string, number>();
    for (const line of fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/)) {
      const [key, rawValue] = line.trim().split(/\s+/, 2);
      const value = Number(rawValue);
      if (!key || !rawValue || !Number.isFinite(value) || value < 0) {
        unavailable.push(`${filePath}: invalid entry`);
        continue;
      }
      values.set(key, value);
    }
    return values;
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : 'read failed';
    unavailable.push(`${filePath}: ${code}`);
    return null;
  }
}

function cgroupPath(): string {
  const configuredPath = process.env.MC_CGROUP_PATH?.trim();
  if (configuredPath) return configuredPath;
  const procRoot = process.env.MC_PROC_ROOT ?? '/proc';
  try {
    const unifiedEntry = fs.readFileSync(`${procRoot}/self/cgroup`, 'utf8')
      .split(/\r?\n/)
      .find((line) => line.startsWith('0::'));
    return unifiedEntry?.slice(3).trim() || '/';
  } catch {
    return '/';
  }
}

function cgroupRoot(): string {
  const mountRoot = process.env.MC_CGROUP_ROOT ?? '/sys/fs/cgroup';
  const relativePath = cgroupPath()
    .split(/[/\\]+/)
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join(path.sep);
  if (!relativePath) return mountRoot;
  const processRoot = path.join(mountRoot, relativePath);
  return fs.existsSync(processRoot) ? processRoot : mountRoot;
}

function readCgroupMetrics(
  warningPercent = percentage(process.env.MC_MEMORY_WARNING_PERCENT, 70),
  criticalPercent = percentage(process.env.MC_MEMORY_CRITICAL_PERCENT, 85),
): RuntimeMetrics['container'] {
  const root = cgroupRoot();
  const unavailable: string[] = [];
  const cpuStatPath = `${root}/cpu.stat`;
  const memoryCurrentPath = `${root}/memory.current`;
  const detected = fs.existsSync(cpuStatPath) || fs.existsSync(memoryCurrentPath);
  let cpuUsageUsec: number | null = null;
  let cpuThrottledUsec: number | null = null;
  let cpuThrottleEvents: number | null = null;

  if (fs.existsSync(cpuStatPath)) {
    try {
      const stats = new Map(
        fs.readFileSync(cpuStatPath, 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const [key, value] = line.trim().split(/\s+/, 2);
            return [key, Number(value)] as const;
          }),
      );
      cpuUsageUsec = stats.get('usage_usec') ?? null;
      cpuThrottledUsec = stats.get('throttled_usec') ?? null;
      cpuThrottleEvents = stats.get('nr_throttled') ?? null;
    } catch (error) {
      unavailable.push(`${cpuStatPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    unavailable.push(`${cpuStatPath}: unavailable`);
  }

  let cpuQuotaCores: number | null = null;
  const cpuMaxPath = `${root}/cpu.max`;
  try {
    const [quota, period] = fs.readFileSync(cpuMaxPath, 'utf8').trim().split(/\s+/, 2);
    if (quota !== 'max') {
      const quotaNumber = Number(quota);
      const periodNumber = Number(period);
      if (quotaNumber > 0 && periodNumber > 0) {
        cpuQuotaCores = Math.round(quotaNumber / periodNumber * 100) / 100;
      }
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : 'read failed';
    unavailable.push(`${cpuMaxPath}: ${code}`);
  }

  const memoryCurrentBytes = readNumber(memoryCurrentPath, unavailable);
  const memoryLimitBytes = readNumber(`${root}/memory.max`, unavailable);
  const memoryPressure = evaluateMemoryPressure(
    memoryCurrentBytes,
    memoryLimitBytes,
    warningPercent,
    criticalPercent,
  );
  const memoryEventValues = readKeyValueNumbers(
    `${root}/memory.events`,
    unavailable,
  );
  const restartCountValue = process.env.MC_CONTAINER_RESTART_COUNT?.trim();
  const configuredRestartCount = restartCountValue ? Number(restartCountValue) : Number.NaN;
  const restartCount = Number.isSafeInteger(configuredRestartCount)
    && configuredRestartCount >= 0
    ? configuredRestartCount
    : null;
  if (restartCount === null) {
    unavailable.push(
      restartCountValue
        ? 'restartCount: MC_CONTAINER_RESTART_COUNT is not a non-negative integer'
        : 'restartCount: container runtime metadata is not available in-process',
    );
  }
  return {
    detected,
    cpuUsageUsec,
    cpuThrottledUsec,
    cpuThrottleEvents,
    cpuQuotaCores,
    memoryCurrentBytes,
    memoryLimitBytes,
    memoryHeadroomBytes: memoryPressure.headroomBytes,
    memoryUtilizationPercent: memoryPressure.utilizationPercent,
    memoryPressure: memoryPressure.pressure,
    memoryWarningPercent: warningPercent,
    memoryCriticalPercent: criticalPercent,
    memoryEvents: memoryEventValues
      ? {
          low: memoryEventValues.get('low') ?? 0,
          high: memoryEventValues.get('high') ?? 0,
          max: memoryEventValues.get('max') ?? 0,
          oom: memoryEventValues.get('oom') ?? 0,
          oomKill: memoryEventValues.get('oom_kill') ?? 0,
        }
      : null,
    restartCount,
    restartCountSource: restartCount === null ? 'unavailable' : 'environment',
    unavailable,
  };
}

function compatibilityMemory(metrics: Partial<RuntimeMetrics>): RuntimeMemoryValues {
  const processMetrics = metrics.process;
  return {
    rssBytes: processMetrics?.rssBytes ?? 0,
    heapUsedBytes: processMetrics?.heapUsedBytes ?? 0,
    heapTotalBytes: processMetrics?.heapTotalBytes ?? 0,
    externalBytes: processMetrics?.externalBytes ?? 0,
    arrayBuffersBytes: processMetrics?.arrayBuffersBytes ?? 0,
  };
}

export function normalizeRuntimeMetrics(parsed: Partial<RuntimeMetrics>): RuntimeMetrics {
  const memory = compatibilityMemory(parsed);
  const database = parsed.database
    ? {
        ...parsed.database,
        operations: {
          ...parsed.database.operations,
          byAttribution: parsed.database.operations.byAttribution ?? {},
        },
        slowOperations: parsed.database.slowOperations.map((operation) => ({
          ...operation,
          attribution: operation.attribution ?? 'unattributed',
        })),
      }
    : undefined;
  const restartCount = parsed.container?.restartCount ?? null;
  const restartCountSource = parsed.container?.restartCountSource
    ?? (restartCount === null ? 'unavailable' : 'environment');
  const unavailable = [...(parsed.container?.unavailable ?? [])];
  if (
    restartCount === null
    && !unavailable.some((reason) => reason.startsWith('restartCount:'))
  ) {
    unavailable.push('restartCount: not recorded by this historical sample');
  }
  return {
    ...parsed,
    schemaVersion: 2,
    buildSha: parsed.buildSha ?? null,
    runtimeMode: parsed.runtimeMode ?? 'unknown',
    database,
    process: {
      pid: parsed.process?.pid ?? 0,
      uptimeSeconds: parsed.process?.uptimeSeconds ?? 0,
      cpuPercent: parsed.process?.cpuPercent ?? 0,
      rssHighWaterBytes: parsed.process?.rssHighWaterBytes ?? memory.rssBytes,
      rssP95Bytes: parsed.process?.rssP95Bytes ?? memory.rssBytes,
      memorySampleCount: parsed.process?.memorySampleCount ?? 0,
      activeOperationCategories: parsed.process?.activeOperationCategories ?? [],
      rssHighWaterOperationCategories:
        parsed.process?.rssHighWaterOperationCategories ?? [],
      nativeResidualBytes: parsed.process?.nativeResidualBytes ?? Math.max(
        0,
        memory.rssBytes - memory.heapTotalBytes - memory.externalBytes,
      ),
      activeResourceCount: parsed.process?.activeResourceCount ?? 0,
      activeResources: parsed.process?.activeResources ?? {},
      ...memory,
    },
    memory: {
      intervalHighWater: parsed.memory?.intervalHighWater ?? memory,
      intervalFloor: parsed.memory?.intervalFloor ?? memory,
      postGcFloor: parsed.memory?.postGcFloor ?? null,
      instanceHighWater: parsed.memory?.instanceHighWater ?? memory,
    },
    workload: parsed.workload ?? {
      active: [],
      activeExpensive: 0,
      queuedExpensive: 0,
    },
    garbageCollection: parsed.garbageCollection ?? {
      count: 0,
      durationMs: 0,
      byKind: {},
    },
    requests: parsed.requests ?? {
      completed: 0,
      requestsPerSecond: 0,
      active: 0,
      peakActive: 0,
    },
    container: {
      ...parsed.container,
      restartCount,
      restartCountSource,
      unavailable,
    },
  } as RuntimeMetrics;
}

export function deserializeRuntimeMetrics(serialized: string): RuntimeMetrics {
  return normalizeRuntimeMetrics(JSON.parse(serialized) as Partial<RuntimeMetrics>);
}

export function aggregateSamples(samples: RuntimeTelemetrySample[]): RuntimeMetrics {
  const latest = samples[samples.length - 1].metrics;
  return samples.reduce<RuntimeMetrics>((aggregate, sample) => ({
    ...aggregate,
    eventLoop: {
      ...aggregate.eventLoop,
      p50Ms: Math.max(aggregate.eventLoop.p50Ms, sample.metrics.eventLoop.p50Ms),
      p95Ms: Math.max(aggregate.eventLoop.p95Ms, sample.metrics.eventLoop.p95Ms),
      p99Ms: Math.max(aggregate.eventLoop.p99Ms, sample.metrics.eventLoop.p99Ms),
      maxMs: Math.max(aggregate.eventLoop.maxMs, sample.metrics.eventLoop.maxMs),
      intervalDriftMs: Math.max(
        aggregate.eventLoop.intervalDriftMs,
        sample.metrics.eventLoop.intervalDriftMs,
      ),
      sustainedLagSamples: Math.max(
        aggregate.eventLoop.sustainedLagSamples,
        sample.metrics.eventLoop.sustainedLagSamples,
      ),
      degraded: aggregate.eventLoop.degraded || sample.metrics.eventLoop.degraded,
    },
    process: {
      ...aggregate.process,
      rssHighWaterBytes: Math.max(
        aggregate.process.rssHighWaterBytes,
        sample.metrics.process.rssHighWaterBytes,
      ),
      rssP95Bytes: Math.max(
        aggregate.process.rssP95Bytes,
        sample.metrics.process.rssP95Bytes,
      ),
      memorySampleCount: Math.max(
        aggregate.process.memorySampleCount,
        sample.metrics.process.memorySampleCount,
      ),
      nativeResidualBytes: Math.max(
        aggregate.process.nativeResidualBytes,
        sample.metrics.process.nativeResidualBytes,
      ),
      activeResourceCount: Math.max(
        aggregate.process.activeResourceCount,
        sample.metrics.process.activeResourceCount,
      ),
      activeResources: Object.fromEntries(
        [...new Set([
          ...Object.keys(aggregate.process.activeResources),
          ...Object.keys(sample.metrics.process.activeResources),
        ])].map((resource) => [
          resource,
          Math.max(
            aggregate.process.activeResources[resource] ?? 0,
            sample.metrics.process.activeResources[resource] ?? 0,
          ),
        ]),
      ),
    },
    memory: {
      intervalHighWater: mergeMemoryMaximum(
        aggregate.memory.intervalHighWater,
        sample.metrics.memory.intervalHighWater,
      ),
      intervalFloor: mergeMemoryMinimum(
        aggregate.memory.intervalFloor,
        sample.metrics.memory.intervalFloor,
      ),
      postGcFloor: sample.metrics.memory.postGcFloor === null
        ? aggregate.memory.postGcFloor
        : aggregate.memory.postGcFloor === null
          ? sample.metrics.memory.postGcFloor
          : mergeMemoryMinimum(
              aggregate.memory.postGcFloor,
              sample.metrics.memory.postGcFloor,
            ),
      instanceHighWater: mergeMemoryMaximum(
        aggregate.memory.instanceHighWater,
        sample.metrics.memory.instanceHighWater,
      ),
    },
    workload: {
      active: [
        ...new Map(
          [...aggregate.workload.active, ...sample.metrics.workload.active]
            .map((operation) => [operation.id, operation]),
        ).values(),
      ].slice(0, 32),
      activeExpensive: Math.max(
        aggregate.workload.activeExpensive,
        sample.metrics.workload.activeExpensive,
      ),
      queuedExpensive: Math.max(
        aggregate.workload.queuedExpensive,
        sample.metrics.workload.queuedExpensive,
      ),
    },
    garbageCollection: {
      count: Math.max(
        aggregate.garbageCollection.count,
        sample.metrics.garbageCollection.count,
      ),
      durationMs: Math.max(
        aggregate.garbageCollection.durationMs,
        sample.metrics.garbageCollection.durationMs,
      ),
      byKind: Object.fromEntries(
        [...new Set([
          ...Object.keys(aggregate.garbageCollection.byKind),
          ...Object.keys(sample.metrics.garbageCollection.byKind),
        ])].map((kind) => {
          const left = aggregate.garbageCollection.byKind[kind];
          const right = sample.metrics.garbageCollection.byKind[kind];
          return [
            kind,
            {
              count: Math.max(left?.count ?? 0, right?.count ?? 0),
              durationMs: Math.max(left?.durationMs ?? 0, right?.durationMs ?? 0),
            },
          ];
        }),
      ),
    },
    requests: {
      completed: Math.max(
        aggregate.requests.completed,
        sample.metrics.requests.completed,
      ),
      requestsPerSecond: Math.max(
        aggregate.requests.requestsPerSecond,
        sample.metrics.requests.requestsPerSecond,
      ),
      active: Math.max(aggregate.requests.active, sample.metrics.requests.active),
      peakActive: Math.max(
        aggregate.requests.peakActive,
        sample.metrics.requests.peakActive,
      ),
    },
  }), latest);
}

export function maintainRuntimeTelemetryHistory(
  database: TelemetryDatabase,
  now = new Date(),
  options: {
    retentionHours?: number;
    rawHours?: number;
    downsampleSeconds?: number;
  } = {},
): void {
  const retentionHours = Math.max(72, options.retentionHours ?? 72);
  const rawHours = Math.min(retentionHours, Math.max(1, options.rawHours ?? 6));
  const downsampleSeconds = Math.max(60, options.downsampleSeconds ?? 300);
  const retentionCutoff = new Date(now.getTime() - retentionHours * 60 * 60_000).toISOString();
  const rawCutoff = new Date(now.getTime() - rawHours * 60 * 60_000).toISOString();
  const rows = database.prepare(`
    SELECT id, role, instance_id AS instanceId, pid, sampled_at AS sampledAt,
      resolution_seconds AS resolutionSeconds, metrics
    FROM runtime_telemetry_samples
    WHERE sampled_at >= ? AND sampled_at < ? AND resolution_seconds < ?
    ORDER BY instance_id, sampled_at
  `).all(retentionCutoff, rawCutoff, downsampleSeconds) as Array<
    Omit<RuntimeTelemetrySample, 'metrics'> & { metrics: string }
  >;
  const buckets = new Map<string, RuntimeTelemetrySample[]>();
  for (const row of rows) {
    const bucketTime = Math.floor(
      new Date(row.sampledAt).getTime() / (downsampleSeconds * 1_000),
    ) * downsampleSeconds * 1_000;
    const key = `${row.instanceId}:${bucketTime}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push({ ...row, metrics: deserializeRuntimeMetrics(row.metrics) });
    buckets.set(key, bucket);
  }

  const insert = database.prepare(`
    INSERT INTO runtime_telemetry_samples (
      instance_id, role, pid, sampled_at, resolution_seconds, metrics
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id, sampled_at, resolution_seconds) DO UPDATE SET
      metrics = excluded.metrics
  `);
  for (const samples of buckets.values()) {
    const first = samples[0];
    const bucketTime = Math.floor(
      new Date(first.sampledAt).getTime() / (downsampleSeconds * 1_000),
    ) * downsampleSeconds * 1_000;
    insert.run(
      first.instanceId,
      first.role,
      first.pid,
      new Date(bucketTime).toISOString(),
      downsampleSeconds,
      JSON.stringify(aggregateSamples(samples)),
    );
  }
  database.prepare(`
    DELETE FROM runtime_telemetry_samples
    WHERE sampled_at < ? OR (sampled_at < ? AND resolution_seconds < ?)
  `).run(retentionCutoff, rawCutoff, downsampleSeconds);
  database.prepare(`
    DELETE FROM runtime_telemetry_instances
    WHERE last_seen_at < ?
  `).run(retentionCutoff);
}

export class RuntimeTelemetryMonitor {
  readonly role: RuntimeRole;
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly intervalMs: number;
  private readonly highWaterIntervalMs: number;
  private readonly lagThresholdMs: number;
  private readonly lagSamplesForDegraded: number;
  private readonly memoryWarningPercent: number;
  private readonly memoryCriticalPercent: number;
  private readonly memoryCriticalSamples: number;
  private readonly maxMemorySamples: number;
  private readonly onCriticalMemory: (diagnostics: RuntimeMemoryDiagnostics) => void;
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private timer: ReturnType<typeof setInterval> | null = null;
  private highWaterTimer: ReturnType<typeof setInterval> | null = null;
  private startupProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private previousCpu = process.cpuUsage();
  private previousSampleAt = performance.now();
  private expectedSampleAt = this.previousSampleAt;
  private sustainedLagSamples = 0;
  private lastDegraded = false;
  private lastDatabaseSeverity: DatabaseTelemetrySnapshot['severity'] = 'healthy';
  private lastMemoryPressure: MemoryPressureLevel = 'unavailable';
  private consecutiveCriticalMemorySamples = 0;
  private memoryRestartRequested = false;
  private rssHighWaterBytes = 0;
  private rssHighWaterOperationCategories: string[] = [];
  private readonly rssSamples: number[] = [];
  private snapshot: RuntimeMetrics | null = null;
  private persistenceChain: Promise<void> = Promise.resolve();
  private intervalHighWater = memoryValues(process.memoryUsage());
  private intervalFloor = this.intervalHighWater;
  private instanceHighWater = this.intervalHighWater;
  private postGcFloor: RuntimeMemoryValues | null = null;
  private lastMaintenanceAt = Date.now();
  private readonly gcByKind = new Map<number, { count: number; durationMs: number }>();
  private gcCount = 0;
  private gcDurationMs = 0;
  private completedRequests = 0;
  private activeRequests = 0;
  private peakActiveRequests = 0;
  private readonly requestStartChannel: Channel;
  private readonly gcObserver: PerformanceObserver;
  private readonly onRequestStart = (message: unknown) => {
    if (
      !message
      || typeof message !== 'object'
      || !('response' in message)
      || !message.response
      || typeof message.response !== 'object'
      || !('once' in message.response)
      || typeof message.response.once !== 'function'
      || !('off' in message.response)
      || typeof message.response.off !== 'function'
    ) {
      return;
    }
    const response = message.response as {
      once(event: string, listener: () => void): void;
      off(event: string, listener: () => void): void;
    };
    this.activeRequests++;
    this.peakActiveRequests = Math.max(this.peakActiveRequests, this.activeRequests);
    let settled = false;
    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      response.off('finish', onFinish);
      response.off('close', onClose);
      if (completed) this.completedRequests++;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
    const onFinish = () => settle(true);
    const onClose = () => settle(false);
    response.once('finish', onFinish);
    response.once('close', onClose);
  };

  constructor(
    role: RuntimeRole,
    options: {
      onCriticalMemory?: (diagnostics: RuntimeMemoryDiagnostics) => void;
    } = {},
  ) {
    this.role = role;
    this.intervalMs = positiveInteger(process.env.MC_TELEMETRY_INTERVAL_MS, 10_000);
    this.highWaterIntervalMs = positiveInteger(
      process.env.MC_TELEMETRY_HIGH_WATER_INTERVAL_MS,
      250,
    );
    this.lagThresholdMs = positiveInteger(process.env.MC_EVENT_LOOP_LAG_THRESHOLD_MS, 200);
    this.lagSamplesForDegraded = positiveInteger(
      process.env.MC_EVENT_LOOP_LAG_SUSTAINED_SAMPLES,
      3,
    );
    this.memoryWarningPercent = Math.min(
      98,
      percentage(process.env.MC_MEMORY_WARNING_PERCENT, 70),
    );
    const configuredCriticalPercent = percentage(
      process.env.MC_MEMORY_CRITICAL_PERCENT,
      85,
    );
    this.memoryCriticalPercent = configuredCriticalPercent > this.memoryWarningPercent
      ? configuredCriticalPercent
      : Math.min(99, this.memoryWarningPercent + 10);
    this.memoryCriticalSamples = positiveInteger(
      process.env.MC_MEMORY_CRITICAL_SAMPLES,
      3,
    );
    this.maxMemorySamples = Math.min(
      10_000,
      Math.max(1, Math.ceil(24 * 60 * 60 * 1_000 / this.intervalMs)),
    );
    this.onCriticalMemory = options.onCriticalMemory
      ?? ((diagnostics) => requestRuntimeRestart('memory-critical', diagnostics));
    this.requestStartChannel = channel('http.server.request.start');
    this.gcObserver = new PerformanceObserver((list) => {
      const memory = memoryValues(process.memoryUsage());
      this.postGcFloor = this.postGcFloor === null
        ? memory
        : mergeMemoryMinimum(this.postGcFloor, memory);
      for (const entry of list.getEntries() as GarbageCollectionEntry[]) {
        const kind = entry.detail?.kind ?? 0;
        const current = this.gcByKind.get(kind) ?? { count: 0, durationMs: 0 };
        current.count++;
        current.durationMs += entry.duration;
        this.gcByKind.set(kind, current);
        this.gcCount++;
        this.gcDurationMs += entry.duration;
      }
    });
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.registerInstance();
    await this.maintainHistory();
    this.histogram.enable();
    this.gcObserver.observe({ entryTypes: ['gc'] });
    this.requestStartChannel.subscribe(this.onRequestStart);
    this.expectedSampleAt = performance.now() + this.intervalMs;
    this.timer = setInterval(() => {
      void this.sampleAndPersist();
    }, this.intervalMs);
    this.timer.unref();
    this.highWaterTimer = setInterval(
      () => this.observeMemoryUsage(),
      this.highWaterIntervalMs,
    );
    this.highWaterTimer.unref();
    await this.sampleAndPersist();

    if (this.role === 'web') {
      const deadlineMs = positiveInteger(
        process.env.MC_HEALTHCHECK_START_DEADLINE_MS,
        60_000,
      );
      this.startupProbeTimer = setTimeout(() => {
        if (!globalState.firstProbeAt) {
          globalState.startupProbeMissed = true;
          logger.error(
            { deadlineMs },
            'No liveness health-check request observed before startup deadline',
          );
        }
      }, deadlineMs);
      this.startupProbeTimer.unref();
    }
  }

  async stop(reason = 'graceful_shutdown'): Promise<void> {
    const wasStarted = this.timer !== null;
    if (this.timer) clearInterval(this.timer);
    if (this.highWaterTimer) clearInterval(this.highWaterTimer);
    if (this.startupProbeTimer) clearTimeout(this.startupProbeTimer);
    this.timer = null;
    this.highWaterTimer = null;
    this.startupProbeTimer = null;
    try {
      if (wasStarted) {
        const terminalMetrics = await this.sampleAndPersist();
        await this.recordStop(terminalMetrics, reason);
      }
    } finally {
      this.histogram.disable();
      this.gcObserver.disconnect();
      this.requestStartChannel.unsubscribe(this.onRequestStart);
    }
  }

  getSnapshot(): RuntimeMetrics | null {
    return this.snapshot;
  }

  observeMemoryUsage(memory = process.memoryUsage()): void {
    const current = memoryValues(memory);
    this.intervalHighWater = mergeMemoryMaximum(this.intervalHighWater, current);
    this.intervalFloor = mergeMemoryMinimum(this.intervalFloor, current);
    this.instanceHighWater = mergeMemoryMaximum(this.instanceHighWater, current);
  }

  /**
   * Computes a fresh metrics snapshot (pure, synchronous, in-process — no
   * database access) and asynchronously persists it, swallowing/logging any
   * persistence failure exactly as the previous synchronous
   * `sample()`-calls-`persist()` design did. Split out so callers
   * (the heartbeat timer, `start()`, `stop()`) can choose whether to await
   * the persistence (`start()`/`stop()` do; the heartbeat timer fires and
   * forgets). Public so callers (and tests) that need a deterministic
   * "compute and persist" round-trip — rather than the pure, synchronous
   * `sample()` — can await it directly.
   */
  sampleAndPersist(now?: number): Promise<RuntimeMetrics> {
    const pending = this.persistenceChain.then(async () => {
      const metrics = this.sample(now ?? performance.now());
      try {
        await this.persist(metrics);
      } catch (error) {
        logger.error(
          { err: error, role: this.role },
          'Runtime telemetry persistence failed',
        );
      }
      return metrics;
    });
    this.persistenceChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  sample(now = performance.now()): RuntimeMetrics {
    const elapsedMs = Math.max(1, now - this.previousSampleAt);
    const intervalDriftMs = Math.max(0, now - this.expectedSampleAt);
    const cpu = process.cpuUsage(this.previousCpu);
    const cpuPercent = Math.round(
      ((cpu.user + cpu.system) / (elapsedMs * 1_000)) * 100 * 100,
    ) / 100;
    const p99Ms = nanosecondsToMilliseconds(this.histogram.percentile(99));
    const maxMs = nanosecondsToMilliseconds(this.histogram.max);
    if (Math.max(p99Ms, intervalDriftMs) >= this.lagThresholdMs) {
      this.sustainedLagSamples++;
    } else {
      this.sustainedLagSamples = 0;
    }
    const degraded = this.sustainedLagSamples >= this.lagSamplesForDegraded;
    const rawMemory = process.memoryUsage();
    this.observeMemoryUsage(rawMemory);
    const currentMemory = memoryValues(rawMemory);
    const activeOperationCategories = Object.keys(
      getRuntimeLifecycleSnapshot().activeOperations,
    );
    if (rawMemory.rss > this.rssHighWaterBytes) {
      this.rssHighWaterBytes = rawMemory.rss;
      this.rssHighWaterOperationCategories = activeOperationCategories;
    }
    this.rssSamples.push(rawMemory.rss);
    if (this.rssSamples.length > this.maxMemorySamples) this.rssSamples.shift();
    const sortedRssSamples = [...this.rssSamples].sort((left, right) => left - right);
    const rssP95Index = Math.max(0, Math.ceil(sortedRssSamples.length * 0.95) - 1);
    const rssP95Bytes = sortedRssSamples[rssP95Index] ?? rawMemory.rss;
    const activeResources = countActiveResources();
    const garbageCollection = {
      count: this.gcCount,
      durationMs: roundMilliseconds(this.gcDurationMs),
      byKind: Object.fromEntries(
        [...this.gcByKind.entries()].map(([kind, value]) => [
          String(kind),
          {
            count: value.count,
            durationMs: roundMilliseconds(value.durationMs),
          },
        ]),
      ),
    };
    const requests = {
      completed: this.completedRequests,
      requestsPerSecond: roundMilliseconds(this.completedRequests / (elapsedMs / 1_000)),
      active: this.activeRequests,
      peakActive: this.peakActiveRequests,
    };
    const database = resolveDatabaseBackend() === 'sqlite'
      ? getDatabaseTelemetry()
      : undefined;
    const eventLoopCorrelation = database
      ? {
          eventLoopP99Ms: p99Ms,
          intervalDriftMs: roundMilliseconds(intervalDriftMs),
          synchronousDatabaseTimeMs: database.sampleInterval.synchronousDatabaseTimeMs,
          operationCount: database.sampleInterval.operationCount,
        }
      : undefined;
    const container = readCgroupMetrics(
      this.memoryWarningPercent,
      this.memoryCriticalPercent,
    );
    const memoryDiagnostics: RuntimeMemoryDiagnostics = {
      sampledAt: new Date().toISOString(),
      rssBytes: rawMemory.rss,
      rssHighWaterBytes: this.rssHighWaterBytes,
      rssP95Bytes,
      externalBytes: rawMemory.external,
      arrayBuffersBytes: rawMemory.arrayBuffers,
      containerCurrentBytes: container.memoryCurrentBytes,
      containerLimitBytes: container.memoryLimitBytes,
      containerOomEvents: container.memoryEvents?.oom ?? null,
      containerOomKillEvents: container.memoryEvents?.oomKill ?? null,
      pressure: container.memoryPressure,
    };
    recordRuntimeMemoryDiagnostics(memoryDiagnostics);
    const metrics: RuntimeMetrics = {
      schemaVersion: 2,
      role: this.role,
      sampledAt: memoryDiagnostics.sampledAt,
      buildSha: runtimeRelease,
      runtimeMode: runtimeMode(),
      eventLoop: {
        p50Ms: nanosecondsToMilliseconds(this.histogram.percentile(50)),
        p95Ms: nanosecondsToMilliseconds(this.histogram.percentile(95)),
        p99Ms,
        maxMs,
        intervalDriftMs: roundMilliseconds(intervalDriftMs),
        sustainedLagSamples: this.sustainedLagSamples,
        degraded,
      },
      ...(database && eventLoopCorrelation
        ? {
            database: {
              ...database,
              eventLoopCorrelation,
            },
          }
        : {}),
      process: {
        pid: process.pid,
        uptimeSeconds: process.uptime(),
        cpuPercent,
        ...currentMemory,
        rssHighWaterBytes: this.rssHighWaterBytes,
        rssP95Bytes,
        memorySampleCount: this.rssSamples.length,
        activeOperationCategories,
        rssHighWaterOperationCategories: this.rssHighWaterOperationCategories,
        nativeResidualBytes: Math.max(
          0,
          rawMemory.rss - rawMemory.heapTotal - rawMemory.external,
        ),
        activeResourceCount: Object.values(activeResources)
          .reduce((sum, count) => sum + count, 0),
        activeResources,
      },
      memory: {
        intervalHighWater: this.intervalHighWater,
        intervalFloor: this.intervalFloor,
        postGcFloor: this.postGcFloor,
        instanceHighWater: this.instanceHighWater,
      },
      workload: getRuntimeOperationSnapshot(),
      garbageCollection,
      requests,
      host: {
        cpuCount: os.cpus().length,
        loadAverage: os.loadavg(),
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
      },
      container,
      ...(this.role === 'web'
        ? {
            liveness: {
              firstProbeAt: globalState.firstProbeAt,
              lastProbeAt: globalState.lastProbeAt,
              lastHandlerDurationMs: globalState.lastHandlerDurationMs,
              startupProbeMissed: globalState.startupProbeMissed,
            },
          }
        : {}),
    };

    this.snapshot = metrics;
    this.previousCpu = process.cpuUsage();
    this.previousSampleAt = now;
    this.expectedSampleAt = now + this.intervalMs;
    this.intervalHighWater = currentMemory;
    this.intervalFloor = currentMemory;
    this.postGcFloor = null;
    this.histogram.reset();
    this.gcByKind.clear();
    this.gcCount = 0;
    this.gcDurationMs = 0;
    this.completedRequests = 0;
    this.peakActiveRequests = this.activeRequests;

    if (degraded !== this.lastDegraded) {
      const details = {
        role: this.role,
        p99Ms,
        maxMs,
        intervalDriftMs,
        sustainedLagSamples: this.sustainedLagSamples,
        thresholdMs: this.lagThresholdMs,
      };
      if (degraded) {
        logger.error(details, 'Sustained event-loop lag detected');
      } else {
        logger.info(details, 'Event-loop lag recovered');
      }
      this.lastDegraded = degraded;
    }
    if (database && eventLoopCorrelation && database.severity !== this.lastDatabaseSeverity) {
      const details = {
        role: this.role,
        severity: database.severity,
        reasons: database.reasons,
        contention: database.contention,
        wal: database.wal,
        eventLoopCorrelation,
      };
      if (database.severity === 'critical') {
        logger.error(details, 'Critical SQLite degradation detected');
      } else if (database.severity === 'degraded') {
        logger.warn(details, 'SQLite degradation detected');
      } else {
        logger.info(details, 'SQLite health recovered');
      }
      this.lastDatabaseSeverity = database.severity;
    }
    if (container.memoryPressure !== this.lastMemoryPressure) {
      const details = {
        role: this.role,
        release: runtimeRelease,
        memory: memoryDiagnostics,
        warningPercent: this.memoryWarningPercent,
        criticalPercent: this.memoryCriticalPercent,
      };
      if (container.memoryPressure === 'critical') {
        logger.error(details, 'Critical container memory pressure detected');
      } else if (container.memoryPressure === 'warning') {
        logger.warn(details, 'Container memory pressure warning');
      } else if (this.lastMemoryPressure === 'warning' || this.lastMemoryPressure === 'critical') {
        logger.info(details, 'Container memory pressure recovered');
      }
      this.lastMemoryPressure = container.memoryPressure;
    }
    this.consecutiveCriticalMemorySamples = container.memoryPressure === 'critical'
      ? this.consecutiveCriticalMemorySamples + 1
      : 0;
    if (
      this.role === 'web'
      && !this.memoryRestartRequested
      && this.consecutiveCriticalMemorySamples >= this.memoryCriticalSamples
    ) {
      this.memoryRestartRequested = true;
      this.onCriticalMemory(memoryDiagnostics);
    }
    return metrics;
  }

  private async registerInstance(): Promise<void> {
    if (resolveDatabaseBackend() === 'postgres') {
      const [{ getPostgresPersistenceBackend }, { registerPostgresRuntimeInstance }] = await Promise.all([
        import('@/db/runtime'),
        import('@/db/postgres/telemetry-runtime'),
      ]);
      await registerPostgresRuntimeInstance(
        getPostgresPersistenceBackend().context.pool,
        {
          instanceId: this.instanceId,
          role: this.role,
          pid: process.pid,
          startedAt: this.startedAt,
          restartCount: readCgroupMetrics().restartCount,
          buildSha: runtimeRelease,
          runtimeMode: runtimeMode(),
          highWaterMetrics: this.instanceHighWater,
          restartReason: process.env.MC_PREVIOUS_RESTART_REASON ?? 'instance_replaced',
        },
      );
      return;
    }
    withoutDatabaseObservation(() => {
      const restartReason = process.env.MC_PREVIOUS_RESTART_REASON ?? 'instance_replaced';
      sqlite.prepare(`
        UPDATE runtime_telemetry_instances
        SET stopped_at = ?, terminal_reason = COALESCE(terminal_reason, ?)
        WHERE role = ? AND stopped_at IS NULL AND instance_id <> ?
      `).run(this.startedAt, restartReason, this.role, this.instanceId);
      sqlite.prepare(`
        INSERT INTO runtime_telemetry_instances (
          instance_id, role, pid, started_at, last_seen_at, stopped_at,
          terminal_reason, restart_count, build_sha, runtime_mode, high_water_metrics
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO NOTHING
      `).run(
        this.instanceId,
        this.role,
        process.pid,
        this.startedAt,
        this.startedAt,
        readCgroupMetrics().restartCount,
        runtimeRelease,
        runtimeMode(),
        JSON.stringify(this.instanceHighWater),
      );
    });
  }

  private async maintainHistory(): Promise<void> {
    if (resolveDatabaseBackend() === 'postgres') {
      const [{ getPostgresPersistenceBackend }, { maintainPostgresRuntimeTelemetryHistory }] = await Promise.all([
        import('@/db/runtime'),
        import('@/db/postgres/telemetry-runtime'),
      ]);
      await maintainPostgresRuntimeTelemetryHistory(
        getPostgresPersistenceBackend().context.pool,
      );
      return;
    }
    withoutDatabaseObservation(() => maintainRuntimeTelemetryHistory(sqlite));
  }

  private async recordStop(terminalMetrics: RuntimeMetrics, reason: string): Promise<void> {
    if (resolveDatabaseBackend() === 'postgres') {
      const [{ getPostgresPersistenceBackend }, { recordPostgresRuntimeTelemetryStop }] = await Promise.all([
        import('@/db/runtime'),
        import('@/db/postgres/telemetry-runtime'),
      ]);
      await recordPostgresRuntimeTelemetryStop(
        getPostgresPersistenceBackend().context.pool,
        { instanceId: this.instanceId, reason, terminalMetrics },
      );
      return;
    }
    withoutDatabaseObservation(() => {
      sqlite.prepare(`
        UPDATE runtime_telemetry_instances
        SET stopped_at = ?, last_seen_at = ?, terminal_reason = ?, terminal_metrics = ?
        WHERE instance_id = ?
      `).run(
        terminalMetrics.sampledAt,
        terminalMetrics.sampledAt,
        reason,
        JSON.stringify(terminalMetrics),
        this.instanceId,
      );
    });
  }

  private async persist(metrics: RuntimeMetrics): Promise<void> {
    if (resolveDatabaseBackend() === 'postgres') {
      const [{ getPostgresPersistenceBackend }, { persistPostgresRuntimeTelemetry }] = await Promise.all([
        import('@/db/runtime'),
        import('@/db/postgres/telemetry-runtime'),
      ]);
      const pool = getPostgresPersistenceBackend().context.pool;
      await persistPostgresRuntimeTelemetry(pool, {
        role: this.role,
        instanceId: this.instanceId,
        pid: process.pid,
        startedAt: this.startedAt,
        metrics,
        resolutionSeconds: Math.max(1, Math.round(this.intervalMs / 1_000)),
        highWaterMetrics: this.instanceHighWater,
      });
      const maintenanceIntervalMs = positiveInteger(
        process.env.MC_TELEMETRY_MAINTENANCE_INTERVAL_MS,
        60 * 60_000,
      );
      if (Date.now() - this.lastMaintenanceAt >= maintenanceIntervalMs) {
        await this.maintainHistory();
        this.lastMaintenanceAt = Date.now();
      }
      return;
    }
    withoutDatabaseObservation(() => {
      const serialized = JSON.stringify(metrics);
      sqlite.prepare(`
        INSERT INTO runtime_telemetry (
          role, instance_id, pid, started_at, heartbeat_at, metrics
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(role) DO UPDATE SET
          instance_id = excluded.instance_id,
          pid = excluded.pid,
          started_at = excluded.started_at,
          heartbeat_at = excluded.heartbeat_at,
          metrics = excluded.metrics
      `).run(
        this.role,
        this.instanceId,
        process.pid,
        this.startedAt,
        metrics.sampledAt,
        serialized,
      );
      sqlite.prepare(`
        INSERT INTO runtime_telemetry_samples (
          instance_id, role, pid, sampled_at, resolution_seconds, metrics
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, sampled_at, resolution_seconds) DO UPDATE SET
          metrics = excluded.metrics
      `).run(
        this.instanceId,
        this.role,
        process.pid,
        metrics.sampledAt,
        Math.max(1, Math.round(this.intervalMs / 1_000)),
        serialized,
      );
      sqlite.prepare(`
        UPDATE runtime_telemetry_instances
        SET last_seen_at = ?, restart_count = ?, high_water_metrics = ?
        WHERE instance_id = ?
      `).run(
        metrics.sampledAt,
        metrics.container.restartCount,
        JSON.stringify(this.instanceHighWater),
        this.instanceId,
      );
      const maintenanceIntervalMs = positiveInteger(
        process.env.MC_TELEMETRY_MAINTENANCE_INTERVAL_MS,
        60 * 60_000,
      );
      if (Date.now() - this.lastMaintenanceAt >= maintenanceIntervalMs) {
        maintainRuntimeTelemetryHistory(sqlite);
        this.lastMaintenanceAt = Date.now();
      }
    });
  }
}

export async function startRuntimeTelemetry(role: RuntimeRole): Promise<RuntimeTelemetryMonitor> {
  if (globalState.monitor) return globalState.monitor;
  if (globalState.startPromise) return globalState.startPromise;
  const monitor = new RuntimeTelemetryMonitor(role);
  const startPromise = (async () => {
    await monitor.start();
    globalState.monitor = monitor;
    if (role === 'web') {
      const onSigterm = () => { void stopRuntimeTelemetry('SIGTERM'); };
      const onSigint = () => { void stopRuntimeTelemetry('SIGINT'); };
      globalState.shutdownHandlers = {
        SIGTERM: onSigterm,
        SIGINT: onSigint,
      };
      process.once('SIGTERM', onSigterm);
      process.once('SIGINT', onSigint);
    }
    return monitor;
  })();
  globalState.startPromise = startPromise;
  try {
    return await startPromise;
  } finally {
    if (globalState.startPromise === startPromise) {
      globalState.startPromise = null;
    }
  }
}

export async function stopRuntimeTelemetry(reason?: string): Promise<void> {
  await globalState.startPromise;
  const { SIGTERM: onSigterm, SIGINT: onSigint } = globalState.shutdownHandlers;
  if (onSigterm) process.removeListener('SIGTERM', onSigterm);
  if (onSigint) process.removeListener('SIGINT', onSigint);
  globalState.shutdownHandlers = {};
  const monitor = globalState.monitor;
  globalState.monitor = null;
  await monitor?.stop(reason);
}

export function recordLivenessProbe(durationMs: number): void {
  const now = new Date().toISOString();
  globalState.firstProbeAt ??= now;
  globalState.lastProbeAt = now;
  globalState.lastHandlerDurationMs = roundMilliseconds(durationMs);
}

export async function getRuntimeTelemetry(): Promise<RuntimeTelemetryRecord[]> {
  if (resolveDatabaseBackend() === 'postgres') {
    const [{ getPostgresPersistenceBackend }, { getPostgresRuntimeTelemetry }] = await Promise.all([
      import('@/db/runtime'),
      import('@/db/postgres/telemetry-runtime'),
    ]);
    return getPostgresRuntimeTelemetry(getPostgresPersistenceBackend().context.pool);
  }
  const rows = withoutDatabaseObservation(() => sqlite.prepare(`
      SELECT role, instance_id AS instanceId, pid, started_at AS startedAt,
        heartbeat_at AS heartbeatAt, metrics
      FROM runtime_telemetry
      ORDER BY role
    `).all()) as Array<Omit<RuntimeTelemetryRecord, 'metrics'> & { metrics: string }>;
  return rows.map((row) => ({
    ...row,
    metrics: deserializeRuntimeMetrics(row.metrics),
  }));
}

export function getRuntimeTelemetryHistory(
  hours?: number,
  role?: RuntimeRole,
): Promise<RuntimeTelemetrySample[]>;
export function getRuntimeTelemetryHistory(options?: {
  role?: RuntimeRole;
  since?: string;
  limit?: number;
}): Promise<RuntimeTelemetrySample[]>;
export async function getRuntimeTelemetryHistory(
  hoursOrOptions: number | {
    role?: RuntimeRole;
    since?: string;
    limit?: number;
  } = 72,
  role?: RuntimeRole,
): Promise<RuntimeTelemetrySample[]> {
  if (typeof hoursOrOptions === 'object') {
    const since = hoursOrOptions.since
      ?? new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const limit = Math.min(10_000, Math.max(1, hoursOrOptions.limit ?? 1_000));

    if (resolveDatabaseBackend() === 'postgres') {
      const [{ getPostgresPersistenceBackend }, { getPostgresRuntimeTelemetryHistory }] = await Promise.all([
        import('@/db/runtime'),
        import('@/db/postgres/telemetry-runtime'),
      ]);
      return getPostgresRuntimeTelemetryHistory(getPostgresPersistenceBackend().context.pool, {
        role: hoursOrOptions.role,
        since,
        limit,
      });
    }

    const roleFilter = hoursOrOptions.role ? 'AND role = ?' : '';
    const query = sqlite.prepare(`
      SELECT id, role, instanceId, pid, sampledAt, resolutionSeconds, metrics
      FROM (
        SELECT id, role, instance_id AS instanceId, pid,
          sampled_at AS sampledAt, resolution_seconds AS resolutionSeconds, metrics
        FROM runtime_telemetry_samples
        WHERE sampled_at >= ?
          ${roleFilter}
        ORDER BY sampled_at DESC
        LIMIT ?
      )
      ORDER BY sampledAt
    `);
    const rows = withoutDatabaseObservation(() => (
      hoursOrOptions.role
        ? query.all(since, hoursOrOptions.role, limit)
        : query.all(since, limit)
    )) as Array<Omit<RuntimeTelemetrySample, 'metrics'> & { metrics: string }>;
    return rows.map((row) => ({
      ...row,
      metrics: deserializeRuntimeMetrics(row.metrics),
    }));
  }

  const boundedHours = Math.min(72, Math.max(1, hoursOrOptions));
  const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();

  if (resolveDatabaseBackend() === 'postgres') {
    const [{ getPostgresPersistenceBackend }, { getPostgresRuntimeTelemetryHistory }] = await Promise.all([
      import('@/db/runtime'),
      import('@/db/postgres/telemetry-runtime'),
    ]);
    return getPostgresRuntimeTelemetryHistory(getPostgresPersistenceBackend().context.pool, {
      role,
      since: cutoff,
      limit: 10_000,
    });
  }

  const rows = withoutDatabaseObservation(() => sqlite.prepare(`
      SELECT id, role, instance_id AS instanceId, pid, sampled_at AS sampledAt,
        resolution_seconds AS resolutionSeconds, metrics
      FROM runtime_telemetry_samples
      WHERE sampled_at >= ? AND (? IS NULL OR role = ?)
      ORDER BY sampled_at
    `).all(cutoff, role ?? null, role ?? null)) as Array<
    Omit<RuntimeTelemetrySample, 'metrics'> & { metrics: string }
  >;
  return rows.map((row) => ({
    ...row,
    metrics: deserializeRuntimeMetrics(row.metrics),
  }));
}

export async function getRuntimeTelemetryAlertHistory(
  hours = 1,
): Promise<RuntimeTelemetrySample[]> {
  if (resolveDatabaseBackend() === 'postgres') {
    const [{ getPostgresPersistenceBackend }, { getPostgresRuntimeTelemetryAlertHistory }] = await Promise.all([
      import('@/db/runtime'),
      import('@/db/postgres/telemetry-runtime'),
    ]);
    return getPostgresRuntimeTelemetryAlertHistory(getPostgresPersistenceBackend().context.pool, hours);
  }
  const boundedHours = Math.min(72, Math.max(1, hours));
  const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
  const rows = withoutDatabaseObservation(() => sqlite.prepare(`
      WITH gc_samples AS (
        SELECT
          id,
          role,
          instance_id AS instanceId,
          pid,
          sampled_at AS sampledAt,
          resolution_seconds AS resolutionSeconds,
          metrics,
          ROW_NUMBER() OVER (
            PARTITION BY instance_id ORDER BY sampled_at ASC
          ) AS oldestRank,
          ROW_NUMBER() OVER (
            PARTITION BY instance_id ORDER BY sampled_at DESC
          ) AS newestRank
        FROM runtime_telemetry_samples
        WHERE sampled_at >= ?
          AND json_extract(metrics, '$.memory.postGcFloor.heapUsedBytes') IS NOT NULL
      )
      SELECT id, role, instanceId, pid, sampledAt, resolutionSeconds, metrics
      FROM gc_samples
      WHERE oldestRank = 1 OR newestRank = 1
      ORDER BY sampledAt
    `).all(cutoff)) as Array<
    Omit<RuntimeTelemetrySample, 'metrics'> & { metrics: string }
  >;
  return rows.map((row) => ({
    ...row,
    metrics: deserializeRuntimeMetrics(row.metrics),
  }));
}

export async function getRuntimeTelemetryInstances(hours = 72): Promise<RuntimeTelemetryInstance[]> {
  if (resolveDatabaseBackend() === 'postgres') {
    const [{ getPostgresPersistenceBackend }, { getPostgresRuntimeTelemetryInstances }] = await Promise.all([
      import('@/db/runtime'),
      import('@/db/postgres/telemetry-runtime'),
    ]);
    return getPostgresRuntimeTelemetryInstances(getPostgresPersistenceBackend().context.pool, hours);
  }
  const boundedHours = Math.min(72, Math.max(1, hours));
  const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
  const rows = withoutDatabaseObservation(() => sqlite.prepare(`
      SELECT instance_id AS instanceId, role, pid, started_at AS startedAt,
        last_seen_at AS lastSeenAt, stopped_at AS stoppedAt,
        terminal_reason AS terminalReason, restart_count AS restartCount,
        build_sha AS buildSha, runtime_mode AS runtimeMode,
        high_water_metrics AS highWaterMetrics, terminal_metrics AS terminalMetrics
      FROM runtime_telemetry_instances
      WHERE last_seen_at >= ?
      ORDER BY started_at DESC
    `).all(cutoff)) as Array<
    Omit<RuntimeTelemetryInstance, 'highWaterMetrics' | 'terminalMetrics'> & {
      highWaterMetrics: string;
      terminalMetrics: string | null;
    }
  >;
  return rows.map((row) => ({
    ...row,
    highWaterMetrics: JSON.parse(row.highWaterMetrics) as RuntimeMemoryValues,
    terminalMetrics: row.terminalMetrics
      ? deserializeRuntimeMetrics(row.terminalMetrics)
      : null,
  }));
}
