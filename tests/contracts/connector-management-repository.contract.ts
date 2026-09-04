import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import type {
  ConnectorManagementPersistence,
  CreateManagedConnector,
  SyncHistoryRecord,
} from '@/db/persistence/connector-management';

const PREFIX = 'l11-management';
const NOW = '2026-09-04T04:00:00.000Z';
const CAPABILITIES = {
  read: true,
  write: false,
  delete: false,
  sync: true,
  subtasks: false,
  lists: false,
  tags: false,
  tagWriteBack: false,
} as const;

export interface ConnectorManagementContractHarness {
  enabled?: boolean;
  setup(): Promise<void>;
  reset(): Promise<void>;
  teardown(): Promise<void>;
  repository(): ConnectorManagementPersistence;
  githubIdentityRows(connectorId: string): Promise<{
    controls: number;
    migrations: number;
  }>;
  markWorkTodoIngested(connectorId: string): Promise<void>;
  seedTask(connectorId: string, sourceListId: string): Promise<void>;
  taskSourceListName(connectorId: string): Promise<string | null>;
  seedSyncHistory(records: readonly SyncHistoryRecord[]): Promise<void>;
}

function connector(
  id: string,
  overrides: Partial<CreateManagedConnector> = {},
): CreateManagedConnector {
  return {
    id,
    type: 'test',
    name: id,
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 5,
    capabilities: CAPABILITIES,
    credentials: { token: `${id}-token` },
    settings: { nested: { enabled: true } },
    syncedLists: ['primary'],
    now: NOW,
    ...overrides,
  };
}

function history(
  id: string,
  syncedAt: string,
  overrides: Partial<SyncHistoryRecord> = {},
): SyncHistoryRecord {
  return {
    id,
    connectorId: `${PREFIX}-history`,
    success: true,
    tasksAdded: 1,
    tasksUpdated: 2,
    tasksRemoved: 3,
    tasksPushed: 4,
    localOnlyProtected: 5,
    notificationsAdded: 6,
    errors: [],
    details: [{ id }],
    syncedAt,
    durationMs: 10,
    jobId: null,
    trigger: 'api',
    scheduledFor: null,
    startedAt: null,
    attempt: 1,
    maxAttempts: 3,
    identityMode: null,
    identityModeRevision: null,
    ...overrides,
  };
}

