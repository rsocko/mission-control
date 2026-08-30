import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setUpdate, updateWhere, selectWhere, reevaluateProject } = vi.hoisted(() => ({
  setUpdate: vi.fn(),
  updateWhere: vi.fn(),
  selectWhere: vi.fn(),
  reevaluateProject: vi.fn(),
}));

const update = vi.fn(() => ({ set: setUpdate }));
const select = vi.fn(() => ({
  from: vi.fn(() => ({ where: selectWhere })),
}));

vi.mock('@/db', () => ({
  default: {
    update,
    select,
  },
  runTransaction: vi.fn(),
}));

vi.mock('@/db/schema', () => {
  const table = { id: 'id' };
  return {
    hubProjects: table,
    projectAutoIncludeExclusions: table,
    projectMilestones: table,
    projectPhaseItems: table,
    projectPhases: table,
    projectTags: table,
    taskProjects: table,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'where'),
  inArray: vi.fn(() => 'where'),
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
  reevaluateProject,
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  dbLogger: { error: vi.fn() },
  requestContext: { getStore: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  setUpdate.mockReturnValue({ where: updateWhere });
  updateWhere.mockResolvedValue(undefined);
  selectWhere.mockResolvedValue([]);
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
    expect(update).not.toHaveBeenCalled();
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
    expect(setUpdate).toHaveBeenCalledTimes(2);
    for (const [savedUpdates] of setUpdate.mock.calls) {
      expect(savedUpdates).toMatchObject({
        ...updates,
        name: 'Renamed project',
        updatedAt: expect.any(String),
      });
      expect(savedUpdates).not.toHaveProperty('id');
    }
  });
});
