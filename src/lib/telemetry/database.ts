import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { dbLogger } from '@/lib/logger';

export type DatabaseOperationCategory = 'read' | 'write' | 'transaction' | 'maintenance';
export type DatabaseTelemetrySeverity = 'healthy' | 'degraded' | 'critical';
export type WalAllocationState = 'empty' | 'retained' | 'pending' | 'busy' | 'unavailable';

export interface DatabaseOperationAggregate {
  count: number;
  failureCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface DatabaseTelemetrySnapshot {
  sampledAt: string;
  windowStartedAt: string;
  sampleInterval: {
    startedAt: string;
    operationCount: number;
    synchronousDatabaseTimeMs: number;
    contentionFailureCount: number;
    busyTimeoutCount: number;
  };
  operations: {
    total: DatabaseOperationAggregate;
    byCategory: Partial<Record<DatabaseOperationCategory, DatabaseOperationAggregate>>;
    byOperation: Record<string, DatabaseOperationAggregate>;
  };
  contention: {
    writerAcquisitionCount: number;
    writerAcquisitionDurationMs: number;
    writerAcquisitionP95Ms: number;
    writerAcquisitionP99Ms: number;
    successfulWaitCount: number;
    successfulWaitDurationMs: number;
    busyFailureCount: number;
    busyTimeoutCount: number;
    lastBusyAt: string | null;
  };
  wal: {
    available: boolean;
    sizeBytes: number | null;
    allocationState: WalAllocationState;
    checkpointBusy: boolean | null;
    logFrames: number | null;
    checkpointedFrames: number | null;
    pendingFrames: number | null;
    checkpointProbeDurationMs: number | null;
    checkpointAgeMs: number | null;
    checkpointAttemptedAt: string | null;
    starved: boolean;
    errorCode: string | null;
  };
  slowOperations: Array<{
    operation: string;
    category: DatabaseOperationCategory;
    durationMs: number;
    failed: boolean;
    errorCode: string | null;
    observedAt: string;
  }>;
  thresholds: {
    slowOperationMs: number;
    latencyP95WarningMs: number;
    latencyP99CriticalMs: number;
    busyWaitWarningMs: number;
    busyTimeoutMs: number;
    walWarningBytes: number;
    walCriticalBytes: number;
    checkpointStarvationMs: number;
    checkpointPendingFrames: number;
    checkpointProbeIntervalMs: number;
    observationWindowMs: number;
  };
  severity: DatabaseTelemetrySeverity;
  reasons: string[];
}

interface OperationSample {
  operation: string;
  category: DatabaseOperationCategory;
  durationMs: number;
  failed: boolean;
  errorCode: string | null;
  countsAsContention: boolean;
  observedAt: string;
}

interface WriterAcquisitionSample {
  durationMs: number;
  observedAt: string;
}

interface WalCheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return unitIndex === 0
    ? `${value} ${units[unitIndex]}`
    : `${value.toFixed(1)} ${units[unitIndex]}`;
}

function percentile(values: number[], requestedPercentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(requestedPercentile / 100 * sorted.length) - 1);
  return round(sorted[index]);
}

function aggregate(samples: OperationSample[]): DatabaseOperationAggregate {
  const durations = samples.map((sample) => sample.durationMs);
  return {
    count: samples.length,
    failureCount: samples.filter((sample) => sample.failed).length,
    totalDurationMs: round(durations.reduce((total, duration) => total + duration, 0)),
    maxDurationMs: round(Math.max(0, ...durations)),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
  };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function isBusyCode(code: string | null): boolean {
  return code === 'SQLITE_BUSY' || code?.startsWith('SQLITE_BUSY_') === true;
}

function isContentionCode(code: string | null): boolean {
  return isBusyCode(code)
    || code === 'SQLITE_LOCKED'
    || code?.startsWith('SQLITE_LOCKED_') === true;
}

function operationName(source: string): string {
  const withoutComments = source
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, '')
    .trimStart();
  const operation = withoutComments.match(/^[A-Za-z]+/u)?.[0]?.toUpperCase();
  return operation && operation.length <= 16 ? operation : 'OTHER';
}

function statementCategory(
  operation: string,
  statement: Database.Statement,
): DatabaseOperationCategory {
  if (operation === 'PRAGMA' || operation === 'VACUUM' || operation === 'ANALYZE') {
    return 'maintenance';
  }
  return statement.reader ? 'read' : 'write';
}

