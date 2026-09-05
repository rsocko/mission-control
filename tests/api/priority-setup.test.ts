/**
 * API Route Tests – Priority Entities, Source Rankings, Smart Score Settings
 * Tests #143 (Priority Setup Wizard first-launch onboarding)
 *
 * Priority setup routes run entirely through portable task-core and core
 * settings repositories. Importing SQLite is poisoned below so a route cannot
 * accidentally regain a direct database dependency.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PriorityEntityRepository,
  PriorityEntityRow,
  PriorityProjectReference,
  PrioritySourceOption,
  PrioritySyncLogRow,
  PriorityTagReference,
  TaskCorePersistence,
} from '@/lib/tasks/core/contracts';
import {
  clearTaskCorePersistence,
  registerTaskCorePersistence,
} from '@/lib/tasks/core/runtime';

vi.mock('@/db', () => {
  throw new Error('priority setup routes must not import SQLite');
});

const listSourceRankings = vi.fn(async () => []);
const putSourceRankings = vi.fn(async (rankings: unknown[]) => rankings);
vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => ({
    listSourceRankings,
    putSourceRankings,
  })),
}));

// ─── Portable task-core fake ────────────────────────────────────────────────

const NOW = '2026-08-05T12:00:00.000Z';
const listSmartScoreSettings = vi.fn(async () => ({ priority_wizard_completed: 'true' }));
const setSmartScoreSetting = vi.fn(async () => undefined);

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositoriesForBackend: vi.fn(async () => ({
    settings: { listSmartScoreSettings, setSmartScoreSetting },
  })),
}));

interface PriorityFixture {
  entities: PriorityEntityRow[];
  projects: PriorityProjectReference[];
  tags: PriorityTagReference[];
  sources: PrioritySourceOption[];
  logs: PrioritySyncLogRow[];
}

const fixture: PriorityFixture = {
  entities: [],
  projects: [],
  tags: [],
  sources: [],
  logs: [],
};

function resetFixture(): void {
  fixture.entities = [];
  fixture.projects = [];
  fixture.tags = [];
  fixture.sources = [];
  fixture.logs = [];
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
  createPriorityEntity: async (input) => {
    const { now, ...values } = input;
    const entity = priorityEntityRow({
      ...values,
      referenceId: input.referenceId ?? null,
      description: input.description ?? null,
      tier: input.tier ?? 'standard',
      color: input.color ?? '#64748b',
      rank: input.rank ?? fixture.entities.length + 1,
      createdAt: now,
      updatedAt: now,
    });
    fixture.entities.push(entity);
    return entity;
  },
  updatePriorityEntities: async (inputs) => {
    for (const input of inputs) {
      const index = fixture.entities.findIndex((entity) => entity.id === input.id);
      if (index === -1) continue;
      fixture.entities[index] = { ...fixture.entities[index], ...input };
    }
  },
  deletePriorityEntityAndRerank: async (id, updatedAt) => {
    fixture.entities = fixture.entities
      .filter((entity) => entity.id !== id)
      .map((entity, index) => ({ ...entity, rank: index + 1, updatedAt }));
  },
  listPriorityEntityOptions: async () => ({
    projects: fixture.projects,
    tags: fixture.tags,
    sources: fixture.sources,
  }),
  listPrioritySyncLog: async ({ taskId, limit }) => fixture.logs
    .filter((row) => !taskId || row.taskId === taskId)
    .slice(0, limit),
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
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('returns canonical picker option groups', async () => {
    fixture.projects = [{
      id: 'project-1',
      name: 'Project',
      description: null,
      color: null,
    }];
    fixture.tags = [{
      id: 'tag-1',
      name: 'Tag',
      color: null,
      unifiedInto: null,
    }];
    fixture.sources = [{
      connectorInstanceId: 'connector-1',
      connectorName: 'GitHub',
      connectorType: 'github',
      sourceId: 'owner/repo',
      name: 'owner/repo',
      userDisplayName: 'Repository',
      color: null,
    }];
    const { GET } = await import('@/app/api/priority-entities/options/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: [{
        id: 'project-1',
        name: 'Project',
        description: null,
        color: null,
      }],
      tags: [{ id: 'tag-1', name: 'Tag', color: null }],
      sources: [{
        id: 'connector-1:owner/repo',
        name: 'Repository',
        label: 'Repository — GitHub',
        description: 'GitHub',
        color: null,
      }],
    });
  });
});

describe('PUT /api/priority-entities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixture();
    registerTaskCore();
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('batch-updates entities and returns updated list', async () => {
    fixture.entities = [priorityEntityRow({ id: 'e1', name: 'Before', type: 'person', rank: 1 })];
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
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixture();
    registerTaskCore();
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('deletes entity and re-ranks remaining', async () => {
    fixture.entities = [
      priorityEntityRow({ id: 'e1', name: 'One', type: 'person', rank: 1 }),
      priorityEntityRow({ id: 'e2', name: 'Two', type: 'person', rank: 2 }),
    ];
    const { DELETE } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities?id=e1', { method: 'DELETE' });
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
    expect(fixture.entities.map(({ id, rank }) => ({ id, rank }))).toEqual([{ id: 'e2', rank: 1 }]);
  });

  it('returns 400 when id is missing', async () => {
    const { DELETE } = await import('@/app/api/priority-entities/route');
    const req = new Request('http://localhost/api/priority-entities', { method: 'DELETE' });
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/priority-log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixture();
    registerTaskCore();
    fixture.logs = [{
      id: 'log-1',
      taskId: 'task-1',
      connectorType: 'local',
      connectorInstanceId: 'local',
      previousPriority: 'none',
      newPriority: 'high',
      direction: 'inbound',
      writeBackTriggered: false,
      note: null,
      timestamp: NOW,
    }];
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('returns task-filtered events through task-core persistence', async () => {
    const { GET } = await import('@/app/api/priority-log/route');
    const res = await GET(new Request(
      'http://localhost/api/priority-log?taskId=task-1&limit=1',
    ));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: fixture.logs });
  });

  it('bounds oversized log requests', async () => {
    fixture.logs = Array.from({ length: 205 }, (_, index) => ({
      ...fixture.logs[0],
      id: `log-${index}`,
    }));
    const { GET } = await import('@/app/api/priority-log/route');
    const res = await GET(new Request('http://localhost/api/priority-log?limit=999'));
    expect((await res.json()).events).toHaveLength(200);
  });
});

// ─── /api/source-rankings ───────────────────────────────────────────────────

describe('GET /api/source-rankings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSourceRankings.mockResolvedValue([]);
  });

  it('returns rankings array', async () => {
    const { GET } = await import('@/app/api/source-rankings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('rankings');
    expect(listSourceRankings).toHaveBeenCalledOnce();
  });
});

describe('PUT /api/source-rankings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putSourceRankings.mockImplementation(async (rankings: unknown[]) => rankings);
  });

  it('upserts rankings and returns updated list', async () => {
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
    expect(putSourceRankings).toHaveBeenCalledWith([
      { id: 'github', connectorType: 'github-issues', name: 'GitHub', rank: 1 },
    ], expect.stringMatching(/^20/));
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
  beforeEach(() => {
    vi.clearAllMocks();
    listSmartScoreSettings.mockResolvedValue({ priority_wizard_completed: 'true' });
  });

  it('returns settings object', async () => {
    const { GET } = await import('@/app/api/smart-score/settings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ settings: { priority_wizard_completed: 'true' } });
  });
});

describe('PUT /api/smart-score/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSmartScoreSetting.mockResolvedValue(undefined);
  });

  it('upserts a setting and returns success', async () => {
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
    expect(setSmartScoreSetting).toHaveBeenCalledWith('priority_wizard_completed', 'true');
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