export function runConnectorManagementRepositoryContract(
  name: string,
  harness: ConnectorManagementContractHarness,
): void {
  describe.skipIf(harness.enabled === false)(name, () => {
    beforeAll(() => harness.setup(), 120_000);
    afterEach(() => harness.reset());
    afterAll(() => harness.teardown());

    it('creates idempotently and returns normalized records in deterministic order', async () => {
      const repository = harness.repository();
      await expect(repository.createConnector(connector(`${PREFIX}-b`))).resolves.toBe(true);
      await expect(repository.createConnector(connector(`${PREFIX}-a`, {
        enabled: false,
        capabilities: { ...CAPABILITIES, lists: true },
        settings: { values: [1, 2] },
      }))).resolves.toBe(true);
      await expect(repository.createConnector(connector(`${PREFIX}-a`))).resolves.toBe(false);

      await repository.ensureSourceLists([
        {
          id: `${PREFIX}-list-b`,
          connectorInstanceId: `${PREFIX}-b`,
          sourceId: 'b',
          name: 'B',
          type: 'list',
          taskCount: 0,
          lastSyncedAt: null,
          sortOrder: 1,
          hidden: false,
          icon: null,
          iconColor: null,
        },
        {
          id: `${PREFIX}-list-a`,
          connectorInstanceId: `${PREFIX}-a`,
          sourceId: 'a',
          name: 'A',
          type: 'list',
          taskCount: 0,
          lastSyncedAt: null,
          sortOrder: 0,
          hidden: true,
          icon: null,
          iconColor: null,
        },
      ]);

      const overview = await repository.getOverview(false);
      expect(overview.connectors.filter(({ id }) => id.startsWith(PREFIX)).map(({ id }) => id)).toEqual([
        `${PREFIX}-a`,
        `${PREFIX}-b`,
      ]);
      expect(overview.connectors.find(({ id }) => id === `${PREFIX}-a`)).toMatchObject({
        enabled: false,
        capabilities: { ...CAPABILITIES, lists: true },
        settings: { values: [1, 2] },
        syncedLists: ['primary'],
      });
      const contractLists = overview.sourceLists.filter(({ id }) => id.startsWith(PREFIX));
      expect(contractLists.map(({ id }) => id)).toEqual([
        `${PREFIX}-list-a`,
        `${PREFIX}-list-b`,
      ]);
      expect(contractLists.map(({ hidden }) => hidden)).toEqual([true, false]);
    });

    it('initializes GitHub identity state once in the connector transaction', async () => {
      const repository = harness.repository();
      const id = `${PREFIX}-github`;
      await expect(repository.createConnector(connector(id, {
        type: 'github-issues',
      }))).resolves.toBe(true);
      await expect(repository.createConnector(connector(id, {
        type: 'github-issues',
      }))).resolves.toBe(false);

      await expect(harness.githubIdentityRows(id)).resolves.toEqual({
        controls: 1,
        migrations: 1,
      });
    });

    it('fences stale finance updates with settings and updated-at CAS', async () => {
      const repository = harness.repository();
      const id = `${PREFIX}-finance`;
      await repository.createConnector(connector(id, {
        type: 'finance-manager',
        settings: { householdCurrency: 'USD' },
      }));
      const initial = await repository.getConnector(id);
      expect(initial).not.toBeNull();

      await expect(repository.updateConnector({
        connectorId: id,
        updates: { name: 'Current', settings: { householdCurrency: 'CAD' } },
        now: '2026-09-04T04:01:00.000Z',
        expected: {
          updatedAt: initial!.updatedAt,
          settings: initial!.settings,
        },
      })).resolves.toBe(true);
      await expect(repository.updateConnector({
        connectorId: id,
        updates: { name: 'Stale overwrite' },
        now: '2026-09-04T04:02:00.000Z',
        expected: {
          updatedAt: initial!.updatedAt,
          settings: initial!.settings,
        },
      })).resolves.toBe(false);
      await expect(repository.getConnector(id)).resolves.toMatchObject({
        name: 'Current',
        settings: { householdCurrency: 'CAD' },
      });
    });

    it('prevents changing an initialized Work To Do bridge tier', async () => {
      const repository = harness.repository();
      const id = `${PREFIX}-work-todo`;
      await repository.createConnector(connector(id, {
        type: 'microsoft-todo-work',
        settings: {
          transport: 'power-automate-standard',
          capabilityProfile: 'standard-v1',
        },
      }));
      await repository.ensureWorkTodoBridge({
        connectorId: id,
        transport: 'power-automate-standard',
        capabilityProfile: 'standard-v1',
        now: NOW,
      });
      await harness.markWorkTodoIngested(id);

      await expect(repository.updateWorkTodoConnector({
        connectorId: id,
        updates: { name: 'Must not change' },
        transport: 'power-automate-graph',
        capabilityProfile: 'extended-v1',
        now: '2026-09-04T04:03:00.000Z',
      })).resolves.toBe('tier-conflict');
      await expect(repository.getConnector(id)).resolves.toMatchObject({ name: id });
    });

    it('renames and reorders source lists consistently', async () => {
      const repository = harness.repository();
      const connectorId = `${PREFIX}-lists`;
      await repository.createConnector(connector(connectorId));
      await repository.ensureSourceLists(['a', 'b'].map((suffix, index) => ({
        id: `${PREFIX}-source-${suffix}`,
        connectorInstanceId: connectorId,
        sourceId: suffix,
        name: suffix.toUpperCase(),
        type: 'list',
        taskCount: 0,
        lastSyncedAt: null,
        sortOrder: index,
        hidden: false,
        icon: null,
        iconColor: null,
      })));
      await harness.seedTask(connectorId, 'a');

      await repository.applyLocalSourceListRename({
        sourceListId: `${PREFIX}-source-a`,
        name: 'Local A',
        icon: 'lucide:list',
        iconColor: '#112233',
      });
      await repository.confirmRemoteSourceListRename(`${PREFIX}-source-a`, 'Remote A');
      await repository.reorderSourceLists([
        `${PREFIX}-source-b`,
        `${PREFIX}-source-a`,
      ]);

      await expect(repository.getSourceList(`${PREFIX}-source-a`)).resolves.toMatchObject({
        name: 'Remote A',
        lastKnownRemoteName: 'Remote A',
        userDisplayName: 'Local A',
        icon: 'lucide:list',
        iconColor: '#112233',
      });
      await expect(harness.taskSourceListName(connectorId)).resolves.toBe('Local A');
      const overview = await repository.getOverview(false);
      expect(overview.sourceLists
        .filter(({ id }) => id.startsWith(`${PREFIX}-source-`))
        .map(({ id, sortOrder }) => ({ id, sortOrder }))).toEqual([
        { id: `${PREFIX}-source-b`, sortOrder: 0 },
        { id: `${PREFIX}-source-a`, sortOrder: 1 },
      ]);
    });

    it('returns normalized connector-domain snapshots with stable ordering', async () => {
      const repository = harness.repository();
      const todoId = `${PREFIX}-domain-todo`;
      const githubId = `${PREFIX}-domain-github`;
      await repository.createConnector(connector(todoId, {
        type: 'microsoft-todo',
        settings: { accountType: 'work' },
      }));
      await repository.createConnector(connector(githubId, {
        type: 'github-issues',
        settings: { repos: ['octo/fallback'] },
      }));
      await repository.ensureSourceLists([
        {
          id: `${PREFIX}-domain-list-b`,
          connectorInstanceId: todoId,
          sourceId: 'todo-b',
          name: 'Todo B',
          type: 'list',
          taskCount: 0,
          lastSyncedAt: null,
          sortOrder: 1,
          hidden: false,
          icon: null,
          iconColor: null,
        },
        {
          id: `${PREFIX}-domain-list-a`,
          connectorInstanceId: todoId,
          sourceId: 'todo-a',
          name: 'Todo A',
          type: 'list',
          taskCount: 0,
          lastSyncedAt: null,
          sortOrder: 0,
          hidden: false,
          icon: null,
          iconColor: null,
        },
        {
          id: `${PREFIX}-domain-repo`,
          connectorInstanceId: githubId,
          sourceId: 'octo/repo',
          name: 'Repo',
          type: 'repo',
          taskCount: 0,
          lastSyncedAt: null,
          sortOrder: 0,
          hidden: false,
          icon: null,
          iconColor: null,
        },
      ]);
      await harness.seedTask(todoId, 'todo-a');

      await expect(repository.getConnectorListSnapshot(todoId)).resolves.toMatchObject({
        connector: {
          id: todoId,
          type: 'microsoft-todo',
          settings: { accountType: 'work' },
          syncedLists: ['primary'],
        },
        sourceLists: [
          { id: `${PREFIX}-domain-list-a`, hidden: false },
          { id: `${PREFIX}-domain-list-b`, hidden: false },
        ],
        openTaskCounts: [{ sourceListId: 'todo-a', count: 1 }],
        groups: [],
      });
      await expect(repository.getGitHubRepositorySnapshot()).resolves.toMatchObject({
        connectors: [{
          id: githubId,
          settings: { repos: ['octo/fallback'] },
        }],
        sourceLists: [{
          connectorInstanceId: githubId,
          sourceId: 'octo/repo',
          name: 'Repo',
        }],
      });
      await expect(repository.listActiveConnectorsByType('microsoft-todo'))
        .resolves.toMatchObject([{ id: todoId, enabled: true }]);
      await expect(repository.getMicrosoftTodoHealthSnapshot()).resolves.toMatchObject({
        connectors: [{ id: todoId, enabled: true }],
        sourceLists: [
          { id: `${PREFIX}-domain-list-a` },
          { id: `${PREFIX}-domain-list-b` },
        ],
        taskCounts: [{
          connectorInstanceId: todoId,
          sourceListId: 'todo-a',
          count: 1,
        }],
      });
    });

    it('checkpoints and CAS-finalizes source-list repairs idempotently', async () => {
      const repository = harness.repository();
      const connectorId = `${PREFIX}-repair-connector`;
      const sourceListId = `${PREFIX}-repair-list`;
      const repairId = `${PREFIX}-repair`;
      await repository.createConnector(connector(connectorId, {
        type: 'microsoft-todo',
      }));
      await repository.ensureSourceLists([{
        id: sourceListId,
        connectorInstanceId: connectorId,
        sourceId: 'remote-repair-list',
        name: '😀 Repair me',
        type: 'list',
        taskCount: 0,
        lastSyncedAt: null,
        sortOrder: 0,
        hidden: false,
        icon: null,
        iconColor: null,
      }]);
      const input = {
        id: repairId,
        createdAt: NOW,
        strategy: 'strip-emoji' as const,
        sourceList: (await repository.getSourceList(sourceListId))!,
        newName: 'Repair me',
      };

      await expect(repository.beginSourceListRepair(input)).resolves.toMatchObject({
        replayed: false,
        repair: {
          id: repairId,
          status: 'pending',
          taskSnapshot: [],
          moveResults: [],
          oldListDeleted: false,
        },
      });
      await expect(repository.beginSourceListRepair(input)).resolves.toMatchObject({
        replayed: true,
        repair: { id: repairId },
      });
      await expect(repository.checkpointSourceListRepair({
        id: repairId,
        status: 'running',
        taskSnapshot: [{ id: 'task-1', title: 'Task', status: 'notStarted' }],
        moveResults: [{
          taskId: 'task-1',
          title: 'Task',
          status: 'notStarted',
          newTaskId: 'new-task-1',
          success: true,
        }],
      })).resolves.toBe(true);
      await expect(repository.finalizeSourceListRepair({
        strategy: 'strip-emoji',
        id: repairId,
        sourceListId,
        expectedOriginalName: '😀 Repair me',
        newName: 'Repair me',
      })).resolves.toBe('completed');
      await expect(repository.finalizeSourceListRepair({
        strategy: 'strip-emoji',
        id: repairId,
        sourceListId,
        expectedOriginalName: '😀 Repair me',
        newName: 'Repair me',
      })).resolves.toBe('replayed');
      await expect(repository.getSourceListRepair(repairId)).resolves.toMatchObject({
        status: 'completed',
        taskSnapshot: [{ id: 'task-1', title: 'Task', status: 'notStarted' }],
        moveResults: [{ taskId: 'task-1', success: true }],
        tasksTotal: 1,
        tasksMoved: 1,
        tasksFailed: 0,
      });
      await expect(repository.getSourceList(sourceListId)).resolves.toMatchObject({
        name: 'Repair me',
        lastKnownRemoteName: 'Repair me',
      });
    });

    it('upserts rankings and returns stable rank/id ordering', async () => {
      const repository = harness.repository();
      const written = await repository.putSourceRankings([
        {
          id: `${PREFIX}-ranking-b`,
          connectorType: 'b',
          name: 'Beta',
          rank: 1,
        },
        {
          id: `${PREFIX}-ranking-a`,
          connectorType: 'a',
          name: 'Alpha',
          rank: 1,
        },
      ], NOW);
      expect(written.filter(({ id }) => id.startsWith(PREFIX))).toMatchObject([
        { id: `${PREFIX}-ranking-a`, name: 'Alpha', rank: 1 },
        { id: `${PREFIX}-ranking-b`, name: 'Beta', rank: 1 },
      ]);
      await repository.putSourceRankings([
        { id: `${PREFIX}-ranking-b`, rank: 0 },
      ], '2026-09-04T04:04:00.000Z');
      const updated = await repository.listSourceRankings();
      expect(updated.filter(({ id }) => id.startsWith(PREFIX))).toMatchObject([
        { id: `${PREFIX}-ranking-b`, name: 'Beta', rank: 0 },
        { id: `${PREFIX}-ranking-a`, name: 'Alpha', rank: 1 },
      ]);
    });

    it('pages normalized sync history with an exclusive cursor', async () => {
      const repository = harness.repository();
      await harness.seedSyncHistory([
        history(`${PREFIX}-history-1`, '2099-09-04T01:00:00.000Z'),
        history(`${PREFIX}-history-2`, '2099-09-04T02:00:00.000Z', {
          success: false,
          errors: ['failed'],
        }),
        history(`${PREFIX}-history-3`, '2099-09-04T03:00:00.000Z'),
        history(`${PREFIX}-history-4`, '2099-09-04T04:00:00.000Z'),
      ]);

      const first = await repository.listSyncHistory({ limit: 2, before: null });
      expect(first.hasMore).toBe(true);
      expect(first.history.map(({ id }) => id)).toEqual([
        `${PREFIX}-history-4`,
        `${PREFIX}-history-3`,
      ]);

      const second = await repository.listSyncHistory({
        limit: 1,
        before: first.history[1].syncedAt,
      });
      expect(second).toMatchObject({
        hasMore: true,
        history: [{
          id: `${PREFIX}-history-2`,
          success: false,
          errors: ['failed'],
          details: [{ id: `${PREFIX}-history-2` }],
        }],
      });
    });
  });
}
