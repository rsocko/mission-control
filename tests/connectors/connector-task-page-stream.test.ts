import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const clients = vi.hoisted(() => ({
  microsoft: null as Record<string, ReturnType<typeof vi.fn>> | null,
  github: null as Record<string, unknown> | null,
}));

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => []) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}));

vi.mock('@/db/schema', () => ({
  connectorConfigs: { id: 'id' },
  sourceLists: { connectorInstanceId: 'connectorInstanceId' },
}));

vi.mock('crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('crypto')>(),
  randomUUID: vi.fn(() => 'stream-test-uuid'),
}));

vi.mock('@/lib/connectors/microsoft-todo/graph-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/microsoft-todo/graph-client')>();
  return { ...actual, createGraphClient: vi.fn(() => clients.microsoft) };
});

vi.mock('@/lib/connectors/github-issues/github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/github-issues/github-client')>();
  return { ...actual, createGitHubClient: vi.fn(() => clients.github) };
});

function config(id: string, type: string, settings: Record<string, unknown>): ConnectorConfig {
  return {
    id,
    type,
    name: id,
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 15,
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: true,
      lists: true,
      tags: true,
      tagWriteBack: false,
    },
    credentials: { token: 'test-token' },
    settings,
    syncedLists: [],
  };
}

function graphTask(id: string, title: string) {
  return {
    id,
    title,
    status: 'notStarted',
    importance: 'normal',
    createdDateTime: '2026-08-01T00:00:00Z',
    lastModifiedDateTime: '2026-08-02T00:00:00Z',
    checklistItems: [],
  };
}

function recurringGraphTask(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...graphTask(id, title),
    recurrence: {
      pattern: { type: 'daily', interval: 1 },
      range: { type: 'noEnd', startDate: '2026-08-01' },
    },
    ...overrides,
  };
}

function githubIssue(number: number, title: string) {
  return {
    id: `node-${number}`,
    number,
    title,
    body: '',
    state: 'OPEN',
    stateReason: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    closedAt: null,
    url: `https://github.com/acme/repo/issues/${number}`,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    milestone: null,
    parent: null,
    subIssues: { nodes: [] },
  };
}

