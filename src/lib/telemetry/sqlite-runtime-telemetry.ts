import type Database from 'better-sqlite3';
import type { DatabaseTelemetrySnapshot } from './database';
import {
  aggregateSamples,
  deserializeRuntimeMetrics,
} from './runtime';
import type {
  RuntimeMemoryValues,
  RuntimeTelemetryInstance,
  RuntimeTelemetryRecord,
  RuntimeTelemetrySample,
} from './runtime';
import type {
  RuntimeInstanceRegistration,
  RuntimeTelemetryHistoryOptions,
  RuntimeTelemetryMaintenanceOptions,
  RuntimeTelemetryPersistence,
  RuntimeTelemetryPersistParams,
  RuntimeTelemetryStopParams,
} from './runtime-persistence';

type WithoutObservation = <T>(callback: () => T) => T;

export class SqliteRuntimeTelemetryPersistence implements RuntimeTelemetryPersistence {
  constructor(
    private readonly database: Database.Database,
    private readonly withoutObservation: WithoutObservation,
    private readonly readDatabaseTelemetry: () => DatabaseTelemetrySnapshot,
  ) {}

  getDatabaseTelemetry(): DatabaseTelemetrySnapshot {
    return this.readDatabaseTelemetry();
  }

  async registerInstance(registration: RuntimeInstanceRegistration): Promise<void> {
    this.withoutObservation(() => {
      this.database.prepare(`
        UPDATE runtime_telemetry_instances
        SET stopped_at = ?, terminal_reason = COALESCE(terminal_reason, ?)
        WHERE role = ? AND stopped_at IS NULL AND instance_id <> ?
      `).run(
        registration.startedAt,
        registration.restartReason,
        registration.role,
        registration.instanceId,
      );
      this.database.prepare(`
        INSERT INTO runtime_telemetry_instances (
          instance_id, role, pid, started_at, last_seen_at, stopped_at,
          terminal_reason, restart_count, build_sha, runtime_mode, high_water_metrics
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO NOTHING
      `).run(
        registration.instanceId,
        registration.role,
        registration.pid,
        registration.startedAt,
        registration.startedAt,
        registration.restartCount,
        registration.buildSha,
        registration.runtimeMode,
        JSON.stringify(registration.highWaterMetrics),
      );
    });
  }

  async persist(params: RuntimeTelemetryPersistParams): Promise<void> {
    this.withoutObservation(() => {
      const serialized = JSON.stringify(params.metrics);
      this.database.prepare(`
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
        params.role,
        params.instanceId,
        params.pid,
        params.startedAt,
        params.metrics.sampledAt,
        serialized,
      );
      this.database.prepare(`
        INSERT INTO runtime_telemetry_samples (
          instance_id, role, pid, sampled_at, resolution_seconds, metrics
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, sampled_at, resolution_seconds) DO UPDATE SET
          metrics = excluded.metrics
      `).run(
        params.instanceId,
        params.role,
        params.pid,
        params.metrics.sampledAt,
        params.resolutionSeconds,
        serialized,
      );
      this.database.prepare(`
        UPDATE runtime_telemetry_instances
        SET last_seen_at = ?, restart_count = ?, high_water_metrics = ?
        WHERE instance_id = ?
      `).run(
        params.metrics.sampledAt,
        params.metrics.container.restartCount,
        JSON.stringify(params.highWaterMetrics),
        params.instanceId,
      );
    });
  }

  async recordStop(params: RuntimeTelemetryStopParams): Promise<void> {
    this.withoutObservation(() => {
      this.database.prepare(`
        UPDATE runtime_telemetry_instances
        SET stopped_at = ?, last_seen_at = ?, terminal_reason = ?, terminal_metrics = ?
        WHERE instance_id = ?
      `).run(
        params.terminalMetrics.sampledAt,
        params.terminalMetrics.sampledAt,
        params.reason,
        JSON.stringify(params.terminalMetrics),
        params.instanceId,
      );
    });
  }

  async maintainHistory(
    now = new Date(),
    options: RuntimeTelemetryMaintenanceOptions = {},
  ): Promise<void> {
    this.withoutObservation(() => {
      const retentionHours = Math.max(72, options.retentionHours ?? 72);
      const rawHours = Math.min(retentionHours, Math.max(1, options.rawHours ?? 6));
      const downsampleSeconds = Math.max(60, options.downsampleSeconds ?? 300);
      const retentionCutoff = new Date(
        now.getTime() - retentionHours * 60 * 60_000,
      ).toISOString();
      const rawCutoff = new Date(now.getTime() - rawHours * 60 * 60_000).toISOString();
      const rows = this.database.prepare(`
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

      const insert = this.database.prepare(`
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
      this.database.prepare(`
        DELETE FROM runtime_telemetry_samples
        WHERE sampled_at < ? OR (sampled_at < ? AND resolution_seconds < ?)
      `).run(retentionCutoff, rawCutoff, downsampleSeconds);
      this.database.prepare(`
        DELETE FROM runtime_telemetry_instances
        WHERE last_seen_at < ?
      `).run(retentionCutoff);
    });
  }

  async getCurrent(): Promise<RuntimeTelemetryRecord[]> {
    const rows = this.withoutObservation(() => this.database.prepare(`
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

  async getHistory(
    options: RuntimeTelemetryHistoryOptions,
  ): Promise<RuntimeTelemetrySample[]> {
    const roleFilter = options.role ? 'AND role = ?' : '';
    const limitClause = options.limit === undefined ? '' : 'LIMIT ?';
    const query = this.database.prepare(`
      SELECT id, role, instanceId, pid, sampledAt, resolutionSeconds, metrics
      FROM (
        SELECT id, role, instance_id AS instanceId, pid,
          sampled_at AS sampledAt, resolution_seconds AS resolutionSeconds, metrics
        FROM runtime_telemetry_samples
        WHERE sampled_at >= ?
          ${roleFilter}
        ORDER BY sampled_at DESC
        ${limitClause}
      )
      ORDER BY sampledAt
    `);
    const rows = this.withoutObservation(() => (
      options.role
        ? options.limit === undefined
          ? query.all(options.since, options.role)
          : query.all(options.since, options.role, options.limit)
        : options.limit === undefined
          ? query.all(options.since)
          : query.all(options.since, options.limit)
    )) as Array<Omit<RuntimeTelemetrySample, 'metrics'> & { metrics: string }>;
    return rows.map((row) => ({
      ...row,
      metrics: deserializeRuntimeMetrics(row.metrics),
    }));
  }

  async getAlertHistory(hours: number): Promise<RuntimeTelemetrySample[]> {
    const boundedHours = Math.min(72, Math.max(1, hours));
    const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
    const rows = this.withoutObservation(() => this.database.prepare(`
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

  async getInstances(hours: number): Promise<RuntimeTelemetryInstance[]> {
    const boundedHours = Math.min(72, Math.max(1, hours));
    const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
    const rows = this.withoutObservation(() => this.database.prepare(`
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
}
