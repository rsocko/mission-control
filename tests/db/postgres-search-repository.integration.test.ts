import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresKeywordSearchRepository } from '@/db/postgres/search';
import { createPostgresCoreRepositories } from '@/db/postgres/repositories';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { TaskItem } from '@/types';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL keyword search repository integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-search-repository-test',
          }),
        }
      : {}),
  });
  let repositories: CorePersistenceRepositories;
  let search: PostgresKeywordSearchRepository;
  const taskIds = new Set<string>();
  const notificationIds = new Set<string>();

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    repositories = createPostgresCoreRepositories(backend.context.db);
    search = new PostgresKeywordSearchRepository(backend.context.pool);
  }, 120_000);

  afterAll(async () => {
    for (const id of taskIds) await repositories.tasks.delete(id);
    for (const id of notificationIds) {
      await backend.context.pool.query('DELETE FROM notifications WHERE id = $1', [id]);
    }
    await backend.shutdown();
  });

  async function insertTask(overrides: Partial<TaskItem> & Pick<TaskItem, 'id' | 'title'>) {
    const now = new Date().toISOString();
    const task: TaskItem = {
      sourceId: `source-${overrides.id}`,
      connectorType: 'test',
      connectorInstanceId: 'connector-search-1',
      status: 'todo',
      priority: 'none',
      createdAt: now,
      updatedAt: now,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      hubProjectIds: [],
      tags: [],
      metadata: {},
      syncStatus: 'synced',
      lastSyncedAt: now,
      ...overrides,
    };
    await repositories.tasks.upsert(task);
    taskIds.add(task.id);
    return task;
  }

  async function insertNotification(id: string, title: string) {
    const now = new Date().toISOString();
    await backend.context.pool.query(
      `
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, title, level, level_rank,
          category, state, read_state, disposition, source_state, sync_state, is_actionable,
          received_at, sort_at, metadata, presentation
        ) VALUES ($1, $2, 'test', 'connector-search-1', $3, 'fyi', 3, 'system', 'unread', 'unread',
          'inbox', 'active', 'synced', false, $4, $4, '{}', '{}')
      `,
      [id, `source-${id}`, title, now],
    );
    notificationIds.add(id);
  }

  it('finds a task via the search-document projection after indexTask is called', async () => {
    const uniqueToken = `zzyzxquokka${randomUUID().slice(0, 8)}`;
    const task = await insertTask({
      id: `search-task-${randomUUID()}`,
      title: `Investigate ${uniqueToken} outage`,
      description: 'A description that should also be indexed for search',
      priority: 'high',
    });
    await search.indexTask(task);

    const results = await search.search(uniqueToken, { type: 'tasks' });
    expect(results.some((result) => result.id === task.id)).toBe(true);
    expect(results.find((result) => result.id === task.id)?.highlights?.title).toContain('<mark>');
  });

  it('a task is not findable via search before indexTask is called (no automatic mirroring)', async () => {
    const uniqueToken = `unindexedtoken${randomUUID().slice(0, 8)}`;
    const task = await insertTask({
      id: `search-task-unindexed-${randomUUID()}`,
      title: `Not yet searchable ${uniqueToken}`,
    });

    const results = await search.search(uniqueToken, { type: 'tasks' });
    expect(results.some((result) => result.id === task.id)).toBe(false);
  });

  it('indexTask upserts the searchable projection into task_search_documents without mutating the task row', async () => {
    const originalToken = `originaltoken${randomUUID().slice(0, 8)}`;
    const updatedToken = `updatedtoken${randomUUID().slice(0, 8)}`;
    const task = await insertTask({
      id: `search-task-index-${randomUUID()}`,
      title: `Original ${originalToken} title`,
    });

    await search.indexTask({ id: task.id, title: `Updated ${updatedToken} title` });

    // The domain row is untouched — only the search-document projection changed.
    const reloaded = await repositories.tasks.get(task.id);
    expect(reloaded?.title).toBe(task.title);

    const projection = await backend.context.pool.query(
      'SELECT title FROM task_search_documents WHERE id = $1',
      [task.id],
    );
    expect(projection.rows[0]?.title).toBe(`Updated ${updatedToken} title`);

    const results = await search.search(updatedToken, { type: 'tasks' });
    expect(results.some((result) => result.id === task.id)).toBe(true);
    // The result's title/metadata still reflect the live, unmutated task row.
    expect(results.find((result) => result.id === task.id)?.title).toBe(task.title);
  });

  it('removeTask deletes only the search-document row, leaving the task (and its tag/project links) intact', async () => {
    const task = await insertTask({
      id: `search-task-remove-${randomUUID()}`,
      title: 'Task to be removed from search',
      tags: [
        {
          id: `tag-${randomUUID()}`,
          name: 'Removable',
          slug: 'removable',
          type: 'hub',
          confirmed: true,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await search.indexTask(task);
    const beforeResults = await search.search('Removable OR Task to be removed from search', { type: 'tasks' });
    expect(beforeResults.some((result) => result.id === task.id)).toBe(true);

    await search.removeTask(task.id);

    await expect(repositories.tasks.get(task.id)).resolves.toMatchObject({ id: task.id, title: task.title });
    const tagRows = await backend.context.pool.query('SELECT 1 FROM task_tags WHERE task_id = $1', [task.id]);
    expect(tagRows.rowCount).toBe(1);
    const projectionRows = await backend.context.pool.query(
      'SELECT 1 FROM task_search_documents WHERE id = $1',
      [task.id],
    );
    expect(projectionRows.rowCount).toBe(0);
  });

  it('deleting a task through the core repository cascades to remove its search-document row', async () => {
    const task = await insertTask({
      id: `search-task-cascade-${randomUUID()}`,
      title: 'Task deleted via the core repository',
    });
    await search.indexTask(task);
    taskIds.delete(task.id);

    const beforeDelete = await backend.context.pool.query(
      'SELECT 1 FROM task_search_documents WHERE id = $1',
      [task.id],
    );
    expect(beforeDelete.rowCount).toBe(1);

    await repositories.tasks.delete(task.id);

    const afterDelete = await backend.context.pool.query(
      'SELECT 1 FROM task_search_documents WHERE id = $1',
      [task.id],
    );
    expect(afterDelete.rowCount).toBe(0);
  });

  it('excludes done tasks when excludeDone is set', async () => {
    const uniqueToken = `wibblequonk${randomUUID().slice(0, 8)}`;
    const task = await insertTask({
      id: `search-task-done-${randomUUID()}`,
      title: `Completed ${uniqueToken} cleanup`,
      status: 'done',
    });
    await search.indexTask(task);

    const withDone = await search.search(uniqueToken, { type: 'tasks' });
    expect(withDone.some((result) => result.id === task.id)).toBe(true);

    const withoutDone = await search.search(uniqueToken, { type: 'tasks', excludeDone: true });
    expect(withoutDone.some((result) => result.id === task.id)).toBe(false);
  });

  it('matches a task by its source_list_name/connector_type (ancillary vector fields)', async () => {
    const uniqueListName = `quirkyworkspace${randomUUID().slice(0, 8)}`;
    const task = await insertTask({
      id: `search-task-ancillary-${randomUUID()}`,
      title: 'A task with an otherwise unrelated title',
      sourceListName: uniqueListName,
    });
    await search.indexTask(task);

    const results = await search.search(uniqueListName, { type: 'tasks' });
    expect(results.some((result) => result.id === task.id)).toBe(true);
  });

  it('indexNotification upserts into notification_search_documents without mutating the notification row', async () => {
    const id = `search-notification-${randomUUID()}`;
    await insertNotification(id, 'Original notification title');

    const updatedToken = `notiftoken${randomUUID().slice(0, 8)}`;
    await search.indexNotification({ id, title: `Updated ${updatedToken} notification` });

    const stillOriginal = await backend.context.pool.query('SELECT title FROM notifications WHERE id = $1', [id]);
    expect(stillOriginal.rows[0]?.title).toBe('Original notification title');

    const projection = await backend.context.pool.query(
      'SELECT title FROM notification_search_documents WHERE id = $1',
      [id],
    );
    expect(projection.rows[0]?.title).toBe(`Updated ${updatedToken} notification`);

    const results = await search.search(updatedToken, { type: 'notifications' });
    expect(results.some((result) => result.id === id)).toBe(true);
  });

  it('removeNotification deletes only the search-document row, leaving the notification intact', async () => {
    const id = `search-notification-remove-${randomUUID()}`;
    await insertNotification(id, 'Notification to be removed from search');
    await search.indexNotification({ id, title: 'Notification to be removed from search' });

    await search.removeNotification(id);

    const stillExists = await backend.context.pool.query('SELECT 1 FROM notifications WHERE id = $1', [id]);
    expect(stillExists.rowCount).toBe(1);
    const projectionRows = await backend.context.pool.query(
      'SELECT 1 FROM notification_search_documents WHERE id = $1',
      [id],
    );
    expect(projectionRows.rowCount).toBe(0);
  });

  it('deleting a notification directly cascades to remove its search-document row', async () => {
    const id = `search-notification-cascade-${randomUUID()}`;
    await insertNotification(id, 'Notification deleted directly');
    await search.indexNotification({ id, title: 'Notification deleted directly' });
    notificationIds.delete(id);

    await backend.context.pool.query('DELETE FROM notifications WHERE id = $1', [id]);

    const afterDelete = await backend.context.pool.query(
      'SELECT 1 FROM notification_search_documents WHERE id = $1',
      [id],
    );
    expect(afterDelete.rowCount).toBe(0);
  });

  it('rebuild() backfills the search-document projection from the live core tables', async () => {
    const uniqueToken = `rebuildtoken${randomUUID().slice(0, 8)}`;
    const task = await insertTask({
      id: `search-task-rebuild-${randomUUID()}`,
      title: `Never explicitly indexed ${uniqueToken}`,
    });

    const beforeRebuild = await search.search(uniqueToken, { type: 'tasks' });
    expect(beforeRebuild.some((result) => result.id === task.id)).toBe(false);

    await search.rebuild();

    const afterRebuild = await search.search(uniqueToken, { type: 'tasks' });
    expect(afterRebuild.some((result) => result.id === task.id)).toBe(true);
  });

  it('returns an empty array for a blank query without error', async () => {
    await expect(search.search('   ')).resolves.toEqual([]);
  });

  it('warmUp resolves without throwing', async () => {
    await expect(search.warmUp()).resolves.toBeUndefined();
  });
});
