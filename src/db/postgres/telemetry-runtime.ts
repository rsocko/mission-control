import type { Pool } from 'pg';
import type {
  RuntimeMemoryValues,
  RuntimeMetrics,
  RuntimeRole,
  RuntimeTelemetryInstance,
  RuntimeTelemetryRecord,
  RuntimeTelemetrySample,
} from '@/lib/telemetry/runtime';
import { aggregateSamples, normalizeRuntimeMetrics } from '@/lib/telemetry/runtime';

/**
 * PostgreSQL-only counterpart to `src/lib/telemetry/runtime.ts`'s raw
 * `better-sqlite3` reads/writes against `runtime_telemetry`/
 * `runtime_telemetry_instances`/`runtime_telemetry_samples`. Mirrors the
 * exact semantics of the SQLite path (`RuntimeTelemetryMonitor.persist`/
 * `registerInstance`/`stop`, `maintainRuntimeTelemetryHistory`,
 * `getRuntimeTelemetry`/`getRuntimeTelemetryHistory`/
 * `getRuntimeTelemetryAlertHistory`/`getRuntimeTelemetryInstances`) against
 * the PostgreSQL Drizzle schema instead, using the same
 * `runtime_telemetry*` tables (already present in
 * `src/db/postgres/schema/connectors.ts`, kept column-parity with SQLite).
 *
 * `metrics`/`high_water_metrics`/`terminal_metrics` are `jsonb` columns
 * under PostgreSQL, so — unlike the SQLite adapter — reads never need
 * `JSON.parse`/`deserializeRuntimeMetrics`; writes still explicitly
 * `JSON.stringify` before binding, matching the rest of this codebase's raw
 * `pool.query` conventions (see `src/db/postgres/search.ts`,
 * `src/db/postgres/sync/job-repository.ts`).
 */

export interface PostgresRuntimeInstanceRegistration {
  instanceId: string;
  role: RuntimeRole;
  pid: number;
  startedAt: string;
  restartCount: number | null;
  buildSha: string | null;
  runtimeMode: string;
  highWaterMetrics: RuntimeMemoryValues;
  restartReason: string;
}