describe('connector task page streams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefetches the next Microsoft Todo Graph page without accumulating the list', async () => {
    const graphFetch = vi.fn(async (url: string) => {
      if (url === '/me/todo/lists?$top=100') {
        return new Response(JSON.stringify({ value: [{ id: 'list-1', displayName: 'Tasks' }] }));
      }
      if (url.endsWith('/checklistItems')) {
        return new Response(JSON.stringify({ value: [] }));
      }
      if (url.includes('cursor=page-2')) {
        return new Response(JSON.stringify({ value: [graphTask('task-2', 'Second page')] }));
      }
      return new Response(JSON.stringify({
        value: [graphTask('task-1', 'First page')],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks?cursor=page-2',
      }));
    });
    clients.microsoft = {
      graphFetch,
      substrateFetch: vi.fn(),
    };

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config('todo-1', 'microsoft-todo', {}));

    const iterator = connector.fetchTasks(new Date('2026-08-01T00:00:00Z'));
    const first = await iterator.next();
    expect(first.value?.map(task => task.title)).toEqual(['First page']);
    expect(graphFetch.mock.calls.some(([url]) => (
      String(url).includes('$expand=checklistItems,linkedResources')
    ))).toBe(true);
    expect(graphFetch.mock.calls.filter(([url]) => String(url).includes('/tasks?'))).toHaveLength(2);

    const second = await iterator.next();
    expect(second.value?.map(task => task.title)).toEqual(['Second page']);
    expect(graphFetch.mock.calls.filter(([url]) => String(url).includes('/tasks?'))).toHaveLength(2);
    await iterator.return();
  });

  it('keeps only the latest completed recurring occurrence across pages and passes', async () => {
    const graphFetch = vi.fn(async (url: string) => {
      if (url === '/me/todo/lists?$top=100') {
        return new Response(JSON.stringify({ value: [{ id: 'list-1', displayName: 'Tasks' }] }));
      }
      if (url.includes('cursor=completed-2')) {
        return new Response(JSON.stringify({
          value: [recurringGraphTask('new-completed', 'Daily review', {
            status: 'completed',
            completedDateTime: { dateTime: '2026-08-05T09:00:00Z', timeZone: 'UTC' },
            checklistItems: [{ id: 'new-child', displayName: 'New child', isChecked: true }],
          })],
        }));
      }
      if (url.includes("status eq 'completed'")) {
        return new Response(JSON.stringify({
          value: [recurringGraphTask('old-completed', 'Daily review', {
            status: 'completed',
            completedDateTime: { dateTime: '2026-08-04T09:00:00Z', timeZone: 'UTC' },
            checklistItems: [{ id: 'old-child', displayName: 'Old child', isChecked: true }],
          })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks?cursor=completed-2',
        }));
      }
      return new Response(JSON.stringify({ value: [] }));
    });
    clients.microsoft = { graphFetch, substrateFetch: vi.fn() };

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config('todo-completed', 'microsoft-todo', {}));

    const iterator = connector.fetchTasks();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const selected = await iterator.next();

    expect(selected.value?.map(task => task.sourceId)).toEqual([
      'list-1:new-completed',
      'list-1:new-completed:new-child',
    ]);
    await iterator.return();
  });

  it('applies open recurring occurrence precedence across network pages', async () => {
    const graphFetch = vi.fn(async (url: string) => {
      if (url === '/me/todo/lists?$top=100') {
        return new Response(JSON.stringify({ value: [{ id: 'list-1', displayName: 'Tasks' }] }));
      }
      if (url.endsWith('/checklistItems')) {
        return new Response(JSON.stringify({ value: [] }));
      }
      if (url.includes('cursor=open-2')) {
        return new Response(JSON.stringify({
          value: [recurringGraphTask('nearer-open', 'Daily review', {
            dueDateTime: { dateTime: '2099-01-10T00:00:00', timeZone: 'UTC' },
            lastModifiedDateTime: '2026-08-03T00:00:00Z',
          })],
        }));
      }
      return new Response(JSON.stringify({
        value: [recurringGraphTask('later-open', 'Daily review', {
          dueDateTime: { dateTime: '2099-02-10T00:00:00', timeZone: 'UTC' },
        })],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks?cursor=open-2',
      }));
    });
    clients.microsoft = { graphFetch, substrateFetch: vi.fn() };

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config('todo-open', 'microsoft-todo', {}));

    const iterator = connector.fetchTasks(new Date('2026-08-01T00:00:00Z'));
    await iterator.next();
    await iterator.next();
    const selected = await iterator.next();

    expect(selected.value?.map(task => task.sourceId)).toEqual(['list-1:nearer-open']);
    await iterator.return();
  });

  it('prefetches the next GitHub issues page without accumulating the repository', async () => {
    const graphqlFetch = vi.fn()
      .mockResolvedValueOnce({
        data: {
          repository: {
            id: 'R_repo',
            nameWithOwner: 'acme/repo',
            url: 'https://github.com/acme/repo',
            issues: {
              nodes: [githubIssue(1, 'First page')],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          repository: {
            id: 'R_repo',
            nameWithOwner: 'acme/repo',
            url: 'https://github.com/acme/repo',
            issues: {
              nodes: [githubIssue(2, 'Second page')],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    clients.github = {
      origin: {
        hostKey: 'github.com',
        restBaseUrl: 'https://api.github.com',
        graphqlUrl: 'https://api.github.com/graphql',
      },
      graphqlFetch,
      graphqlFetchAny: vi.fn(async () => ({
        data: {
          repository: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false } } },
          organization: null,
        },
      })),
      restFetch: vi.fn(),
    };

    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config('github-1', 'github-issues', { repos: ['acme/repo'] }));

    const iterator = connector.fetchTasks();
    const first = await iterator.next();
    expect(first.value?.map(task => task.title)).toEqual(['First page']);
    expect(graphqlFetch).toHaveBeenCalledTimes(2);

    const second = await iterator.next();
    expect(second.value?.map(task => task.title)).toEqual(['Second page']);
    expect(graphqlFetch).toHaveBeenCalledTimes(2);
    await iterator.return();
  });
});
