import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type {
  ConnectorConfig,
  HubProject,
  NotificationItem,
  TaskItem,
} from '@/types';

interface CoreRepositoryHarness {
  repositories: CorePersistenceRepositories;
  close(): void;
}

const tag = {
  id: 'tag-portable',
  name: 'Portable',
  slug: 'portable',
  type: 'hub' as const,
  source: undefined,
  color: '#3b82f6',
  confirmed: true,
  createdAt: '2026-08-26T00:00:00.000Z',
};

export const coreTaskFixture: TaskItem = {
  id: 'task-portable',
  sourceId: 'source-task',
  connectorType: 'local',
  connectorInstanceId: 'connector-portable',
  title: 'Portable task',
  description: 'Stored through a contract',
  status: 'todo',
  localDisposition: 'active',
  priority: 'medium',
  planningHorizon: 'soon',
  pushCount: 0,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
  snoozedUntil: null,
  childIds: [],
  depth: 0,
  isChecklistItem: false,
  hubProjectIds: ['project-portable'],
  tags: [tag],
  metadata: { nested: { portable: true } },
  syncStatus: 'synced',
  lastSyncedAt: '2026-08-26T00:01:00.000Z',
  effort: null,
};

export const coreProjectFixture: HubProject = {
  id: 'project-portable',
  name: 'Portable project',
  description: 'Backend-neutral',
  color: '#3b82f6',
  sourceBindings: [{
    connectorInstanceId: 'connector-portable',
    sourceListId: 'list-1',
  }],
  autoIncludeRules: [{ type: 'tag', value: 'portable' }],
  kanbanColumns: [{
    id: 'todo',
    name: 'To do',
    color: '#3b82f6',
    order: 0,
  }],
  defaultView: 'kanban',
  defaultFilters: {
    id: 'portable-filter',
    name: 'Portable',
    filters: { status: ['todo'] },
  },
  status: 'active',
  hidden: false,
  sortOrder: 1,
  metadata: { portable: true },
  tags: [tag],
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
};

export const coreConnectorFixture: ConnectorConfig = {
  id: 'connector-portable',
  type: 'custom-rest',
  name: 'Portable connector',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 15,
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: false,
    tagWriteBack: false,
  },
  credentials: { token: 'contract-test' },
  settings: { nested: { portable: true } },
  syncedLists: ['list-1'],
};

export const coreNotificationFixture: NotificationItem = {
  id: 'notification-portable',
  sourceId: 'source-notification',
  connectorType: 'custom-rest',
  connectorInstanceId: coreConnectorFixture.id,
  title: 'Portable notification',
  body: 'Stored through a contract',
  level: 'fyi',
  levelRank: 3,
  category: 'system',
  templateKey: null,
  state: 'unread',
  readState: 'unread',
  disposition: 'inbox',
  sourceState: 'active',
  syncState: 'synced',
  isActionable: true,
  primaryActionId: 'action-portable',
  aiSuggestedActionId: null,
  receivedAt: '2026-08-26T00:00:00.000Z',
  sortAt: '2026-08-26T00:00:00.000Z',
  metadata: { portable: true },
  presentation: { accent: 'blue' },
  actions: [{
    id: 'action-portable',
    notificationId: 'notification-portable',
    actionType: 'open_url',
    label: 'Open',
    variant: 'primary',
    isPrimary: true,
    sortOrder: 0,
    payload: { url: '/portable' },
    opensExternal: false,
    requiresConfirmation: false,
    createdBy: 'system',
  }],
};

