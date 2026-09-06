/**
 * Poisoned-SQLite proof for the five operational-utility routes and the
 * public-demo runtime PR 2 owns. Both SQLite modules throw on evaluation, so
 * importing or calling any of these handlers with a PostgreSQL-shaped
 * `OperationalUtilityPersistence` fails loudly if a route ever reaches back
 * into `@/db`. Connector leasing, local task lifecycle, AI provider
 * configuration, and demo seeding are mocked at their own neutral boundaries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BugReportCommand,
  OperationalUtilityPersistence,
} from '@/db/persistence/operational-utility';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const calls = vi.hoisted(() => ({
  deleteTaskLocally: vi.fn(async () => undefined),
  resetDemoDatabase: vi.fn(async () => undefined),
  updateSettings: vi.fn(),
  bugReports: [] as BugReportCommand[],
  bugReportFailure: { error: null as Error | null },
}));

vi.mock('@/lib/tasks/local-task-lifecycle', () => ({
  deleteTaskLocally: calls.deleteTaskLocally,
}));
vi.mock('@/lib/sync/connector-lock', () => ({
  ConnectorOperationBusyError: class extends Error {},
  runWithConnectorOperationLease: async <T>(
    _connectorId: string,
    _operation: string,
    run: () => Promise<T>,
  ) => run(),
}));
vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration: async () => ({
    saved: null,
    resolved: {
      configured: true,
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
    },
    routingPolicy: null,
  }),
}));
vi.mock('@/lib/seed-api', () => ({ resetDemoDatabase: calls.resetDemoDatabase }));
vi.mock('@/lib/mode', () => ({
  updateSettings: calls.updateSettings,
  getTimezone: () => 'UTC',
}));
vi.mock('server-only', () => ({}));

const postgresShaped: OperationalUtilityPersistence = {
  retainedSourceLists: {
    loadSnapshot: async ({ sourceListId }) => ({
      connector: {
        id: 'connector-1',
        type: 'github-issues',
        settings: { repos: ['other/repo'] },
        syncedLists: [],
      },
      sourceList: {
        id: sourceListId,
        sourceId: 'octo/repo',
      },
    }),
    listRetainedTaskIds: async () => ['task-1', 'task-2'],
    deleteSourceList: async () => undefined,
  },
  maintenance: {
    runDuplicateCleanup: async () => ({
      duplicateGroupsFound: 2,
      tasksRemoved: 3,
      recurringInstancesRemoved: 2,
      openRecurringInstancesRemoved: 1,
    }),
  },
  exports: {
    listTasksPage: async () => [{ id: 'task-1', title: 'Exported', status: 'todo' }],
    listNotificationsPage: async () => [],
    listTagsPage: async () => [],
    listTaskTagsPage: async () => [],
    listHubProjectsPage: async () => [],
    listConnectorsPage: async () => [],
    listSyncLogPage: async () => [],
  },
  features: {
    listActiveConnectors: async () => [{
      id: 'connector-1',
      type: 'github-issues',
      name: 'GitHub',
      capabilities: { write: true },
      settings: { accountType: 'work' },
    }],
  },
  bugReports: {
    create: async (command) => {
      if (calls.bugReportFailure.error) throw calls.bugReportFailure.error;
      calls.bugReports.push(command);
      return { taskId: command.task.id, tagIds: command.tags.map((tag) => tag.newTagId) };
    },
  },
  publicDemo: {
    ensureReady: async () => undefined,
    markSeeded: async () => undefined,
  },
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ operationalUtility: postgresShaped }),
}));

const BASE = 'http://localhost:3099';
function request(path: string, init?: RequestInit) {
  return new Request(`${BASE}${path}`, {
    headers: {
      host: 'localhost:3099',
      origin: BASE,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    ...init,
  });
}

describe('poisoned-SQLite operational utility routes', () => {
  beforeEach(() => {
    calls.bugReports.length = 0;
    calls.bugReportFailure.error = null;
    delete process.env.MC_BUG_SNAP_KEY;
    delete process.env.MC_TRIAGE_CAPTURE_KEY;
    vi.clearAllMocks();
  });

  it('purges a retained source list without importing the SQLite modules', async () => {
    const route = await import('@/app/api/connectors/[id]/retained-lists/[sourceListId]/route');

    const response = await route.DELETE(
      request('/api/connectors/connector-1/retained-lists/list-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'connector-1', sourceListId: 'list-1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      sourceListId: 'list-1',
      deletedTasks: 2,
      writeBack: 'none',
    });
    expect(calls.deleteTaskLocally).toHaveBeenCalledTimes(2);
  });

  it('runs maintenance cleanup through the port', async () => {
    const route = await import('@/app/api/sync/cleanup/route');

    const response = await route.POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      duplicateGroupsFound: 2,
      tasksRemoved: 3,
      recurringInstancesRemoved: 2,
      openRecurringInstancesRemoved: 1,
    });
  });

  it('streams an export from PostgreSQL-shaped pages', async () => {
    const route = await import('@/app/api/export/route');

    const response = await route.GET(request('/api/export?type=tasks&format=json'));

    expect(response.status).toBe(200);
    const payload = JSON.parse(await response.text());
    expect(payload.tasks).toEqual([{ id: 'task-1', title: 'Exported', status: 'todo' }]);
  });

  it('builds feature flags from the connector snapshot', async () => {
    const route = await import('@/app/api/features/route');

    const response = await route.GET();

    expect(response.status).toBe(200);
    const flags = await response.json();
    expect(flags.taskCreation).toBe(true);
    expect(flags.aiEnabled).toBe(true);
    expect(flags.enabledSources.map((source: { type: string }) => source.type))
      .toEqual(['local', 'github-issues']);
  });

  it('creates a bug report transactionally', async () => {
    const route = await import('@/app/api/bug-report/route');

    const response = await route.POST(request('/api/bug-report', {
      method: 'POST',
      body: JSON.stringify({ title: 'Broken export', app: 'Mission Control' }),
    }));

    expect(response.status).toBe(201);
    expect(calls.bugReports).toHaveLength(1);
    expect(calls.bugReports[0]).toMatchObject({
      task: {
        connectorInstanceId: 'bug-snap',
        connectorType: 'local',
        priority: 'none',
        status: 'todo',
        title: '🐛 Broken export',
      },
    });
    expect(calls.bugReports[0].tags.map((tag) => tag.slug)).toEqual([
      'bug',
      'app-mission-control',
    ]);
  });

  it('preserves bug-report validation, authentication, CORS, and failure responses', async () => {
    const route = await import('@/app/api/bug-report/route');

    const invalid = await route.POST(request('/api/bug-report', {
      method: 'POST',
      body: JSON.stringify({ title: '   ' }),
    }));
    expect(invalid.status).toBe(400);
    expect(calls.bugReports).toHaveLength(0);

    process.env.MC_BUG_SNAP_KEY = 'secret';
    const denied = await route.POST(request('/api/bug-report', {
      method: 'POST',
      body: JSON.stringify({ title: 'Denied' }),
    }));
    expect(denied.status).toBe(401);

    const allowed = await route.POST(request('/api/bug-report', {
      method: 'POST',
      headers: {
        host: 'localhost:3099',
        origin: BASE,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-bug-snap-key': 'secret',
      },
      body: JSON.stringify({ title: 'Allowed', severity: 'medium' }),
    }));
    expect(allowed.status).toBe(201);
    expect(calls.bugReports.at(-1)?.task.priority).toBe('medium');

    calls.bugReportFailure.error = new Error('rollback');
    const failed = await route.POST(request('/api/bug-report', {
      method: 'POST',
      headers: {
        host: 'localhost:3099',
        origin: BASE,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-bug-snap-key': 'secret',
      },
      body: JSON.stringify({ title: 'Fails' }),
    }));
    expect(failed.status).toBe(500);
    expect(failed.headers.get('access-control-allow-origin')).toBe('*');

    const preflight = await route.OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  });

  it('initializes public demo data without direct SQLite access', async () => {
    const { initializePublicDemoData } = await import('@/lib/public-demo-runtime');

    await initializePublicDemoData();

    expect(calls.resetDemoDatabase).toHaveBeenCalledTimes(1);
    expect(calls.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'demo' }),
    );
  });
});
