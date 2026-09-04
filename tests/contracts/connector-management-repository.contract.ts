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