export async function registerPostgresRuntimeInstance(
  pool: Pool,
  registration: PostgresRuntimeInstanceRegistration,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`mission-control:runtime-telemetry:${registration.role}`],
    );
    await client.query(
      `
        UPDATE runtime_telemetry_instances
        SET stopped_at = $1, terminal_reason = COALESCE(terminal_reason, $2)
        WHERE role = $3 AND stopped_at IS NULL AND instance_id <> $4
      `,
      [
        registration.startedAt,
        registration.restartReason,
        registration.role,
        registration.instanceId,
      ],
    );
    await client.query(
      `
        INSERT INTO runtime_telemetry_instances (
          instance_id, role, pid, started_at, last_seen_at, stopped_at,
          terminal_reason, restart_count, build_sha, runtime_mode, high_water_metrics
        ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8, $9)
        ON CONFLICT (instance_id) DO NOTHING
      `,
      [
        registration.instanceId,
        registration.role,
        registration.pid,
        registration.startedAt,
        registration.startedAt,
        registration.restartCount,
        registration.buildSha,
        registration.runtimeMode,
        JSON.stringify(registration.highWaterMetrics),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface PostgresRuntimeTelemetryPersistParams {
  role: RuntimeRole;
  instanceId: string;
  pid: number;
  startedAt: string;
  metrics: RuntimeMetrics;
  resolutionSeconds: number;
  highWaterMetrics: RuntimeMemoryValues;
}

export async function persistPostgresRuntimeTelemetry(
  pool: Pool,
  params: PostgresRuntimeTelemetryPersistParams,
): Promise<void> {
  const serialized = JSON.stringify(params.metrics);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO runtime_telemetry (
          role, instance_id, pid, started_at, heartbeat_at, metrics
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (role) DO UPDATE SET
          instance_id = EXCLUDED.instance_id,
          pid = EXCLUDED.pid,
          started_at = EXCLUDED.started_at,
          heartbeat_at = EXCLUDED.heartbeat_at,
          metrics = EXCLUDED.metrics
        WHERE runtime_telemetry.heartbeat_at <= EXCLUDED.heartbeat_at
      `,
      [
        params.role,
        params.instanceId,
        params.pid,
        params.startedAt,
        params.metrics.sampledAt,
        serialized,
      ],
    );
    await client.query(
      `
        INSERT INTO runtime_telemetry_samples (
          instance_id, role, pid, sampled_at, resolution_seconds, metrics
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (instance_id, sampled_at, resolution_seconds) DO UPDATE SET
          metrics = EXCLUDED.metrics
      `,
      [
        params.instanceId,
        params.role,
        params.pid,
        params.metrics.sampledAt,
        params.resolutionSeconds,
        serialized,
      ],
    );
    await client.query(
      `
        UPDATE runtime_telemetry_instances
        SET last_seen_at = $1,
          restart_count = COALESCE($2, restart_count),
          high_water_metrics = $3
        WHERE instance_id = $4 AND last_seen_at <= $1
      `,
      [
        params.metrics.sampledAt,
        params.metrics.container.restartCount,
        JSON.stringify(params.highWaterMetrics),
        params.instanceId,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface PostgresRuntimeTelemetryStopParams {
  instanceId: string;
  reason: string;
  terminalMetrics: RuntimeMetrics;
}

export async function recordPostgresRuntimeTelemetryStop(
  pool: Pool,
  params: PostgresRuntimeTelemetryStopParams,
): Promise<void> {
  await pool.query(
    `
      UPDATE runtime_telemetry_instances
      SET stopped_at = $1, last_seen_at = $2, terminal_reason = $3, terminal_metrics = $4
      WHERE instance_id = $5
    `,
    [
      params.terminalMetrics.sampledAt,
      params.terminalMetrics.sampledAt,
      params.reason,
      JSON.stringify(params.terminalMetrics),
      params.instanceId,
    ],
  );
}

interface RawSampleRow {
  id: number;
  role: RuntimeRole;
  instanceId: string;
  pid: number;
  sampledAt: string;
  resolutionSeconds: number;
  metrics: Partial<RuntimeMetrics>;
}

/**
 * PostgreSQL counterpart to `maintainRuntimeTelemetryHistory`: downsamples
 * raw (high-resolution) samples older than `rawHours` into
 * `downsampleSeconds`-wide buckets, and prunes samples/instances past
 * `retentionHours`. Reuses the exact same JS bucketing/aggregation logic
 * (`aggregateSamples`) as the SQLite path so both backends downsample
 * identically; only the SQL dialect (parameter placeholders, `ON CONFLICT`
 * syntax) differs.
 */
export async function maintainPostgresRuntimeTelemetryHistory(
  pool: Pool,
  now = new Date(),
  options: {
    retentionHours?: number;
    rawHours?: number;
    downsampleSeconds?: number;
  } = {},
): Promise<void> {
  const retentionHours = Math.max(72, options.retentionHours ?? 72);
  const rawHours = Math.min(retentionHours, Math.max(1, options.rawHours ?? 6));
  const downsampleSeconds = Math.max(60, options.downsampleSeconds ?? 300);
  const retentionCutoff = new Date(now.getTime() - retentionHours * 60 * 60_000).toISOString();
  const rawCutoff = new Date(now.getTime() - rawHours * 60 * 60_000).toISOString();

  const { rows } = await pool.query<RawSampleRow>(
    `
      SELECT id, role, instance_id AS "instanceId", pid, sampled_at AS "sampledAt",
        resolution_seconds AS "resolutionSeconds", metrics
      FROM runtime_telemetry_samples
      WHERE sampled_at >= $1 AND sampled_at < $2 AND resolution_seconds < $3
      ORDER BY instance_id, sampled_at
    `,
    [retentionCutoff, rawCutoff, downsampleSeconds],
  );

  const buckets = new Map<string, RuntimeTelemetrySample[]>();
  for (const row of rows) {
    const bucketTime = Math.floor(
      new Date(row.sampledAt).getTime() / (downsampleSeconds * 1_000),
    ) * downsampleSeconds * 1_000;
    const key = `${row.instanceId}:${bucketTime}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push({ ...row, metrics: normalizeRuntimeMetrics(row.metrics) });
    buckets.set(key, bucket);
  }

  for (const samples of buckets.values()) {
    const first = samples[0];
    const bucketTime = Math.floor(
      new Date(first.sampledAt).getTime() / (downsampleSeconds * 1_000),
    ) * downsampleSeconds * 1_000;
    await pool.query(
      `
        INSERT INTO runtime_telemetry_samples (
          instance_id, role, pid, sampled_at, resolution_seconds, metrics
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (instance_id, sampled_at, resolution_seconds) DO UPDATE SET
          metrics = EXCLUDED.metrics
      `,
      [
        first.instanceId,
        first.role,
        first.pid,
        new Date(bucketTime).toISOString(),
        downsampleSeconds,
        JSON.stringify(aggregateSamples(samples)),
      ],
    );
  }

  await pool.query(
    `
      DELETE FROM runtime_telemetry_samples
      WHERE sampled_at < $1 OR (sampled_at < $2 AND resolution_seconds < $3)
    `,
    [retentionCutoff, rawCutoff, downsampleSeconds],
  );
  await pool.query(
    `DELETE FROM runtime_telemetry_instances WHERE last_seen_at < $1`,
    [retentionCutoff],
  );
}

interface RawTelemetryRow {
  role: RuntimeRole;
  instanceId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  metrics: Partial<RuntimeMetrics>;
}

export async function getPostgresRuntimeTelemetry(pool: Pool): Promise<RuntimeTelemetryRecord[]> {
  const { rows } = await pool.query<RawTelemetryRow>(
    `
      SELECT role, instance_id AS "instanceId", pid, started_at AS "startedAt",
        heartbeat_at AS "heartbeatAt", metrics
      FROM runtime_telemetry
      ORDER BY role
    `,
  );
  return rows.map((row) => ({
    ...row,
    metrics: normalizeRuntimeMetrics(row.metrics),
  }));
}

export async function getPostgresRuntimeTelemetryHistory(
  pool: Pool,
  options: { role?: RuntimeRole; since: string; limit: number },
): Promise<RuntimeTelemetrySample[]> {
  const { rows } = await pool.query<RawSampleRow>(
    options.role
      ? {
          text: `
            SELECT id, role, instance_id AS "instanceId", pid, sampled_at AS "sampledAt",
              resolution_seconds AS "resolutionSeconds", metrics
            FROM (
              SELECT id, role, instance_id, pid, sampled_at, resolution_seconds, metrics
              FROM runtime_telemetry_samples
              WHERE sampled_at >= $1 AND role = $2
              ORDER BY sampled_at DESC
              LIMIT $3
            ) recent
            ORDER BY sampled_at
          `,
          values: [options.since, options.role, options.limit],
        }
      : {
          text: `
            SELECT id, role, instance_id AS "instanceId", pid, sampled_at AS "sampledAt",
              resolution_seconds AS "resolutionSeconds", metrics
            FROM (
              SELECT id, role, instance_id, pid, sampled_at, resolution_seconds, metrics
              FROM runtime_telemetry_samples
              WHERE sampled_at >= $1
              ORDER BY sampled_at DESC
              LIMIT $2
            ) recent
            ORDER BY sampled_at
          `,
          values: [options.since, options.limit],
        },
  );
  return rows.map((row) => ({
    ...row,
    metrics: normalizeRuntimeMetrics(row.metrics),
  }));
}

export async function getPostgresRuntimeTelemetryAlertHistory(
  pool: Pool,
  hours: number,
): Promise<RuntimeTelemetrySample[]> {
  const boundedHours = Math.min(72, Math.max(1, hours));
  const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
  const { rows } = await pool.query<RawSampleRow>(
    `
      WITH gc_samples AS (
        SELECT
          id,
          role,
          instance_id AS "instanceId",
          pid,
          sampled_at AS "sampledAt",
          resolution_seconds AS "resolutionSeconds",
          metrics,
          ROW_NUMBER() OVER (
            PARTITION BY instance_id ORDER BY sampled_at ASC
          ) AS "oldestRank",
          ROW_NUMBER() OVER (
            PARTITION BY instance_id ORDER BY sampled_at DESC
          ) AS "newestRank"
        FROM runtime_telemetry_samples
        WHERE sampled_at >= $1
          AND metrics #>> '{memory,postGcFloor,heapUsedBytes}' IS NOT NULL
      )
      SELECT id, role, "instanceId", pid, "sampledAt", "resolutionSeconds", metrics
      FROM gc_samples
      WHERE "oldestRank" = 1 OR "newestRank" = 1
      ORDER BY "sampledAt"
    `,
    [cutoff],
  );
  return rows.map((row) => ({
    ...row,
    metrics: normalizeRuntimeMetrics(row.metrics),
  }));
}

interface RawInstanceRow {
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
  terminalMetrics: Partial<RuntimeMetrics> | null;
}

export async function getPostgresRuntimeTelemetryInstances(
  pool: Pool,
  hours: number,
): Promise<RuntimeTelemetryInstance[]> {
  const boundedHours = Math.min(72, Math.max(1, hours));
  const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
  const { rows } = await pool.query<RawInstanceRow>(
    `
      SELECT instance_id AS "instanceId", role, pid, started_at AS "startedAt",
        last_seen_at AS "lastSeenAt", stopped_at AS "stoppedAt",
        terminal_reason AS "terminalReason", restart_count AS "restartCount",
        build_sha AS "buildSha", runtime_mode AS "runtimeMode",
        high_water_metrics AS "highWaterMetrics", terminal_metrics AS "terminalMetrics"
      FROM runtime_telemetry_instances
      WHERE last_seen_at >= $1
      ORDER BY started_at DESC
    `,
    [cutoff],
  );
  return rows.map((row) => ({
    ...row,
    terminalMetrics: row.terminalMetrics ? normalizeRuntimeMetrics(row.terminalMetrics) : null,
  }));
}
