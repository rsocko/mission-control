import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime telemetry history migration', () => {
  it('creates indexed sample history and durable process instances', () => {
    const sqlite = new Database(':memory:');
    for (const migrationName of [
      '0057_runtime_telemetry_history.sql',
      '0058_runtime_telemetry_history_v2.sql',
    ]) {
      const migration = readFileSync(
        resolve(process.cwd(), `drizzle/${migrationName}`),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }

    sqlite.prepare(`
      INSERT INTO runtime_telemetry_instances (
        instance_id, role, pid, started_at, last_seen_at, runtime_mode, high_water_metrics
      ) VALUES ('worker-1', 'worker', 42, '2026-08-06', '2026-08-06', 'worker', '{}')
    `).run();
    sqlite.prepare(`
      INSERT INTO runtime_telemetry_samples (
        instance_id, role, pid, sampled_at, resolution_seconds, metrics
      ) VALUES ('worker-1', 'worker', 42, '2026-08-06T00:00:00Z', 10, '{}')
    `).run();

    expect(sqlite.prepare(`
      SELECT role, terminal_reason AS terminalReason
      FROM runtime_telemetry_instances WHERE instance_id = 'worker-1'
    `).get()).toEqual({ role: 'worker', terminalReason: null });
    expect(sqlite.prepare(`
      SELECT resolution_seconds AS resolutionSeconds
      FROM runtime_telemetry_samples WHERE instance_id = 'worker-1'
    `).get()).toEqual({ resolutionSeconds: 10 });
    expect(() => sqlite.prepare(`
      INSERT INTO runtime_telemetry_samples (
        instance_id, role, pid, sampled_at, resolution_seconds, metrics
      ) VALUES ('worker-1', 'worker', 42, '2026-08-06T00:00:00Z', 10, '{}')
    `).run()).toThrow();
    sqlite.close();
  });
});
