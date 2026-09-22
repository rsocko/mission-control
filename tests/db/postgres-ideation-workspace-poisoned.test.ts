import { describe, expect, it, vi } from 'vitest';
import { createIdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type IdeationWorkspaceRepository,
} from '@/lib/graph-workspace/repository';
import type { IdeationWorkspace } from '@/lib/graph-workspace/types';

/**
 * Poisoned-SQLite proof for the L16 owned surface: with a PostgreSQL-shaped
 * worker composition and a throwing `@/db`, every handler on the five owned
 * ideation-workspace routes, the shared route-error helper, and the clean
 * service must import and run. Any static or dynamic SQLite reach fails the
 * whole file at import time.
 */

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const NOW = '2026-01-01T00:00:00.000Z';
const WORKSPACE_ID = 'workspace-poisoned';
const document = createIdeationWorkspaceDocument([{
  id: 'root',
  label: 'Poisoned',
  kind: 'idea',
  parentId: null,
  sortOrder: 0,
  properties: {},
}]);

const workspace: IdeationWorkspace = {
  id: WORKSPACE_ID,
  name: 'Poisoned',
  type: 'ideation',
  schemaVersion: 1,
  contentRevision: 1,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  document,
};
const version = {
  id: 'version-1',
  workspaceId: WORKSPACE_ID,
  revision: 1,
  name: 'Poisoned',
  document,
  reason: 'created' as const,
  createdAt: NOW,
};

const known = (id: string) => id === WORKSPACE_ID;

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  updateContent: vi.fn(),
  deleteArchived: vi.fn(),
}));

const repository: IdeationWorkspaceRepository = {
  list: async () => [workspace],
  get: async (id) => (known(id) ? workspace : null),
  findByMigrationSource: async () => null,
  create: calls.create.mockResolvedValue(workspace),
  updateContent: calls.updateContent.mockImplementation(async (id, baseRevision) => {
    if (!known(id)) return null;
    if (baseRevision !== workspace.contentRevision) {
      throw new IdeationWorkspaceConflictError(workspace);
    }
    return { ...workspace, contentRevision: baseRevision + 1 };
  }),
  rename: async (id, name) => (known(id) ? { ...workspace, name } : null),
  setArchived: async (id, archived) => (
    known(id) ? { ...workspace, archivedAt: archived ? NOW : null } : null
  ),
  duplicate: async (sourceId, id, name) => (
    known(sourceId) ? { ...workspace, id, name } : null
  ),
  deleteArchived: calls.deleteArchived.mockResolvedValue('deleted'),
  listVersions: async (id) => (known(id) ? [version] : []),
  getVersion: async (id, revision) => (
    known(id) && revision === 1 ? version : null
  ),
  restore: async (id) => (known(id) ? { ...workspace, contentRevision: 2 } : null),
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ ideationWorkspaces: repository }),
}));

const BASE = 'http://localhost:3099';

function request(url: string, method = 'GET', body?: unknown) {
  return new Request(`${BASE}${url}`, {
    method,
    headers: {
      host: 'localhost:3099',
      origin: BASE,
      'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('poisoned-SQLite ideation workspace web surface', () => {
  it('serves the collection route from the composed repository', async () => {
    const route = await import('@/app/api/ideation/workspaces/route');

    const listed = await route.GET(request('/api/ideation/workspaces'));
    expect(listed.status).toBe(200);
    expect((await listed.json()).workspaces).toEqual([expect.objectContaining({
      id: WORKSPACE_ID,
    })]);

    const created = await route.POST(request(
      '/api/ideation/workspaces',
      'POST',
      { name: 'Poisoned', document },
    ));
    expect(created.status).toBe(201);
    expect(calls.create).toHaveBeenCalled();
  });

  it('serves the item route: read, save, rename, archive, and delete', async () => {
    const route = await import('@/app/api/ideation/workspaces/[id]/route');
    const context = { params: Promise.resolve({ id: WORKSPACE_ID }) };

    expect((await route.GET(
      request(`/api/ideation/workspaces/${WORKSPACE_ID}`),
      context,
    )).status).toBe(200);

    expect((await route.PATCH(request(
      `/api/ideation/workspaces/${WORKSPACE_ID}`,
      'PATCH',
      { baseRevision: 1, document },
    ), { params: Promise.resolve({ id: WORKSPACE_ID }) })).status).toBe(200);

    expect((await route.PATCH(request(
      `/api/ideation/workspaces/${WORKSPACE_ID}`,
      'PATCH',
      { name: 'Renamed' },
    ), { params: Promise.resolve({ id: WORKSPACE_ID }) })).status).toBe(200);

    expect((await route.PATCH(request(
      `/api/ideation/workspaces/${WORKSPACE_ID}`,
      'PATCH',
      { archived: true },
    ), { params: Promise.resolve({ id: WORKSPACE_ID }) })).status).toBe(200);

    const deleted = await route.DELETE(
      request(`/api/ideation/workspaces/${WORKSPACE_ID}`, 'DELETE'),
      { params: Promise.resolve({ id: WORKSPACE_ID }) },
    );
    expect(deleted.status).toBeLessThan(400);
    expect(calls.deleteArchived).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('reports an optimistic conflict through the shared route-error helper', async () => {
    const route = await import('@/app/api/ideation/workspaces/[id]/route');
    const conflicted = await route.PATCH(request(
      `/api/ideation/workspaces/${WORKSPACE_ID}`,
      'PATCH',
      { baseRevision: 99, document },
    ), { params: Promise.resolve({ id: WORKSPACE_ID }) });

    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toMatchObject({ code: 'WORKSPACE_CONFLICT' });
  });

  it('serves the duplicate and version routes', async () => {
    const [duplicate, versions, revision] = await Promise.all([
      import('@/app/api/ideation/workspaces/[id]/duplicate/route'),
      import('@/app/api/ideation/workspaces/[id]/versions/route'),
      import('@/app/api/ideation/workspaces/[id]/versions/[revision]/route'),
    ]);

    expect((await duplicate.POST(
      request(`/api/ideation/workspaces/${WORKSPACE_ID}/duplicate`, 'POST', { name: 'Copy' }),
      { params: Promise.resolve({ id: WORKSPACE_ID }) },
    )).status).toBeLessThan(400);

    expect((await versions.GET(
      request(`/api/ideation/workspaces/${WORKSPACE_ID}/versions`),
      { params: Promise.resolve({ id: WORKSPACE_ID }) },
    )).status).toBe(200);

    expect((await revision.GET(
      request(`/api/ideation/workspaces/${WORKSPACE_ID}/versions/1`),
      { params: Promise.resolve({ id: WORKSPACE_ID, revision: '1' }) },
    )).status).toBe(200);

    expect((await revision.POST(
      request(
        `/api/ideation/workspaces/${WORKSPACE_ID}/versions/1`,
        'POST',
        { baseRevision: 1 },
      ),
      { params: Promise.resolve({ id: WORKSPACE_ID, revision: '1' }) },
    )).status).toBeLessThan(400);
  });
});
