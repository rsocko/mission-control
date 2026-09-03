/**
 * `createSqliteTaskCorePersistence` takes both the database handle *and* the
 * transaction runner it writes through. This test proves the pair is honored
 * end to end: a composition built over one database must read *and* write that
 * database, never a module-level handle. Two independent databases are opened
 * and only one is injected; the other must be left completely untouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as SchemaModule from '@/db/schema';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'drizzle');
const NOW = '2026-08-05T12:00:00.000Z';

const originalDbPath = process.env.MC_DB_PATH;

let injectedSqlite: Database.Database;
let untouchedSqlite: Database.Database;
let persistence: TaskCorePersistence;
let injectedDrizzle: BetterSQLite3Database<typeof SchemaModule>;
let schema: typeof SchemaModule;

function insertTask(sqlite: Database.Database, id: string): void {
  sqlite.prepare(`
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, status,
      local_disposition, priority, push_count, created_at, updated_at, depth,
      is_checklist_item, metadata, sync_status, last_synced_at, push_retry_count
    ) VALUES (?, ?, 'local', 'local', ?, 'todo', 'active', 'none', 0, ?, ?, 0, 0, '{}', 'synced', ?, 0)
  `).run(id, `local:${id}`, `Task ${id}`, NOW, NOW, NOW);
}

function countTasks(sqlite: Database.Database, id: string): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS total FROM tasks WHERE id = ?')
    .get(id) as { total: number };
  return Number(row.total);
}

beforeAll(async () => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.resetModules();

  const [{ drizzle }, schemaModule, registry, adapter] = await Promise.all([
    import('drizzle-orm/better-sqlite3'),
    import('@/db/schema'),
    import('@/db/bootstrap/registry'),
    import('@/db/persistence/sqlite-task-core-repositories'),
  ]);
  schema = schemaModule;

  injectedSqlite = new Database(':memory:');
  untouchedSqlite = new Database(':memory:');
  registry.runOrderedDatabaseBootstrap(injectedSqlite, MIGRATIONS_DIRECTORY);
  registry.runOrderedDatabaseBootstrap(untouchedSqlite, MIGRATIONS_DIRECTORY);

  injectedDrizzle = drizzle(injectedSqlite, { schema });
  persistence = adapter.createSqliteTaskCorePersistence(
    injectedDrizzle,
    // The runner is the honest synchronous better-sqlite3 shape, bound to the
    // same handle the repositories read through.
    (fn, options) => injectedDrizzle.transaction(fn, {
      behavior: options?.readOnly ? 'deferred' : 'immediate',
    }),
  );
}, 60_000);

afterAll(() => {
  injectedSqlite?.close();
  untouchedSqlite?.close();
  if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = originalDbPath;
});

describe('SQLite task-core composition uses the injected database and runner', () => {
  it('writes and reads the same injected database and leaves another one untouched', async () => {
    insertTask(injectedSqlite, 'injected-task');
    insertTask(untouchedSqlite, 'injected-task');

    // Read path: the composition sees the injected database's row.
    expect(await persistence.moves.taskExists('injected-task')).toBe(true);

    // Write path: the mutation runs through the injected runner, so it lands
    // in the same database the read came from.
    await persistence.lifecycle.deleteTaskLocally({
      taskId: 'injected-task',
      recursive: true,
    });

    expect(countTasks(injectedSqlite, 'injected-task')).toBe(0);
    expect(await persistence.moves.taskExists('injected-task')).toBe(false);
    // No global fallback: the second database never saw the write.
    expect(countTasks(untouchedSqlite, 'injected-task')).toBe(1);
  });

  it('rolls a failed mutation back inside the injected runner', async () => {
    insertTask(injectedSqlite, 'rollback-parent');
    insertTask(injectedSqlite, 'rollback-child');
    injectedSqlite
      .prepare('UPDATE tasks SET parent_id = ?, depth = 1 WHERE id = ?')
      .run('rollback-parent', 'rollback-child');
    injectedSqlite.exec(`
      CREATE TEMP TRIGGER fail_injected_delete
      BEFORE DELETE ON tasks
      WHEN OLD.id = 'rollback-parent'
      BEGIN
        SELECT RAISE(ABORT, 'forced delete failure');
      END;
    `);

    try {
      await expect(persistence.lifecycle.deleteTaskLocally({
        taskId: 'rollback-parent',
        recursive: true,
      })).rejects.toThrow();

      // The child deletion is part of the same injected transaction, so an
      // aborted parent delete must leave the whole subtree intact.
      expect(countTasks(injectedSqlite, 'rollback-parent')).toBe(1);
      expect(countTasks(injectedSqlite, 'rollback-child')).toBe(1);
    } finally {
      injectedSqlite.exec('DROP TRIGGER IF EXISTS fail_injected_delete');
    }
  });

  it('uses the injected runner for the scout hard delete as well', async () => {
    insertTask(injectedSqlite, 'scout-candidate');
    insertTask(untouchedSqlite, 'scout-candidate');

    const outcome = await persistence.scoutDeletion.hardDeleteScoutTask('scout-candidate');

    // A local (non-Scout) task is rejected, but the decision was read through
    // the injected handle rather than a module-level one.
    expect(outcome).toEqual({ kind: 'not-scout' });
    expect(countTasks(injectedSqlite, 'scout-candidate')).toBe(1);
    expect(countTasks(untouchedSqlite, 'scout-candidate')).toBe(1);
  });
});
