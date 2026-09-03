/**
 * API Route Tests – Priority Entities, Source Rankings, Smart Score Settings
 * Tests #143 (Priority Setup Wizard first-launch onboarding)
 *
 * Updated for L04: priority-entity resolution now runs through the portable
 * task-core `PriorityEntityRepository`, so the reference-resolution cases are
 * driven by a registered fake composition instead of `mockDb.select`
 * sequencing. Everything the route still does directly against `@/db`
 * (inserts, updates, deletes, ranking reads) keeps using the chainable mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PriorityEntityRepository,
  PriorityEntityRow,
  PriorityProjectReference,
  PrioritySourceListReference,
  PriorityTagReference,
  TaskCorePersistence,
} from '@/lib/tasks/core/contracts';
import {
  clearTaskCorePersistence,
  registerTaskCorePersistence,
} from '@/lib/tasks/core/runtime';

// ─── Chainable DB mock ──────────────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      // .all() and .get() return the terminal value directly
      if (prop === 'all') return vi.fn(() => (Array.isArray(terminal) ? terminal : []));
      if (prop === 'get') return vi.fn(() => (Array.isArray(terminal) ? terminal[0] : terminal));
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable(undefined)),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
};

vi.mock('@/db', () => ({ default: mockDb }));

// ─── Portable task-core fake ────────────────────────────────────────────────

const NOW = '2026-08-05T12:00:00.000Z';

interface PriorityFixture {
  entities: PriorityEntityRow[];
  projects: PriorityProjectReference[];
  tags: PriorityTagReference[];
  sources: PrioritySourceListReference[];
}

const fixture: PriorityFixture = { entities: [], projects: [], tags: [], sources: [] };

function resetFixture(): void {
  fixture.entities = [];
  fixture.projects = [];
  fixture.tags = [];
  fixture.sources = [];
}

export function priorityEntityRow(
  overrides: Partial<PriorityEntityRow> & Pick<PriorityEntityRow, 'id' | 'name' | 'type'>,
): PriorityEntityRow {
  return {
    referenceId: null,
    description: null,
    tier: 'standard',
    color: '#64748b',
    rank: 0,
    activeTaskCount: 0,
    lastTouchedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const priorityEntities: PriorityEntityRepository = {
  listPriorityEntitiesByRank: async () => fixture.entities,
  getProjectReference: async (id) => fixture.projects.find((row) => row.id === id) ?? null,
  getTagReference: async (id) => fixture.tags.find((row) => row.id === id) ?? null,
  getSourceListReference: async (connectorInstanceId, sourceId) =>
    fixture.sources.find((row) =>
      row.connectorInstanceId === connectorInstanceId && row.sourceId === sourceId) ?? null,
  listProjectReferences: async () => fixture.projects,
  listTagReferences: async () => fixture.tags,
  listSourceListReferences: async () => fixture.sources,
};

function registerTaskCore(): void {
  registerTaskCorePersistence({ priorityEntities } as unknown as TaskCorePersistence);
}

vi.mock('@/db/schema', () => ({
  priorityEntities: {
    id: 'id', name: 'name', type: 'type', description: 'description',
    referenceId: 'referenceId',
    tier: 'tier', color: 'color', rank: 'rank', activeTaskCount: 'activeTaskCount',
    createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
  sourceRankings: {
    id: 'id', connectorType: 'connectorType', name: 'name',
    rank: 'rank', updatedAt: 'updatedAt',
  },
  smartScoreSettings: {
    key: 'key', value: 'value', updatedAt: 'updatedAt',
  },
  hubProjects: { id: 'id', name: 'name', description: 'description', color: 'color', hidden: 'hidden' },
  tags: { id: 'id', name: 'name', color: 'color', confirmed: 'confirmed', unifiedInto: 'unifiedInto' },
  sourceLists: {
    connectorInstanceId: 'connectorInstanceId', sourceId: 'sourceId', name: 'name',
    userDisplayName: 'userDisplayName', iconColor: 'iconColor', hidden: 'hidden',
  },
  connectorConfigs: { id: 'id', name: 'name', enabled: 'enabled', deletedAt: 'deletedAt' },
}));

// ─── /api/priority-entities ─────────────────────────────────────────────────

describe('GET /api/priority-entities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixture();
    registerTaskCore();
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('returns entities array', async () => {
    const { GET } = await import('@/app/api/priority-entities/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('entities');
    expect(Array.isArray(data.entities)).toBe(true);
  });

  it('returns 500 on db error', async () => {
    registerTaskCorePersistence({
      priorityEntities: {
        ...priorityEntities,
        listPriorityEntitiesByRank: async () => { throw new Error('db fail'); },
      },
    } as unknown as TaskCorePersistence);
    const { GET } = await import('@/app/api/priority-entities/route');
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it('returns the current name for a referenced entity after rename', async () => {
    fixture.entities = [priorityEntityRow({
      id: 'priority-1',
      name: 'Old name',
      type: 'project',
      referenceId: 'project-1',
      tier: 'high',
      rank: 1,
    })];
    fixture.projects = [{
      id: 'project-1',
      name: 'Current name',
      description: null,
      color: '#a78bfa',
    }];

    const { GET } = await import('@/app/api/priority-entities/route');
    const res = await GET();
    const data = await res.json();
    expect(data.entities[0]).toMatchObject({
      name: 'Current name',
      referenceStatus: 'resolved',
    });
  });

  it('flags a referenced entity when its target was removed', async () => {
    fixture.entities = [priorityEntityRow({
      id: 'priority-1',
      name: 'Removed project',
      type: 'project',
      referenceId: 'project-1',
      tier: 'high',
      rank: 1,
    })];

    const { GET } = await import('@/app/api/priority-entities/route');
    const res = await GET();
    const data = await res.json();
    expect(data.entities[0].referenceStatus).toBe('missing');
  });

  it('resolves a unified tag reference to its canonical hub tag', async () => {
    fixture.entities = [priorityEntityRow({
      id: 'priority-1',
      name: 'Old source tag',
      type: 'tag',
      referenceId: 'source-tag',
      tier: 'high',
      rank: 1,
    })];
    fixture.tags = [
      { id: 'source-tag', name: 'Old source tag', color: null, unifiedInto: 'hub-tag' },
      { id: 'hub-tag', name: 'Customer', color: null, unifiedInto: null },
    ];

    const { GET } = await import('@/app/api/priority-entities/route');
    const res = await GET();
    const data = await res.json();
    expect(data.entities[0]).toMatchObject({
      name: 'Customer',
      referenceId: 'hub-tag',
      referenceStatus: 'resolved',
    });
  });
});

describe('POST /api/priority-entities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixture();
    registerTaskCore();
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('creates an entity and returns 201', async () => {
    fixture.projects = [{
      id: 'project-1',
      name: 'Test',
      description: null,
      color: null,
    }];
    fixture.entities = [priorityEntityRow({
      id: 'e1', name: 'Test', type: 'project', tier: 'high', rank: 1,
    })];
    mockDb.select.mockImplementation(() => chainable([{ id: 'e1', name: 'Test', type: 'project', tier: 'high', rank: 1 }]));
    const { POST } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', type: 'project', referenceId: 'project-1', tier: 'high' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toHaveProperty('entity');
  });

  it('returns 400 when name is missing', async () => {
    const { POST } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', {
      method: 'POST',
      body: JSON.stringify({ type: 'project' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is missing', async () => {
    const { POST } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('requires a canonical reference for picker-backed types', async () => {
    const { POST } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', type: 'tag' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects a reference that does not exist', async () => {
    mockDb.select.mockImplementation(() => chainable([]));
    const { POST } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', {
      method: 'POST',
      body: JSON.stringify({ name: 'Missing', type: 'project', referenceId: 'missing-project' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/priority-entities/options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixture();
    registerTaskCore();
    mockDb.select.mockImplementation(() => chainable([]));
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('returns canonical picker option groups', async () => {
    const { GET } = await import('@/app/api/priority-entities/options/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [], tags: [], sources: [] });
  });
});

describe('PUT /api/priority-entities', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('batch-updates entities and returns updated list', async () => {
    mockDb.select.mockImplementation(() => chainable([{ id: 'e1', name: 'Updated', rank: 1 }]));
    const { PUT } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', {
      method: 'PUT',
      body: JSON.stringify({ entities: [{ id: 'e1', rank: 1, tier: 'critical' }] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('entities');
  });

  it('returns 400 when entities is not an array', async () => {
    const { PUT } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', {
      method: 'PUT',
      body: JSON.stringify({ entities: 'not-array' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/priority-entities', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes entity and re-ranks remaining', async () => {
    mockDb.select.mockImplementation(() => chainable([]));
    const { DELETE } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities?id=e1', { method: 'DELETE' });
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
  });

  it('returns 400 when id is missing', async () => {
    const { DELETE } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', { method: 'DELETE' });
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });
});

// ─── /api/source-rankings ───────────────────────────────────────────────────

describe('GET /api/source-rankings', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns rankings array', async () => {
    const { GET } = await import('@/app/api/source-rankings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('rankings');
  });
});

describe('PUT /api/source-rankings', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('upserts rankings and returns updated list', async () => {
    mockDb.select.mockImplementation(() => chainable(undefined));
    const { PUT } = await import('@/app/api/source-rankings/route');
    const req = new Request('http://localhost/api/source-rankings', {
      method: 'PUT',
      body: JSON.stringify({ rankings: [
        { id: 'github', connectorType: 'github-issues', name: 'GitHub', rank: 1 },
      ]}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('rankings');
  });

  it('returns 400 when rankings is not an array', async () => {
    const { PUT } = await import('@/app/api/source-rankings/route');
    const req = new Request('http://localhost/api/source-rankings', {
      method: 'PUT',
      body: JSON.stringify({ rankings: 'bad' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});

// ─── /api/smart-score/settings ──────────────────────────────────────────────

describe('GET /api/smart-score/settings', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns settings object', async () => {
    const { GET } = await import('@/app/api/smart-score/settings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('settings');
  });
});

describe('PUT /api/smart-score/settings', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('upserts a setting and returns success', async () => {
    mockDb.select.mockImplementation(() => chainable(undefined));
    const { PUT } = await import('@/app/api/smart-score/settings/route');
    const req = new Request('http://localhost/api/smart-score/settings', {
      method: 'PUT',
      body: JSON.stringify({ key: 'priority_wizard_completed', value: 'true' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
  });

  it('returns 400 when key is missing', async () => {
    const { PUT } = await import('@/app/api/smart-score/settings/route');
    const req = new Request('http://localhost/api/smart-score/settings', {
      method: 'PUT',
      body: JSON.stringify({ value: 'true' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when value is undefined', async () => {
    const { PUT } = await import('@/app/api/smart-score/settings/route');
    const req = new Request('http://localhost/api/smart-score/settings', {
      method: 'PUT',
      body: JSON.stringify({ key: 'some_key' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});