export class DatabaseTelemetryCollector {
  private readonly samples: OperationSample[] = [];
  private readonly writerAcquisitions: WriterAcquisitionSample[] = [];
  private readonly maxSamples: number;
  private readonly maxSlowOperations: number;
  private windowStartedAt = new Date();
  private intervalStartedAt = new Date();
  private intervalOperationCount = 0;
  private intervalStatementDurationMs = 0;
  private intervalWriterAcquisitionDurationMs = 0;
  private intervalContentionFailureCount = 0;
  private intervalBusyTimeoutCount = 0;
  private readonly observationContext = new AsyncLocalStorage<boolean>();
  private checkpointTrackingStartedAt = Date.now();
  private lastCompleteCheckpointAt: number | null = null;
  private lastCheckpointProbeAt: number | null = null;
  private lastCheckpointProbeDurationMs: number | null = null;
  private lastCheckpoint: WalCheckpointRow | null = null;
  private lastBusyAt: string | null = null;

  constructor() {
    this.maxSamples = configuredPositiveInteger('MC_DB_MAX_SAMPLES', 1_000);
    this.maxSlowOperations = configuredPositiveInteger('MC_DB_MAX_SLOW_OPERATIONS', 10);
  }

  observe<T>(
    operation: string,
    category: DatabaseOperationCategory,
    callback: () => T,
    options: {
      countContention?: boolean | (() => boolean);
    } = {},
  ): T {
    if (this.observationContext.getStore()) return callback();
    const startedAt = performance.now();
    try {
      const result = callback();
      this.record(operation, category, performance.now() - startedAt, null);
      return result;
    } catch (error) {
      const countContention = typeof options.countContention === 'function'
        ? options.countContention()
        : options.countContention ?? true;
      this.record(
        operation,
        category,
        performance.now() - startedAt,
        error,
        countContention,
      );
      throw error;
    }
  }

  observeIterator(
    operation: string,
    category: DatabaseOperationCategory,
    createIterator: () => IterableIterator<unknown>,
  ): IterableIterator<unknown> {
    if (this.observationContext.getStore()) return createIterator();
    const startedAt = performance.now();
    let iterator: IterableIterator<unknown>;
    try {
      iterator = createIterator();
    } catch (error) {
      this.record(operation, category, performance.now() - startedAt, error);
      throw error;
    }

    let durationMs = performance.now() - startedAt;
    let finalized = false;
    const finalize = (error: unknown) => {
      if (finalized) return;
      finalized = true;
      this.record(operation, category, durationMs, error);
    };
    const invoke = (
      method: 'next' | 'return' | 'throw',
      parameters: unknown[],
    ): IteratorResult<unknown> => {
      const iteratorMethod = iterator[method];
      if (!iteratorMethod) {
        finalize(null);
        return { done: true, value: parameters[0] };
      }
      const callStartedAt = performance.now();
      try {
        const result = Reflect.apply(iteratorMethod, iterator, parameters) as IteratorResult<unknown>;
        durationMs += performance.now() - callStartedAt;
        if (result.done || method !== 'next') finalize(null);
        return result;
      } catch (error) {
        durationMs += performance.now() - callStartedAt;
        finalize(error);
        throw error;
      }
    };
    return {
      next: (...parameters: [] | [unknown]) => invoke('next', parameters),
      return: (value?: unknown) => invoke('return', [value]),
      throw: (error?: unknown) => invoke('throw', [error]),
      [Symbol.iterator]() {
        return this;
      },
    };
  }

  recordWriterAcquisition(durationMs: number): void {
    if (this.observationContext.getStore()) return;
    const observedAt = new Date().toISOString();
    this.writerAcquisitions.push({ durationMs: round(durationMs), observedAt });
    this.intervalWriterAcquisitionDurationMs += durationMs;
    if (this.writerAcquisitions.length > this.maxSamples) this.writerAcquisitions.shift();

    const warningMs = this.thresholds().busyWaitWarningMs;
    if (durationMs >= warningMs) {
      dbLogger.warn(
        { durationMs: round(durationMs), thresholdMs: warningMs },
        'SQLite write transaction waited for writer lock',
      );
    }
  }

