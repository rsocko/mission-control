import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteNotificationEntityLinkingRepository,
} from '@/db/persistence/sqlite-notification-entity-linking-repository';

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      connector_instance_id TEXT NOT NULL,
      source_id TEXT NOT NULL
    );
    CREATE TABLE hub_projects (
      id TEXT PRIMARY KEY,
      metadata TEXT NOT NULL
    );
  `);
});

afterEach(() => sqlite.close());

describe('SQLite notification entity-linking repository', () => {
  it('resolves exact and suffixed task references plus repository projects', async () => {
    sqlite.prepare(
      'INSERT INTO tasks (id, connector_instance_id, source_id) VALUES (?, ?, ?)',
    ).run('task-exact', 'connector-1', 'owner/repo:42');
    sqlite.prepare(
      'INSERT INTO tasks (id, connector_instance_id, source_id) VALUES (?, ?, ?)',
    ).run('task-suffix', 'connector-1', 'prefix:owner/repo:43');
    sqlite.prepare(
      'INSERT INTO hub_projects (id, metadata) VALUES (?, ?)',
    ).run('project-1', JSON.stringify({ repository: 'owner/repo' }));
    const repository = createSqliteNotificationEntityLinkingRepository(sqlite);

    await expect(repository.findTaskBySourceReference({
      connectorInstanceId: 'connector-1',
      repository: 'owner/repo',
      number: 42,
    })).resolves.toEqual({ id: 'task-exact' });
    await expect(repository.findTaskBySourceReference({
      connectorInstanceId: 'connector-1',
      repository: 'owner/repo',
      number: 43,
    })).resolves.toEqual({ id: 'task-suffix' });
    await expect(
      repository.findProjectByRepository('owner/repo'),
    ).resolves.toBe('project-1');
    await expect(repository.findTaskBySourceReference({
      connectorInstanceId: 'connector-1',
      repository: 'missing/repo',
      number: 44,
    })).resolves.toBeNull();
  });

  it('returns null rather than choosing an ambiguous fallback', async () => {
    sqlite.prepare(
      'INSERT INTO tasks (id, connector_instance_id, source_id) VALUES (?, ?, ?)',
    ).run('task-a', 'connector-1', 'a:owner/repo:42');
    sqlite.prepare(
      'INSERT INTO tasks (id, connector_instance_id, source_id) VALUES (?, ?, ?)',
    ).run('task-b', 'connector-1', 'b:owner/repo:42');
    const repository = createSqliteNotificationEntityLinkingRepository(sqlite);

    await expect(repository.findTaskBySourceReference({
      connectorInstanceId: 'connector-1',
      repository: 'owner/repo',
      number: 42,
    })).resolves.toBeNull();
  });
});
