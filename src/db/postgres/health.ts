import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import type {
  DatabaseHealthProbe,
  DatabaseHealthProbeResult,
} from '@/lib/telemetry/database-health-probe';

export interface PostgresHealthSnapshot {
  connected: boolean;
  severity: 'healthy' | 'degraded' | 'critical';
  message: string;
  sizeBytes?: number;
  backend: {
    kind: 'postgres';
    details: {
      latencyMs: number;
      totalConnections: number;
      idleConnections: number;
      waitingClients: number;
    };
  };
}

export class PostgresDatabaseHealthProbe implements DatabaseHealthProbe {
  constructor(private readonly pool: Pool) {}

  async inspect(): Promise<PostgresHealthSnapshot & DatabaseHealthProbeResult> {
    const startedAt = performance.now();
    try {
      const result = await this.pool.query<{ size_bytes: string }>(
        'SELECT pg_database_size(current_database())::text AS size_bytes',
      );
      const latencyMs = performance.now() - startedAt;
      const saturated = this.pool.waitingCount > 0 && this.pool.idleCount === 0;
      const sizeBytes = result.rows[0]?.size_bytes === undefined
        ? undefined
        : Number(result.rows[0].size_bytes);
      return {
        connected: true,
        severity: saturated ? 'degraded' : 'healthy',
        message: saturated
          ? 'PostgreSQL connection pool is saturated'
          : 'PostgreSQL is available',
        ...(Number.isFinite(sizeBytes) ? { sizeBytes } : {}),
        backend: {
          kind: 'postgres',
          details: {
            latencyMs,
            totalConnections: this.pool.totalCount,
            idleConnections: this.pool.idleCount,
            waitingClients: this.pool.waitingCount,
          },
        },
      };
    } catch {
      return {
        connected: false,
        severity: 'critical',
        message: 'PostgreSQL is unavailable',
        backend: {
          kind: 'postgres',
          details: {
            latencyMs: performance.now() - startedAt,
            totalConnections: this.pool.totalCount,
            idleConnections: this.pool.idleCount,
            waitingClients: this.pool.waitingCount,
          },
        },
      };
    }
  }

  async hasSeedMarker(): Promise<boolean> {
    try {
      const table = await this.pool.query<{ table_name: string | null }>(
        `SELECT to_regclass('public.public_demo_runtime')::text AS table_name`,
      );
      if (!table.rows[0]?.table_name) return false;

      const result = await this.pool.query<{ seeded: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM public_demo_runtime WHERE id = 'seed'
        ) AS seeded`,
      );
      return result.rows[0]?.seeded === true;
    } catch {
      return false;
    }
  }
}
