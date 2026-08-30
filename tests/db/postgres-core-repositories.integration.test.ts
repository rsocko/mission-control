import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresCoreRepositories } from '@/db/postgres/repositories';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import { notificationActions } from '@/db/postgres/schema';
import type { ConnectorConfig, HubProject, NotificationItem, TaskItem } from '@/types';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import { eq } from 'drizzle-orm';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL core repositories integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-core-repositories-test',
          }),
        }
      : {}),
  });
  let repositories: CorePersistenceRepositories;
  const cleanupIds = {
    tasks: new Set<string>(),
    projects: new Set<string>(),
    connectors: new Set<string>(),
    notifications: new Set<string>(),
    settings: new Set<string>(),
  };

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    repositories = createPostgresCoreRepositories(backend.context.db);
  }, 120_000);

  afterAll(async () => {
    for (const id of cleanupIds.tasks) await repositories.tasks.delete(id);
    for (const id of cleanupIds.projects) await repositories.projects.delete(id);
    for (const id of cleanupIds.connectors) await repositories.connectors.delete(id);
    for (const id of cleanupIds.notifications) await repositories.notifications.delete(id);
    for (const id of cleanupIds.settings) await repositories.settings.delete(id);
    await backend.shutdown();
  });

  it('returns null for a task that does not exist', async () => {
    await expect(repositories.tasks.get(`missing-${randomUUID()}`)).resolves.toBeNull();
  });

  it('round-trips a task including its tags, hub project links, and derived child ids', async () => {
    const projectId = `project-${randomUUID()}`;
    const project: HubProject = {
      id: projectId,
      name: 'Integration project',
      color: '#3b82f6',
      sourceBindings: [],
      autoIncludeRules: [],
      kanbanColumns: [],
      defaultView: 'list',
      status: 'active',
      sortOrder: 0,
      metadata: {},
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repositories.projects.upsert(project);
    cleanupIds.projects.add(projectId);

    const parentId = `task-${randomUUID()}`;
    const now = '2025-01-02T03:04:05.000Z';
    const parent: TaskItem = {
      id: parentId,
      sourceId: 'source-1',
      connectorType: 'test',
      connectorInstanceId: 'connector-1',
      title: 'Parent task',
      status: 'todo',
      priority: 'none',
      createdAt: now,
      updatedAt: now,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      hubProjectIds: [projectId],
      tags: [
        {
          id: `tag-${randomUUID()}`,
          name: 'Integration',
          slug: 'integration',
          type: 'hub',
          confirmed: true,
          createdAt: now,
        },
      ],
      metadata: {},
      syncStatus: 'synced',
      lastSyncedAt: now,
    };
    const savedParent = await repositories.tasks.upsert(parent);
    cleanupIds.tasks.add(parentId);

    expect(savedParent.hubProjectIds).toEqual([projectId]);
    expect(savedParent.tags).toHaveLength(1);
    expect(savedParent.tags[0]?.name).toBe('Integration');
    expect(savedParent.childIds).toEqual([]);
    expect(savedParent.updatedAt).toBe(now);

    const childId = `task-${randomUUID()}`;
    const child: TaskItem = {
      ...parent,
      id: childId,
      title: 'Child task',
      sourceId: 'source-2',
      parentId,
      hubProjectIds: [],
      tags: [],
    };
    await repositories.tasks.upsert(child);
    cleanupIds.tasks.add(childId);

    const reloadedParent = await repositories.tasks.get(parentId);
    expect(reloadedParent?.childIds).toEqual([childId]);

    // Re-upserting with an empty tag/project set fully replaces the relation.
    const cleared = await repositories.tasks.upsert({
      ...savedParent,
      hubProjectIds: [],
      tags: [],
    });
    expect(cleared.hubProjectIds).toEqual([]);
    expect(cleared.tags).toEqual([]);

    expect(await repositories.tasks.delete(childId)).toBe(true);
    cleanupIds.tasks.delete(childId);
    expect(await repositories.tasks.delete(childId)).toBe(false);
  });

  it('round-trips a hub project including its tags', async () => {
    const projectId = `project-${randomUUID()}`;
    const now = '2025-02-03T04:05:06.000Z';
    const project: HubProject = {
      id: projectId,
      name: 'Tagged project',
      color: '#3b82f6',
      sourceBindings: [],
      autoIncludeRules: [],
      kanbanColumns: [],
      defaultView: 'kanban',
      status: 'active',
      sortOrder: 1,
      metadata: { note: 'integration' },
      tags: [
        {
          id: `tag-${randomUUID()}`,
          name: 'Tagged',
          slug: 'tagged',
          type: 'hub',
          confirmed: true,
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const saved = await repositories.projects.upsert(project);
    cleanupIds.projects.add(projectId);

    expect(saved.tags).toHaveLength(1);
    expect(saved.updatedAt).toBe(now);
    const fetched = await repositories.projects.get(projectId);
    expect(fetched?.name).toBe('Tagged project');
    expect(fetched?.tags[0]?.slug).toBe('tagged');

    expect(await repositories.projects.delete(projectId)).toBe(true);
    cleanupIds.projects.delete(projectId);
  });

  it('soft-deletes connectors and excludes them from get()', async () => {
    const connectorId = `connector-${randomUUID()}`;
    const connector: ConnectorConfig = {
      id: connectorId,
      type: 'test',
      name: 'Integration connector',
      enabled: true,
      syncMode: 'poll',
      capabilities: {
        read: true,
        write: true,
        delete: true,
        sync: true,
        subtasks: false,
        lists: false,
        tags: false,
        tagWriteBack: false,
      },
      credentials: {},
      settings: {},
      syncedLists: [],
    };
    await repositories.connectors.upsert(connector);
    cleanupIds.connectors.add(connectorId);

    expect(await repositories.connectors.get(connectorId)).toMatchObject({ name: 'Integration connector' });
    expect(await repositories.connectors.delete(connectorId)).toBe(true);
    expect(await repositories.connectors.get(connectorId)).toBeNull();
    // Deleting an already soft-deleted connector reports no change.
    expect(await repositories.connectors.delete(connectorId)).toBe(false);

    // Upserting again revives it (clears deleted_at).
    await repositories.connectors.upsert(connector);
    expect(await repositories.connectors.get(connectorId)).not.toBeNull();
  });

  it('merges and atomically patches connector settings', async () => {
    const connectorId = `connector-${randomUUID()}`;
    const connector: ConnectorConfig = {
      id: connectorId,
      type: 'test',
      name: 'Settings connector',
      enabled: true,
      syncMode: 'poll',
      capabilities: {
        read: true,
        write: true,
        delete: true,
        sync: true,
        subtasks: false,
        lists: false,
        tags: false,
        tagWriteBack: false,
      },
      credentials: {},
      settings: { retained: true },
      syncedLists: [],
    };
    await repositories.connectors.upsert(connector);
    cleanupIds.connectors.add(connectorId);

    await repositories.connectors.mergeSettings(
      connectorId,
      connector.settings,
      { authenticatedUser: 'octocat' },
    );
    await Promise.all([
      repositories.connectors.patchSettingsState(
        connectorId,
        'checkpoint',
        { cursor: 'page-1' },
      ),
      repositories.connectors.patchSettingsState(
        connectorId,
        'checkpoint',
        { retained: true },
      ),
    ]);
    await expect(repositories.connectors.get(connectorId)).resolves.toMatchObject({
      settings: {
        retained: true,
        authenticatedUser: 'octocat',
        checkpoint: { cursor: 'page-1', retained: true },
      },
    });
  });

  it('hydrates notification actions on read and only writes them when provided', async () => {
    const notificationId = `notification-${randomUUID()}`;
    const now = new Date().toISOString();
    const notification: NotificationItem = {
      id: notificationId,
      sourceId: 'source-1',
      connectorType: 'test',
      connectorInstanceId: 'connector-1',
      title: 'Integration notification',
      level: 'fyi',
      levelRank: 3,
      category: 'system',
      state: 'unread',
      readState: 'unread',
      disposition: 'inbox',
      sourceState: 'active',
      syncState: 'synced',
      isActionable: true,
      receivedAt: now,
      sortAt: now,
      metadata: {},
      presentation: {},
      actions: [
        {
          id: `action-${randomUUID()}`,
          notificationId,
          actionType: 'dismiss',
          label: 'Dismiss',
          variant: 'secondary',
          isPrimary: false,
          sortOrder: 0,
          payload: {},
          opensExternal: false,
          requiresConfirmation: false,
          createdBy: 'system',
        },
      ],
    };
    const saved = await repositories.notifications.upsert(notification);
    cleanupIds.notifications.add(notificationId);
    expect(saved.actions).toHaveLength(1);

    // Upsert without `actions` must leave the existing action row untouched.
    const withoutActions: NotificationItem = { ...notification };
    delete withoutActions.actions;
    const updated = await repositories.notifications.upsert(withoutActions);
    expect(updated.actions).toHaveLength(1);

    const actionId = notification.actions![0].id;
    await backend.context.db.update(notificationActions)
      .set({ executionState: 'completed', completedAt: now })
      .where(eq(notificationActions.id, actionId));
    const afterCompletion = await repositories.notifications.upsert({
      ...notification,
      actions: [],
    });
    expect(afterCompletion.actions).toEqual([]);
    const [completedAction] = await backend.context.db.select()
      .from(notificationActions)
      .where(eq(notificationActions.id, actionId));
    expect(completedAction?.executionState).toBe('completed');

    expect(await repositories.notifications.delete(notificationId)).toBe(true);
    cleanupIds.notifications.delete(notificationId);
  });

  it('round-trips arbitrary JSON settings values and reports deletion', async () => {
    const key = `integration-setting-${randomUUID()}`;
    await repositories.settings.set(key, { nested: { value: 1 }, list: [1, 2, 3] });
    cleanupIds.settings.add(key);

    await expect(repositories.settings.get(key)).resolves.toEqual({
      nested: { value: 1 },
      list: [1, 2, 3],
    });

    expect(await repositories.settings.delete(key)).toBe(true);
    cleanupIds.settings.delete(key);
    expect(await repositories.settings.delete(key)).toBe(false);
    await expect(repositories.settings.get(key)).resolves.toBeNull();
  });
});
