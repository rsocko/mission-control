import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseHealthProbe } from '@/lib/telemetry/sqlite-database-health-probe';
import { SqliteHealthSnapshotStore } from '@/lib/telemetry/sqlite-health-snapshot-store';

interface TestSnapshot {
  schemaVersion: number;
  generatedAt: string;
  worker: { instanceId: string; revision: string };
  generationDurationMs: number;
  summary: { status: string };
}

describe('SQLite health adapters', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE public_demo_runtime (
        id TEXT PRIMARY KEY,
        seeded_at TEXT NOT NULL
      );
      CREATE TABLE worker_health_snapshot (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        worker_instance_id TEXT NOT NULL,
        worker_revision TEXT NOT NULL,
        generation_duration_ms INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns neutral severity with explicit SQLite detail', async () => {
    const probe = new SqliteDatabaseHealthProbe(sqlite, (callback) => callback());

    await expect(probe.inspect()).resolves.toMatchObject({
      connected: true,
      severity: 'healthy',
      message: 'Connected',
      backend: {
        kind: 'sqlite',
        details: {
          pageCount: expect.any(Number),
          pageSize: expect.any(Number),
        },
      },
    });
  });

  it('stores parsed health snapshots and runs validation atomically', async () => {
    const store = new SqliteHealthSnapshotStore<TestSnapshot['summary']>(
      sqlite,
      (callback) => callback(),
    );
    const snapshot: TestSnapshot = {
      schemaVersion: 1,
      generatedAt: '2026-08-25T20:00:00.000Z',
      worker: { instanceId: 'worker-1', revision: 'revision-1' },
      generationDurationMs: 12,
      summary: { status: 'healthy' },
    };

    await store.write(snapshot);
    await expect(store.read()).resolves.toEqual(snapshot);

    await expect(store.write(
      { ...snapshot, generatedAt: '2026-08-25T20:01:00.000Z' },
      () => {
        throw new Error('deferred');
      },
    )).rejects.toThrow('deferred');
    await expect(store.read()).resolves.toEqual(snapshot);
  });
});
