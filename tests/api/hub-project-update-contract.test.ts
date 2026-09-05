import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateHubProject } = vi.hoisted(() => ({
  updateHubProject: vi.fn(),
}));

vi.mock('@/lib/projects/organization-service', () => ({
  updateHubProject,
}));

vi.mock('@/lib/rules', () => ({
  normalizeAutoIncludeRules: (value: unknown) => (
    Array.isArray(value)
      ? value.filter((candidate) => (
          candidate
          && typeof candidate === 'object'
          && 'type' in candidate
          && 'value' in candidate
        ))
      : []
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  updateHubProject.mockResolvedValue({ evaluation: null, evaluationFailed: false });
});

async function callCollectionPatch(body: unknown) {
  const { PATCH } = await import('@/app/api/hub-projects/route');
  return PATCH(new Request('http://localhost/api/hub-projects', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function callItemPatch(body: unknown) {
  const { PATCH } = await import('@/app/api/hub-projects/[id]/route');
  return PATCH(
    new Request('http://localhost/api/hub-projects/project-1', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: 'project-1' }) },
  );
}

describe('hub project PATCH route contract', () => {
  it.each([
    ['unknown fields', { unsupported: true }],
    ['invalid field values', { color: 'blue' }],
    ['empty updates', {}],
  ])('rejects %s identically from both PATCH routes', async (_label, updates) => {
    const [collectionResponse, itemResponse] = await Promise.all([
      callCollectionPatch({ id: 'project-1', ...updates }),
      callItemPatch(updates),
    ]);

    expect(collectionResponse.status).toBe(400);
    expect(itemResponse.status).toBe(400);
    expect(await collectionResponse.json()).toEqual(await itemResponse.json());
    expect(updateHubProject).not.toHaveBeenCalled();
  });

  it('allows the same valid fields and normalized values from both PATCH routes', async () => {
    const updates = {
      name: '  Renamed project  ',
      kanbanColumns: [{
        id: 'todo',
        name: 'To do',
        color: '#3b82f6',
        statusMapping: ['todo'],
      }],
      metadata: { owner: 'team' },
    };

    const collectionResponse = await callCollectionPatch({
      id: 'project-1',
      ...updates,
    });
    const itemResponse = await callItemPatch(updates);

    expect(collectionResponse.status).toBe(200);
    expect(itemResponse.status).toBe(200);
    expect(updateHubProject).toHaveBeenCalledTimes(2);
    for (const [projectId, savedUpdates] of updateHubProject.mock.calls) {
      expect(projectId).toBe('project-1');
      expect(savedUpdates).toMatchObject({
        ...updates,
        name: 'Renamed project',
      });
      expect(savedUpdates).not.toHaveProperty('id');
      expect(savedUpdates).not.toHaveProperty('updatedAt');
    }
  });
});