  snapshot(database: Database.Database): DatabaseTelemetrySnapshot {
    const sampledAt = new Date();
    const intervalContentionFailureCount = this.intervalContentionFailureCount;
    const intervalBusyTimeoutCount = this.intervalBusyTimeoutCount;
    const sampleInterval = {
      startedAt: this.intervalStartedAt.toISOString(),
      operationCount: this.intervalOperationCount,
      synchronousDatabaseTimeMs: round(
        this.intervalStatementDurationMs + this.intervalWriterAcquisitionDurationMs,
      ),
      contentionFailureCount: intervalContentionFailureCount,
      busyTimeoutCount: intervalBusyTimeoutCount,
    };
    this.intervalStartedAt = sampledAt;
    this.intervalOperationCount = 0;
    this.intervalStatementDurationMs = 0;
    this.intervalWriterAcquisitionDurationMs = 0;
    this.intervalContentionFailureCount = 0;
    this.intervalBusyTimeoutCount = 0;
    const thresholds = this.thresholds();
    this.prune(sampledAt.getTime() - thresholds.observationWindowMs);
    const wal = this.readWalHealth(database, sampledAt.getTime(), thresholds);
    const byCategory: DatabaseTelemetrySnapshot['operations']['byCategory'] = {};
    const byOperation: Record<string, DatabaseOperationAggregate> = {};

    for (const category of ['read', 'write', 'transaction', 'maintenance'] as const) {
      const categorySamples = this.samples.filter((sample) => sample.category === category);
      if (categorySamples.length > 0) byCategory[category] = aggregate(categorySamples);
    }
    for (const operation of new Set(this.samples.map((sample) => sample.operation))) {
      byOperation[operation] = aggregate(
        this.samples.filter((sample) => sample.operation === operation),
      );
    }

    const contentionFailures = this.samples.filter(
      (sample) => sample.countsAsContention && isContentionCode(sample.errorCode),
    );
    const busyTimeouts = contentionFailures.filter(
      (sample) => isBusyCode(sample.errorCode)
        && sample.durationMs >= thresholds.busyTimeoutMs * 0.9,
    );
    const contentionFailureCount = Math.max(
      contentionFailures.length,
      intervalContentionFailureCount,
    );
    const busyTimeoutCount = Math.max(
      busyTimeouts.length,
      intervalBusyTimeoutCount,
    );
    const acquisitionDurations = this.writerAcquisitions.map((sample) => sample.durationMs);
    const successfulWaits = this.writerAcquisitions.filter(
      (sample) => sample.durationMs >= thresholds.busyWaitWarningMs,
    );
    const total = aggregate(
      this.samples.filter((sample) => sample.category !== 'transaction'),
    );
    const latencyAggregates = [
      { label: 'overall', metrics: total },
      ...Object.entries(byCategory).map(([label, metrics]) => ({ label, metrics })),
    ];
    const highestP99 = latencyAggregates.reduce(
      (highest, candidate) => candidate.metrics.p99Ms > highest.metrics.p99Ms
        ? candidate
        : highest,
    );
    const highestP95 = latencyAggregates.reduce(
      (highest, candidate) => candidate.metrics.p95Ms > highest.metrics.p95Ms
        ? candidate
        : highest,
    );
    const reasons: string[] = [];
    let severity: DatabaseTelemetrySeverity = 'healthy';

    const degrade = (reason: string) => {
      if (severity === 'healthy') severity = 'degraded';
      reasons.push(reason);
    };
    const makeCritical = (reason: string) => {
      severity = 'critical';
      reasons.push(reason);
    };

    if (busyTimeoutCount > 0) {
      makeCritical(`${busyTimeoutCount} SQLite busy timeout(s) exhausted`);
    } else if (contentionFailureCount > 0) {
      degrade(`${contentionFailureCount} SQLite busy/locked operation(s) failed`);
    }
    if (successfulWaits.length > 0) {
      degrade(`${successfulWaits.length} SQLite writer lock wait(s) exceeded ${thresholds.busyWaitWarningMs}ms`);
    }
    if (highestP99.metrics.p99Ms >= thresholds.latencyP99CriticalMs) {
      makeCritical(`SQLite ${highestP99.label} latency p99 is ${highestP99.metrics.p99Ms}ms`);
    } else if (highestP95.metrics.p95Ms >= thresholds.latencyP95WarningMs) {
      degrade(`SQLite ${highestP95.label} latency p95 is ${highestP95.metrics.p95Ms}ms`);
    }
    if (wal.starved) {
      makeCritical('SQLite WAL checkpoint is starved');
    }
    const walHasPendingWork = wal.checkpointBusy === true
      || (wal.pendingFrames !== null && wal.pendingFrames > 0);
    if (
      walHasPendingWork
      && wal.sizeBytes !== null
      && wal.sizeBytes >= thresholds.walCriticalBytes
    ) {
      makeCritical(`SQLite WAL is ${formatBytes(wal.sizeBytes)} with pending checkpoint work`);
    } else if (
      walHasPendingWork
      && wal.sizeBytes !== null
      && wal.sizeBytes >= thresholds.walWarningBytes
    ) {
      degrade(`SQLite WAL is ${formatBytes(wal.sizeBytes)} with pending checkpoint work`);
    }

    return {
      sampledAt: sampledAt.toISOString(),
      windowStartedAt: this.windowStartedAt.toISOString(),
      sampleInterval,
      operations: { total, byCategory, byOperation },
      contention: {
        writerAcquisitionCount: acquisitionDurations.length,
        writerAcquisitionDurationMs: round(
          acquisitionDurations.reduce((totalDuration, duration) => totalDuration + duration, 0),
        ),
        writerAcquisitionP95Ms: percentile(acquisitionDurations, 95),
        writerAcquisitionP99Ms: percentile(acquisitionDurations, 99),
        successfulWaitCount: successfulWaits.length,
        successfulWaitDurationMs: round(
          successfulWaits.reduce((totalDuration, sample) => totalDuration + sample.durationMs, 0),
        ),
        busyFailureCount: contentionFailureCount,
        busyTimeoutCount,
        lastBusyAt: this.lastBusyAt,
      },
      wal,
      slowOperations: this.samples
        .filter((sample) => sample.durationMs >= thresholds.slowOperationMs)
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, this.maxSlowOperations)
        .map((sample) => ({
          operation: sample.operation,
          category: sample.category,
          durationMs: sample.durationMs,
          failed: sample.failed,
          errorCode: sample.errorCode,
          observedAt: sample.observedAt,
        })),
      thresholds,
      severity,
      reasons,
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.writerAcquisitions.length = 0;
    this.windowStartedAt = new Date();
    this.intervalStartedAt = new Date();
    this.intervalOperationCount = 0;
    this.intervalStatementDurationMs = 0;
    this.intervalWriterAcquisitionDurationMs = 0;
    this.intervalContentionFailureCount = 0;
    this.intervalBusyTimeoutCount = 0;
    this.checkpointTrackingStartedAt = Date.now();
    this.lastCompleteCheckpointAt = null;
    this.lastCheckpointProbeAt = null;
    this.lastCheckpointProbeDurationMs = null;
    this.lastCheckpoint = null;
    this.lastBusyAt = null;
  }

