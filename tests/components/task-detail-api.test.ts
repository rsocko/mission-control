import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addTaskTags,
  addTaskToProject,
  buildTagsUrl,
  deleteTask,
  deriveConnectorSupport,
  fetchConnectorSupport,
  fetchDuplicateCandidates,
  fetchHubProjects,
  fetchMicroStatusSuggestion,
  fetchTagOptions,
  fetchTaskDetail,
  fetchWritableConnectors,
  isLocalTaskSource,
  patchTask,
  removeTaskFromProject,
  removeTaskTag,
  runOptimisticMutation,
  setMyDayMembership,
} from '@/components/task-detail/task-detail-api';

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as unknown as Response;
}

function stubFetch(handler: (input: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => (
    Promise.resolve(handler(String(input), init))
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('task detail data requests', () => {
  it('returns the task record and null when the API omits it', async () => {
    stubFetch((input) => (
      input === '/api/tasks/task-1'
        ? jsonResponse({ task: { id: 'task-1', title: 'Ship it' } })
        : jsonResponse({})
    ));

    await expect(fetchTaskDetail('task-1')).resolves.toMatchObject({ id: 'task-1' });
    await expect(fetchTaskDetail('task-2')).resolves.toBeNull();
  });

  it('reads duplicates, hub projects, and writable connectors defensively', async () => {
    stubFetch((input) => {
      if (input.startsWith('/api/tasks/detect-duplicates')) return jsonResponse({});
      if (input.startsWith('/api/hub-projects')) return jsonResponse({ projects: [{ id: 'p1' }] });
      if (input === '/api/connectors') {
        return jsonResponse({
          connectors: [
            { id: 'c1', type: 'local', name: 'Local', capabilities: { taskCreate: true } },
            { id: 'c2', type: 'readonly', name: 'Read only', capabilities: {} },
          ],
        });
      }
      return jsonResponse({});
    });

    await expect(fetchDuplicateCandidates('task-1')).resolves.toEqual([]);
    await expect(fetchHubProjects()).resolves.toEqual([{ id: 'p1' }]);
    await expect(fetchWritableConnectors()).resolves.toEqual([
      { id: 'c1', type: 'local', name: 'Local' },
    ]);
  });

  it('matches only the requested task when reading micro-status suggestions', async () => {
    stubFetch(() => jsonResponse({
      suggestions: [
        { taskId: 'other', suggestedStatus: 'blocked', reason: 'nope' },
        { taskId: 'task-1', suggestedStatus: 'waiting', reason: 'Waiting on review' },
      ],
    }));

    await expect(fetchMicroStatusSuggestion('task-1')).resolves.toEqual({
      status: 'waiting',
      reason: 'Waiting on review',
    });
  });

  it('returns no suggestion when the endpoint fails', async () => {
    stubFetch(() => jsonResponse({}, false));

    await expect(fetchMicroStatusSuggestion('task-1')).resolves.toBeNull();
  });
});

describe('connector support derivation', () => {
  it('treats local connectors and local source ids as local', () => {
    expect(isLocalTaskSource({ connectorType: 'local', sourceId: null })).toBe(true);
    expect(isLocalTaskSource({ connectorType: 'github-issues', sourceId: 'local:1' })).toBe(true);
    expect(isLocalTaskSource({ connectorType: 'github-issues', sourceId: 'gh:1' })).toBe(false);
  });

  it('falls back to local support when the connector reports nothing', () => {
    expect(deriveConnectorSupport(undefined, true)).toEqual({
      connectorCaps: null,
      supportsAttachments: true,
      supportsSubtasks: true,
    });
    expect(deriveConnectorSupport(undefined, false)).toEqual({
      connectorCaps: null,
      supportsAttachments: false,
      supportsSubtasks: false,
    });
  });

  it('defaults tag creation mode and scope when the connector omits them', () => {
    expect(deriveConnectorSupport({ tagWriteBack: 1, attachments: true }, false)).toEqual({
      connectorCaps: { tagWriteBack: true, tagCreationMode: 'freeform', tagScope: 'global' },
      supportsAttachments: true,
      supportsSubtasks: false,
    });
  });

  it('reads capabilities for the connector instance owning the task', async () => {
    stubFetch(() => jsonResponse({
      taskDestinations: [
        { id: 'other', capabilities: { attachments: true } },
        { id: 'inst-1', capabilities: { tagCreationMode: 'predefined', tagScope: 'per-list', subtasks: true } },
      ],
    }));

    await expect(fetchConnectorSupport('inst-1', false)).resolves.toEqual({
      connectorCaps: { tagWriteBack: false, tagCreationMode: 'predefined', tagScope: 'per-list' },
      supportsAttachments: false,
      supportsSubtasks: true,
    });
  });
});

describe('tag requests', () => {
  it('scopes the tags URL by list and source only when required', () => {
    expect(buildTagsUrl({ connectorCaps: null })).toBe('/api/tags');
    expect(buildTagsUrl({
      connectorCaps: { tagWriteBack: true, tagCreationMode: 'freeform', tagScope: 'per-list' },
      sourceListId: 'list-1',
      connectorType: 'microsoft-todo',
    })).toBe('/api/tags?listId=list-1');
    expect(buildTagsUrl({
      connectorCaps: { tagWriteBack: false, tagCreationMode: 'predefined', tagScope: 'per-list' },
      sourceListId: 'list-1',
      connectorType: 'github-issues',
    })).toBe('/api/tags?listId=list-1&source=github-issues');
  });

  it('loads tag options from the scoped URL', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ tags: [{ id: 't1', name: 'urgent' }] }));

    await expect(fetchTagOptions({
      connectorCaps: { tagWriteBack: false, tagCreationMode: 'freeform', tagScope: 'global' },
      connectorType: 'github-issues',
    })).resolves.toEqual([{ id: 't1', name: 'urgent' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/tags?source=github-issues');
  });

  it('reports rejected tags and API errors when adding', async () => {
    stubFetch((input) => (
      input === '/api/tasks/task-1/tags'
        ? jsonResponse({ addedTagIds: [], rejectedTags: ['nope'] })
        : jsonResponse({})
    ));
    await expect(addTaskTags('task-1', ['nope'])).resolves.toEqual({
      ok: true,
      addedTagIds: [],
      rejectedTags: ['nope'],
    });

    stubFetch(() => jsonResponse({ error: 'Tags are read-only' }, false));
    await expect(addTaskTags('task-1', ['x'])).resolves.toEqual({
      ok: false,
      addedTagIds: [],
      rejectedTags: [],
      error: 'Tags are read-only',
    });
  });

  it('reports whether a tag removal succeeded', async () => {
    stubFetch(() => jsonResponse({}, false));
    await expect(removeTaskTag('task-1', 'tag-1')).resolves.toBe(false);

    stubFetch(() => jsonResponse({}));
    await expect(removeTaskTag('task-1', 'tag-1')).resolves.toBe(true);
  });
});

describe('task mutations', () => {
  it('PATCHes fields and surfaces the parsed body', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ fields: { localDisposition: { persisted: true } } }));

    await expect(patchTask('task-1', { status: 'done' })).resolves.toEqual({
      ok: true,
      data: { fields: { localDisposition: { persisted: true } } },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    }));
  });

  it('tolerates a PATCH response without a JSON body', async () => {
    stubFetch(() => ({ ok: true }) as unknown as Response);

    await expect(patchTask('task-1', { status: 'done' })).resolves.toEqual({ ok: true, data: {} });
  });

  it('throws when a delete is rejected', async () => {
    stubFetch(() => jsonResponse({}, false));

    await expect(deleteTask('task-1')).rejects.toThrow('Failed to delete task');
  });

  it('adds and removes project membership', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));

    await expect(addTaskToProject('project-1', 'task-1')).resolves.toBe(true);
    await expect(removeTaskFromProject('project-1', 'task-1')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/hub-projects/project-1/tasks', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/hub-projects/project-1/tasks', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deletes My Day membership when the task is already in My Day', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ writeBack: { attempted: true, success: false } }));

    await expect(setMyDayMembership({ taskId: 'task-1', date: '2026-08-01', isInMyDay: true })).resolves.toEqual({
      ok: true,
      writeBackAttempted: true,
      writeBackSucceeded: false,
      error: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/my-day?taskId=task-1&date=2026-08-01',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('posts My Day membership and reports API errors', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ error: 'Nope' }, false));

    await expect(setMyDayMembership({ taskId: 'task-1', date: '2026-08-01', isInMyDay: false })).resolves.toMatchObject({
      ok: false,
      error: 'Nope',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/my-day', expect.objectContaining({ method: 'POST' }));
  });
});

describe('runOptimisticMutation', () => {
  it('keeps the optimistic change when the mutation succeeds', async () => {
    const rollback = vi.fn();
    const onError = vi.fn();
    const applied: string[] = [];

    await expect(runOptimisticMutation({
      apply: () => applied.push('apply'),
      mutate: async () => true,
      rollback,
      onError,
    })).resolves.toBe(true);
    expect(applied).toEqual(['apply']);
    expect(rollback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rolls back a rejected mutation', async () => {
    const rollback = vi.fn();
    const onError = vi.fn();

    await expect(runOptimisticMutation({
      apply: vi.fn(),
      mutate: async () => false,
      rollback,
      onError,
    })).resolves.toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(undefined);
  });

  it('rolls back a thrown mutation and reports the error', async () => {
    const rollback = vi.fn();
    const onError = vi.fn();
    const failure = new Error('offline');

    await expect(runOptimisticMutation({
      apply: vi.fn(),
      mutate: async () => { throw failure; },
      rollback,
      onError,
    })).resolves.toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
