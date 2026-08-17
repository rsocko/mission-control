import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createIdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';

const document = createIdeationWorkspaceDocument([{
  id: 'root',
  label: 'API workspace',
  kind: 'idea',
  parentId: null,
  sortOrder: 0,
  properties: {},
}]);

function request(url: string, method = 'GET', body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      host: 'localhost',
      'x-forwarded-host': 'localhost',
      'x-forwarded-proto': 'http',
      origin: 'http://localhost',
      'sec-fetch-site': 'same-origin',
      'x-mc-api-key': 'workspace-test-key',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Ideation workspace API', () => {
  let collection: typeof import('@/app/api/ideation/workspaces/route');
  let item: typeof import('@/app/api/ideation/workspaces/[id]/route');
  let versions: typeof import('@/app/api/ideation/workspaces/[id]/versions/route');
  let version: typeof import('@/app/api/ideation/workspaces/[id]/versions/[revision]/route');
  let workspaceId: string;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.MC_API_KEY = 'workspace-test-key';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    [collection, item, versions, version] = await Promise.all([
      import('@/app/api/ideation/workspaces/route'),
      import('@/app/api/ideation/workspaces/[id]/route'),
      import('@/app/api/ideation/workspaces/[id]/versions/route'),
      import('@/app/api/ideation/workspaces/[id]/versions/[revision]/route'),
    ]);
  });

  it('creates, saves, conflicts, restores, archives, and deletes a workspace', async () => {
    const createdResponse = await collection.POST(request(
      '/api/ideation/workspaces',
      'POST',
      { name: 'API workspace', document },
    ));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    workspaceId = created.workspace.id;

    const changedDocument = {
      ...document,
      nodes: [{ ...document.nodes[0], label: 'Saved change' }],
    };
    const context = { params: Promise.resolve({ id: workspaceId }) };
    const savedResponse = await item.PATCH(request(
      `/api/ideation/workspaces/${workspaceId}`,
      'PATCH',
      { baseRevision: 1, document: changedDocument },
    ), context);
    expect(savedResponse.status).toBe(200);
    expect((await savedResponse.json()).workspace.contentRevision).toBe(2);

    const conflictResponse = await item.PATCH(request(
      `/api/ideation/workspaces/${workspaceId}`,
      'PATCH',
      { baseRevision: 1, document },
    ), context);
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({
      code: 'WORKSPACE_CONFLICT',
      current: {
        id: workspaceId,
        contentRevision: 2,
      },
    });

    const historyResponse = await versions.GET(
      request(`/api/ideation/workspaces/${workspaceId}/versions`),
      context,
    );
    const history = await historyResponse.json();
    expect(history.versions).toEqual([
      expect.objectContaining({ revision: 1, reason: 'created' }),
    ]);
    expect(history.versions[0]).not.toHaveProperty('document');

    const restoredResponse = await version.POST(request(
      `/api/ideation/workspaces/${workspaceId}/versions/1`,
      'POST',
      { baseRevision: 2 },
    ), {
      params: Promise.resolve({ id: workspaceId, revision: '1' }),
    });
    expect(restoredResponse.status).toBe(200);
    expect(await restoredResponse.json()).toMatchObject({
      workspace: {
        contentRevision: 3,
        document,
      },
    });

    const unarchivedDelete = await item.DELETE(request(
      `/api/ideation/workspaces/${workspaceId}`,
      'DELETE',
    ), context);
    expect(unarchivedDelete.status).toBe(409);

    const archiveResponse = await item.PATCH(request(
      `/api/ideation/workspaces/${workspaceId}`,
      'PATCH',
      { archived: true },
    ), context);
    expect(archiveResponse.status).toBe(200);
    const deleteResponse = await item.DELETE(request(
      `/api/ideation/workspaces/${workspaceId}`,
      'DELETE',
    ), context);
    expect(deleteResponse.status).toBe(200);
  });

  it('rejects cross-site mutations', async () => {
    const response = await collection.POST(new Request(
      'http://localhost/api/ideation/workspaces',
      {
        method: 'POST',
        headers: {
          host: 'localhost',
          'x-forwarded-host': 'localhost',
          'x-forwarded-proto': 'http',
          origin: 'https://attacker.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Blocked', document }),
      },
    ));
    expect(response.status).toBe(403);
  });
});