  withoutObservation<T>(callback: () => T): T {
    return this.observationContext.run(true, callback);
  }

  private record(
    operation: string,
    category: DatabaseOperationCategory,
    durationMs: number,
    error: unknown,
    countsAsContention = true,
  ): void {
    const code = errorCode(error);
    const sample: OperationSample = {
      operation,
      category,
      durationMs: round(durationMs),
      failed: error !== null,
      errorCode: code,
      countsAsContention,
      observedAt: new Date().toISOString(),
    };
    this.samples.push(sample);
    if (category !== 'transaction') {
      this.intervalOperationCount++;
      this.intervalStatementDurationMs += durationMs;
    }
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
      const oldestSample = this.samples[0];
      if (oldestSample) this.windowStartedAt = new Date(oldestSample.observedAt);
    }

    const thresholds = this.thresholds();
    if (countsAsContention && isContentionCode(code)) {
      this.lastBusyAt = sample.observedAt;
      this.intervalContentionFailureCount++;
      const timedOut = isBusyCode(code)
        && sample.durationMs >= thresholds.busyTimeoutMs * 0.9;
      if (timedOut) this.intervalBusyTimeoutCount++;
      const logDetails = {
        operation,
        category,
        durationMs: sample.durationMs,
        errorCode: code,
        busyTimeoutMs: thresholds.busyTimeoutMs,
      };
      if (timedOut) {
        dbLogger.error(logDetails, 'SQLite busy timeout exhausted');
      } else {
        dbLogger.warn(logDetails, 'SQLite operation failed due to lock contention');
      }
    } else if (sample.durationMs >= thresholds.slowOperationMs) {
      dbLogger.warn(
        {
          operation,
          category,
          durationMs: sample.durationMs,
          failed: sample.failed,
          errorCode: code,
          thresholdMs: thresholds.slowOperationMs,
        },
        'Slow SQLite operation detected',
      );
    }
  }

  private readWalHealth(
    database: Database.Database,
    now: number,
    thresholds: DatabaseTelemetrySnapshot['thresholds'],
  ): DatabaseTelemetrySnapshot['wal'] {
    const walPath = `${database.name}-wal`;
    let sizeBytes = 0;
    try {
      try {
        sizeBytes = statSync(walPath).size;
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'ENOENT') throw error;
      }
      const pageSize = Number(database.pragma('page_size', { simple: true })) || 4_096;
      const estimatedFrames = sizeBytes <= 32
        ? 0
        : Math.floor((sizeBytes - 32) / (pageSize + 24));
      const lastCheckpointComplete = this.lastCheckpoint?.busy === 0
        && this.lastCheckpoint.log === this.lastCheckpoint.checkpointed;
      const shouldProbe = this.lastCheckpointProbeAt === null
        || now - this.lastCheckpointProbeAt >= thresholds.checkpointProbeIntervalMs
        || (!lastCheckpointComplete && (
          sizeBytes >= thresholds.walWarningBytes
          || estimatedFrames >= thresholds.checkpointPendingFrames
        ));
      if (shouldProbe) {
        const checkpointStartedAt = performance.now();
        const row = database.pragma('wal_checkpoint(PASSIVE)') as WalCheckpointRow[];
        const checkpoint = row[0];
        if (!checkpoint) throw new Error('SQLite returned no WAL checkpoint result');
        this.lastCheckpointProbeDurationMs = round(performance.now() - checkpointStartedAt);
        this.lastCheckpoint = checkpoint;
        this.lastCheckpointProbeAt = now;
      }
      const checkpoint = this.lastCheckpoint;
      if (!checkpoint) throw new Error('SQLite WAL checkpoint has not been sampled');
      const pendingFrames = Math.max(0, checkpoint.log - checkpoint.checkpointed);
      const allocationState: WalAllocationState = checkpoint.busy > 0
        ? 'busy'
        : pendingFrames > 0
          ? 'pending'
          : sizeBytes > 0
            ? 'retained'
            : 'empty';
      if (shouldProbe && checkpoint.busy === 0 && pendingFrames === 0) {
        this.lastCompleteCheckpointAt = now;
      }
      const checkpointAgeMs = now - (
        this.lastCompleteCheckpointAt ?? this.checkpointTrackingStartedAt
      );
      const starved = checkpointAgeMs >= thresholds.checkpointStarvationMs
        && (checkpoint.busy > 0 || pendingFrames >= thresholds.checkpointPendingFrames);
      return {
        available: true,
        sizeBytes,
        allocationState,
        checkpointBusy: checkpoint.busy > 0,
        logFrames: checkpoint.log,
        checkpointedFrames: checkpoint.checkpointed,
        pendingFrames,
        checkpointProbeDurationMs: this.lastCheckpointProbeDurationMs,
        checkpointAgeMs,
        checkpointAttemptedAt: this.lastCheckpointProbeAt === null
          ? null
          : new Date(this.lastCheckpointProbeAt).toISOString(),
        starved,
        errorCode: null,
      };
    } catch (error) {
      return {
        available: false,
        sizeBytes: null,
        allocationState: 'unavailable',
        checkpointBusy: null,
        logFrames: null,
        checkpointedFrames: null,
        pendingFrames: null,
        checkpointProbeDurationMs: this.lastCheckpointProbeDurationMs,
        checkpointAgeMs: null,
        checkpointAttemptedAt: this.lastCheckpointProbeAt === null
          ? null
          : new Date(this.lastCheckpointProbeAt).toISOString(),
        starved: false,
        errorCode: errorCode(error) ?? 'CHECKPOINT_FAILED',
      };
    }
  }

  private thresholds(): DatabaseTelemetrySnapshot['thresholds'] {
    return {
      slowOperationMs: configuredPositiveInteger('MC_DB_SLOW_OPERATION_MS', 100),
      latencyP95WarningMs: configuredPositiveInteger('MC_DB_LATENCY_P95_WARNING_MS', 100),
      latencyP99CriticalMs: configuredPositiveInteger('MC_DB_LATENCY_P99_CRITICAL_MS', 500),
      busyWaitWarningMs: configuredPositiveInteger('MC_DB_BUSY_WAIT_WARNING_MS', 100),
      busyTimeoutMs: configuredPositiveInteger('MC_DB_BUSY_TIMEOUT_MS', 5_000),
      walWarningBytes: configuredPositiveInteger('MC_DB_WAL_WARNING_BYTES', 64 * 1024 * 1024),
      walCriticalBytes: configuredPositiveInteger('MC_DB_WAL_CRITICAL_BYTES', 256 * 1024 * 1024),
      checkpointStarvationMs: configuredPositiveInteger(
        'MC_DB_CHECKPOINT_STARVATION_MS',
        60_000,
      ),
      checkpointPendingFrames: configuredPositiveInteger(
        'MC_DB_CHECKPOINT_PENDING_FRAMES',
        1_000,
      ),
      checkpointProbeIntervalMs: configuredPositiveInteger(
        'MC_DB_CHECKPOINT_PROBE_INTERVAL_MS',
        60_000,
      ),
      observationWindowMs: configuredPositiveInteger('MC_DB_OBSERVATION_WINDOW_MS', 300_000),
    };
  }

  private prune(cutoff: number): void {
    while (
      this.samples[0]
      && new Date(this.samples[0].observedAt).getTime() < cutoff
    ) {
      this.samples.shift();
    }
    while (
      this.writerAcquisitions[0]
      && new Date(this.writerAcquisitions[0].observedAt).getTime() < cutoff
    ) {
      this.writerAcquisitions.shift();
    }
    const oldestObservedAt = [
      this.samples[0]?.observedAt,
      this.writerAcquisitions[0]?.observedAt,
    ]
      .filter((value): value is string => value !== undefined)
      .sort()[0];
    this.windowStartedAt = oldestObservedAt ? new Date(oldestObservedAt) : new Date();
  }
}

