import { describe, expect, it, vi } from 'vitest';
import { MicrosoftTodoConnector } from '@/lib/connectors/microsoft-todo';

const replaceCheckpoints = vi.fn(async () => undefined);

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: vi.fn(async () => ({
    connectorState: {
      taskDelta: {
        replace: replaceCheckpoints,
      },
    },
  })),
}));

function graphTask(id: string) {
  return {
    id,
    title: `Task ${id}`,
    status: 'notStarted',
    importance: 'normal',
    createdDateTime: '2026-10-15T12:00:00Z',
    lastModifiedDateTime: '2026-10-15T13:00:00Z',
  };
}

type TestConnector = {
  id: string;
  client: {
    graphFetch: ReturnType<typeof vi.fn>;
  };
  pendingTaskDeltaLinks: Map<string, string>;
  fetchTasksFromList(
    listId: string,
    listName: string,
    since?: Date,
    wellKnownListName?: string,
  ): AsyncGenerator<unknown[], void, unknown>;
};

describe('Microsoft To Do delta enrichment', () => {
  it('batches checklist reads and does not fetch linked resources for ordinary tasks', async () => {
    const graphFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [graphTask('task-1'), graphTask('task-2')],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-token',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        responses: [
          { id: 'checklist-0', status: 200, body: { value: [] } },
          { id: 'checklist-1', status: 200, body: { value: [] } },
        ],
      }), { status: 200 }));
    const connector = new MicrosoftTodoConnector() as unknown as TestConnector;
    connector.id = 'todo-1';
    connector.client = { graphFetch };

    const pages = [];
    for await (const page of connector.fetchTasksFromList('list-1', 'Tasks')) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(graphFetch).toHaveBeenCalledTimes(2);
    expect(graphFetch.mock.calls[1]?.[0]).toBe('/$batch');
    const batchBody = JSON.parse(String(graphFetch.mock.calls[1]?.[1]?.body));
    expect(batchBody.requests).toHaveLength(2);
    expect(batchBody.requests.every((request: { url: string }) =>
      request.url.endsWith('/checklistItems'),
    )).toBe(true);
  });

  it('falls back for a failed checklist subrequest instead of dropping checklist data', async () => {
    const graphFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [graphTask('task-1')],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-token',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        responses: [
          { id: 'checklist-0', status: 503, body: {} },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{
          id: 'item-1',
          displayName: 'Checklist item',
          isChecked: false,
          createdDateTime: '2026-10-15T12:30:00Z',
        }],
      }), { status: 200 }));
    const connector = new MicrosoftTodoConnector() as unknown as TestConnector;
    connector.id = 'todo-1';
    connector.client = { graphFetch };

    const pages = [];
    for await (const page of connector.fetchTasksFromList('list-1', 'Tasks')) {
      pages.push(page);
    }

    expect(pages[0]).toHaveLength(2);
    expect(graphFetch.mock.calls[2]?.[0]).toContain('/checklistItems');
  });

  it('commits unaffected list checkpoints while retaining a conflicted list checkpoint', async () => {
    replaceCheckpoints.mockClear();
    const connector = new MicrosoftTodoConnector() as unknown as TestConnector & {
      deferTaskFetchCheckpoints(sourceListIds: readonly string[]): void;
      commitTaskFetch(): Promise<void>;
    };
    connector.id = 'todo-1';
    connector.pendingTaskDeltaLinks.set('list-1', 'delta-1');
    connector.pendingTaskDeltaLinks.set('list-2', 'delta-2');
    connector.deferTaskFetchCheckpoints(['list-2']);

    await connector.commitTaskFetch();

    expect(replaceCheckpoints).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: 'todo-1',
      checkpoints: [{ listSourceId: 'list-1', deltaLink: 'delta-1' }],
    }));
  });
});