export function describeCorePersistenceRepositoriesContract(
  name: string,
  createHarness: () => CoreRepositoryHarness,
): void {
  describe(`${name} CorePersistenceRepositories contract`, () => {
    let harness: CoreRepositoryHarness;

    beforeEach(() => {
      harness = createHarness();
    });

    afterEach(() => {
      harness.close();
    });

    it('round trips task and project JSON and tag relations', async () => {
      expect(await harness.repositories.tasks.get(coreTaskFixture.id)).toBeNull();
      expect(await harness.repositories.projects.upsert(coreProjectFixture))
        .toEqual(coreProjectFixture);
      expect(await harness.repositories.tasks.upsert(coreTaskFixture))
        .toMatchObject(coreTaskFixture);
      expect(await harness.repositories.tasks.get(coreTaskFixture.id))
        .toMatchObject(coreTaskFixture);
      expect(await harness.repositories.projects.get(coreProjectFixture.id))
        .toEqual(coreProjectFixture);
    });

    it('round trips connector configuration and restores soft-deleted IDs', async () => {
      expect(await harness.repositories.connectors.upsert(coreConnectorFixture))
        .toEqual(coreConnectorFixture);
      await expect(harness.repositories.connectors.delete(coreConnectorFixture.id))
        .resolves.toBe(true);
      await expect(harness.repositories.connectors.get(coreConnectorFixture.id))
        .resolves.toBeNull();
      await expect(harness.repositories.connectors.delete(coreConnectorFixture.id))
        .resolves.toBe(false);
      await expect(harness.repositories.connectors.upsert({
        ...coreConnectorFixture,
        name: 'Restored connector',
      })).resolves.toEqual({
        ...coreConnectorFixture,
        name: 'Restored connector',
      });
    });

    it('merges connector settings and atomically patches nested state', async () => {
      await harness.repositories.connectors.upsert(coreConnectorFixture);

      await expect(harness.repositories.connectors.mergeSettings(
        coreConnectorFixture.id,
        coreConnectorFixture.settings,
        { authenticatedUser: 'octocat' },
      )).resolves.toEqual({
        nested: { portable: true },
        authenticatedUser: 'octocat',
      });
      await expect(harness.repositories.connectors.patchSettingsState(
        coreConnectorFixture.id,
        'checkpoint',
        { cursor: 'page-1', retained: true },
      )).resolves.toMatchObject({
        state: { cursor: 'page-1', retained: true },
      });
      await expect(harness.repositories.connectors.patchSettingsState(
        coreConnectorFixture.id,
        'checkpoint',
        { cursor: undefined },
      )).resolves.toMatchObject({
        state: { retained: true },
      });
      await expect(harness.repositories.connectors.get(coreConnectorFixture.id))
        .resolves.toMatchObject({
          settings: {
            nested: { portable: true },
            authenticatedUser: 'octocat',
            checkpoint: { retained: true },
          },
        });
    });

    it('round trips notification JSON and pending actions', async () => {
      expect(await harness.repositories.notifications.upsert(coreNotificationFixture))
        .toMatchObject(coreNotificationFixture);
      expect(await harness.repositories.notifications.get(coreNotificationFixture.id))
        .toMatchObject(coreNotificationFixture);
    });

    it('sets, replaces, and deletes portable settings values', async () => {
      await expect(harness.repositories.settings.get('portable')).resolves.toBeNull();
      await harness.repositories.settings.set('portable', {
        nested: ['value', 2, true, null],
      });
      await expect(harness.repositories.settings.get('portable')).resolves.toEqual({
        nested: ['value', 2, true, null],
      });
      await harness.repositories.settings.set('portable', 'replaced');
      await expect(harness.repositories.settings.get('portable')).resolves.toBe('replaced');
      await expect(harness.repositories.settings.delete('portable')).resolves.toBe(true);
      await expect(harness.repositories.settings.delete('portable')).resolves.toBe(false);
    });

    it('returns explicit delete outcomes and missing records', async () => {
      await harness.repositories.projects.upsert(coreProjectFixture);
      await harness.repositories.tasks.upsert(coreTaskFixture);
      await harness.repositories.notifications.upsert(coreNotificationFixture);

      await expect(harness.repositories.tasks.delete(coreTaskFixture.id))
        .resolves.toBe(true);
      await expect(harness.repositories.projects.delete(coreProjectFixture.id))
        .resolves.toBe(true);
      await expect(harness.repositories.notifications.delete(coreNotificationFixture.id))
        .resolves.toBe(true);
      await expect(harness.repositories.tasks.delete(coreTaskFixture.id))
        .resolves.toBe(false);
      await expect(harness.repositories.projects.get(coreProjectFixture.id))
        .resolves.toBeNull();
      await expect(harness.repositories.notifications.get(coreNotificationFixture.id))
        .resolves.toBeNull();
    });
  });
}