function instrumentStatement(
  statement: Database.Statement,
  collector: DatabaseTelemetryCollector,
  source: string,
): Database.Statement {
  const operation = operationName(source);
  const category = statementCategory(operation, statement);
  const proxy: Database.Statement = new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'iterate') {
        return (...parameters: unknown[]) => collector.observeIterator(
          operation,
          category,
          () => Reflect.apply(value, target, parameters) as IterableIterator<unknown>,
        );
      }
      if (property === 'run' || property === 'get' || property === 'all') {
        return (...parameters: unknown[]) => collector.observe(
          operation,
          category,
          () => Reflect.apply(value, target, parameters),
        );
      }
      return (...parameters: unknown[]) => {
        const result = Reflect.apply(value, target, parameters);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

function instrumentTransaction(
  database: Database.Database,
  collector: DatabaseTelemetryCollector,
  callback: (...parameters: unknown[]) => unknown,
): Database.Transaction {
  let acquisitionStartedAt = 0;
  let behavior = 'default';
  let callbackStarted = false;
  const observedCallback = (...parameters: unknown[]) => {
    callbackStarted = true;
    if (behavior === 'immediate' || behavior === 'exclusive') {
      collector.recordWriterAcquisition(performance.now() - acquisitionStartedAt);
    }
    return callback(...parameters);
  };
  const transaction = database.transaction(observedCallback);
  const invoke = (selectedBehavior: 'default' | 'deferred' | 'immediate' | 'exclusive') => (
    ...parameters: unknown[]
  ) => collector.observe('TRANSACTION', 'transaction', () => {
    behavior = selectedBehavior;
    callbackStarted = false;
    acquisitionStartedAt = performance.now();
    return Reflect.apply(transaction[selectedBehavior], transaction, parameters);
  }, { countContention: () => !callbackStarted });
  const wrapped = invoke('default') as Database.Transaction;
  wrapped.default = invoke('default');
  wrapped.deferred = invoke('deferred');
  wrapped.immediate = invoke('immediate');
  wrapped.exclusive = invoke('exclusive');
  return wrapped;
}

export function createObservedDatabase(
  database: Database.Database,
  collector: DatabaseTelemetryCollector,
): Database.Database {
  const proxy: Database.Database = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'prepare') {
        return (source: string) => instrumentStatement(target.prepare(source), collector, source);
      }
      if (property === 'transaction') {
        return (callback: (...parameters: unknown[]) => unknown) =>
          instrumentTransaction(target, collector, callback);
      }
      if (property === 'exec') {
        return (source: string) => collector.observe('EXEC', 'write', () => {
          target.exec(source);
          return proxy;
        });
      }
      if (property === 'pragma') {
        return (source: string, options?: Database.PragmaOptions) =>
          collector.observe('PRAGMA', 'maintenance', () => target.pragma(source, options));
      }
      return (...parameters: unknown[]) => {
        const result = Reflect.apply(value, target, parameters);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}
