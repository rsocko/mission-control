import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSqlitePlanningSignalRepository } from '@/db/persistence/sqlite-planning-signal-repository';

describe('SQLite planning signal coordination', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mc-planning-coordination-'));
  const databasePath = join(directory, 'planning.db');
  let sqlite: typeof import('@/db').sqlite;

  beforeAll(async () => {
    process.env.MC_DB_PATH = databasePath;
    vi.resetModules();
    const database = await import('@/db');
    sqlite = database.sqlite;
    sqlite.pragma('journal_mode = WAL');
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
    rmSync(directory, { recursive: true, force: true });
  });

  it('returns a marker-hit no-op without acquiring the write lock', async () => {
    const repository = createSqlitePlanningSignalRepository(sqlite);
    const now = new Date('2031-01-01T00:02:00.000Z');
    await repository.finalizeIfDue({ today: '2026-08-20', now });

    const competingWriter = new Database(databasePath);
    competingWriter.pragma('journal_mode = WAL');
    competingWriter.exec('BEGIN IMMEDIATE');
    try {
      await expect(repository.finalizeIfDue({ today: '2026-08-20', now }))
        .resolves.toBeNull();
    } finally {
      competingWriter.exec('ROLLBACK');
      competingWriter.close();
    }
  });

  it('serializes competing misses and inserts one durable window', async () => {
    const repositoryA = createSqlitePlanningSignalRepository(sqlite);
    const repositoryB = createSqlitePlanningSignalRepository(sqlite);
    const input = {
      today: '2026-08-20',
      now: new Date('2031-01-01T00:07:00.000Z'),
    };

    const results = await Promise.all([
      repositoryA.finalizeIfDue(input),
      repositoryB.finalizeIfDue(input),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it('rechecks the marker after the precheck/transaction race', async () => {
    const window = '2031-01-01T00:10:00.000Z';
    let injected = false;
    const database = new Proxy(sqlite, {
      get(target, property, receiver) {
        if (property === 'transaction' && !injected) {
          injected = true;
          target.prepare(`
            INSERT INTO task_history_events (
              task_id, event_type, field_name, previous_value, new_value,
              occurred_at, recorded_at, provenance, metadata
            ) VALUES (
              '__planning-signal-finalizer__', 'planning_signal_finalized',
              'planningDate', NULL, ?, ?, ?, 'test-race', NULL
            )
          `).run(window, window, new Date().toISOString());
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repository = createSqlitePlanningSignalRepository(database);

    await expect(repository.finalizeIfDue({
      today: '2026-08-20',
      now: new Date('2031-01-01T00:12:00.000Z'),
    })).resolves.toBeNull();
  });

  it('leaves a failed window unmarked and retryable', async () => {
    const repository = createSqlitePlanningSignalRepository(sqlite);
    const window = '2031-01-01T00:15:00.000Z';
    sqlite.exec(`
      CREATE TRIGGER fail_planning_window
      BEFORE INSERT ON task_history_events
      WHEN NEW.event_type = 'planning_signal_finalized'
        AND NEW.new_value = '${window}'
      BEGIN
        SELECT RAISE(ABORT, 'injected planning marker failure');
      END
    `);

    expect(() => repository.finalizeIfDue({
      today: '2026-08-20',
      now: new Date('2031-01-01T00:17:00.000Z'),
    })).toThrow('injected planning marker failure');
    expect(sqlite.prepare(`
      SELECT 1 FROM task_history_events
      WHERE event_type = 'planning_signal_finalized' AND new_value = ?
    `).get(window)).toBeUndefined();

    sqlite.exec('DROP TRIGGER fail_planning_window');
    await expect(repository.finalizeIfDue({
      today: '2026-08-20',
      now: new Date('2031-01-01T00:17:00.000Z'),
    })).resolves.not.toBeNull();
  });
});
