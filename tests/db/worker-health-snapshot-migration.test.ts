import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('worker health snapshot migration', () => {
  it('creates a singleton-compatible materialized snapshot table', () => {
    const sqlite = new Database(':memory:');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0103_worker_health_snapshot.sql'),
      'utf8',
    );

    sqlite.exec(migration);
    sqlite.prepare(`
      INSERT INTO worker_health_snapshot (
        id, schema_version, generated_at, worker_instance_id,
        worker_revision, generation_duration_ms, payload
      ) VALUES ('current', 1, '2026-08-16T12:00:00.000Z', 'worker-1', 'revision-1', 12, '{}')
    `).run();

    expect(sqlite.prepare(`
      SELECT schema_version AS schemaVersion, worker_instance_id AS workerInstanceId
      FROM worker_health_snapshot
      WHERE id = 'current'
    `).get()).toEqual({ schemaVersion: 1, workerInstanceId: 'worker-1' });
    sqlite.close();
  });
});
