import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('sync worker migration', () => {
  it('records the worker tables in Drizzle snapshot metadata', () => {
    const snapshot = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'drizzle/meta/0047_snapshot.json'),
        'utf8',
      ),
    ) as { tables: Record<string, unknown> };

    expect(snapshot.tables).toMatchObject({
      sync_jobs: expect.any(Object),
      sync_job_events: expect.any(Object),
      runtime_telemetry: expect.any(Object),
      sync_schedules: expect.any(Object),
      triage_action_claims: expect.any(Object),
    });
  });

  it('creates durable jobs, connector exclusion, events, and telemetry', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0047_isolate_sync_worker.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const insert = sqlite.prepare(`
      INSERT INTO sync_jobs (
        id, connector_id, source, status, available_at, scheduled_for,
        created_at, updated_at
      ) VALUES (?, 'github-1', 'api', ?, '2026-08-03', '2026-08-03', '2026-08-03', '2026-08-03')
    `);
    insert.run('job-1', 'running');
    expect(() => insert.run('job-2', 'queued')).toThrow();
    insert.run('job-3', 'failed');

    sqlite.prepare(`
      INSERT INTO sync_job_events (job_id, connector_id, event_type, payload, created_at)
      VALUES ('job-1', 'github-1', 'sync:start', '{}', '2026-08-03')
    `).run();
    sqlite.prepare(`
      INSERT INTO runtime_telemetry (role, instance_id, pid, started_at, heartbeat_at, metrics)
      VALUES ('worker', 'instance-1', 123, '2026-08-03', '2026-08-03', '{}')
    `).run();
    sqlite.prepare(`
      INSERT INTO sync_schedules (
        connector_id, interval_minutes, next_due_at, updated_at
      ) VALUES ('github-1', 5, '2026-08-03', '2026-08-03')
    `).run();

    sqlite.prepare(`DELETE FROM sync_jobs WHERE id = 'job-1'`).run();
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM sync_job_events`).get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare(`
      SELECT pid FROM runtime_telemetry WHERE role = 'worker'
    `).get()).toEqual({ pid: 123 });
    expect(sqlite.prepare(`
      SELECT interval_minutes AS intervalMinutes
      FROM sync_schedules WHERE connector_id = 'github-1'
    `).get()).toEqual({ intervalMinutes: 5 });
    sqlite.close();
  });
});
