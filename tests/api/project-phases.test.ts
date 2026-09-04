/**
 * API Route Tests - Project Phases & Phase Items
 * Tests #83
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  findProjectPhaseItemTaskId,
  listProjectPhaseItems,
  placeTasksInProjectPhase,
  removeTasksFromProjectPhase,
  updateProjectPhaseItem,
} = vi.hoisted(() => ({
  findProjectPhaseItemTaskId: vi.fn(),
  listProjectPhaseItems: vi.fn(),
  placeTasksInProjectPhase: vi.fn(),
  removeTasksFromProjectPhase: vi.fn(),
  updateProjectPhaseItem: vi.fn(),
}));

class MockProjectHierarchyServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    readonly current?: unknown,
  ) {
    super(message);
  }
}

vi.mock('@/lib/projects/hierarchy-service', () => ({
  findProjectPhaseItemTaskId,
  listProjectPhaseItems,
  placeTasksInProjectPhase,
  removeTasksFromProjectPhase,
  updateProjectPhaseItem,
  ProjectHierarchyServiceError: MockProjectHierarchyServiceError,
}));

// ─── Shared DB mock (chainable) ─────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
};

const mockTx = {
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
  insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
};

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: vi.fn((fn: (tx: unknown) => void) => fn(mockTx)),
}));

vi.mock('@/lib/tasks/mutation-policy', () => ({
  getStoredTaskMutationPolicy: vi.fn(async (_taskId: string, field: string) => ({
    task: {},
    capabilities: null,
    policy: { field, sourceModel: 'mc-owned', mutation: 'local', inbound: 'local-wins' },
  })),
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => 'test-uuid-' + Math.random().toString(36).slice(2, 10)),
  };
});

vi.mock('@/db/schema', () => ({
  projectPhases: {
    id: 'id',
    projectId: 'project_id',
    name: 'name',
    description: 'description',
    status: 'status',
    color: 'color',
    estimatedDays: 'estimated_days',
    targetStart: 'target_start',
    targetEnd: 'target_end',
    startAfterPhaseId: 'start_after_phase_id',
    sortOrder: 'sort_order',
    completedAt: 'completed_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  projectPhaseItems: {
    id: 'id',
    phaseId: 'phase_id',
    taskId: 'task_id',
    sortOrder: 'sort_order',
    estimatedEffortHours: 'estimated_effort_hours',
    isProposed: 'is_proposed',
    proposalType: 'proposal_type',
    createdAt: 'created_at',
  },
}));

const BASE = 'http://localhost:3099';

// Reset mocks between tests so chainable terminals can be customised
beforeEach(() => {
  mockDb.select.mockReset().mockImplementation(() => chainable([]));
  mockDb.insert.mockReset().mockImplementation(() => chainable([]));
  mockDb.update.mockReset().mockImplementation(() => chainable(undefined));
  mockDb.delete.mockReset().mockImplementation(() => chainable(undefined));
  placeTasksInProjectPhase.mockReset().mockImplementation(async ({
    phaseId,
    taskIds,
    toIndex,
    newItem,
  }) => ({
    hierarchy: {
      phaseItemsByPhase: {
        [phaseId]: [{
          id: 'item-1',
          phaseId,
          taskId: taskIds[0],
          sortOrder: toIndex,
          estimatedEffortHours: newItem?.estimatedEffortHours ?? null,
          isProposed: newItem?.isProposed ?? false,
          proposalType: newItem?.proposalType ?? null,
        }],
      },
    },
  }));
  updateProjectPhaseItem.mockReset().mockImplementation(async ({
    phaseId,
    taskId,
    toIndex,
    updates,
  }) => ({
    hierarchy: {
      phaseItemsByPhase: {
        [phaseId]: [{
          id: 'item-1',
          phaseId,
          taskId,
          sortOrder: toIndex ?? 0,
          ...updates,
        }],
      },
    },
  }));
  removeTasksFromProjectPhase.mockReset().mockResolvedValue({});
  listProjectPhaseItems.mockReset().mockResolvedValue([]);
  findProjectPhaseItemTaskId.mockReset().mockResolvedValue('task-1');
});

// ─── PROJECT PHASES - List ─────────────────────────────────────────────────

describe('GET /api/project-phases', () => {
  it('should return all phases when no filter is provided', async () => {
    const { GET } = await import('@/app/api/project-phases/route');
    const request = new Request(`${BASE}/api/project-phases`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('phases');
    expect(Array.isArray(data.phases)).toBe(true);
  });

  it('should filter by project_id when provided', async () => {
    const { GET } = await import('@/app/api/project-phases/route');
    const request = new Request(`${BASE}/api/project-phases?project_id=proj-1`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('phases');
  });

  it('should filter cross-project phases when cross_project=true', async () => {
    const { GET } = await import('@/app/api/project-phases/route');
    const request = new Request(`${BASE}/api/project-phases?cross_project=true`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('phases');
  });
});

// ─── PROJECT PHASES - Create ───────────────────────────────────────────────

describe('POST /api/project-phases', () => {
  it('should create a phase with valid name', async () => {
    const phase = { id: 'phase-1', name: 'Design', status: 'pending' };
    mockDb.select.mockImplementation(() => chainable([phase]));

    const { POST } = await import('@/app/api/project-phases/route');
    const request = new Request(`${BASE}/api/project-phases`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Design', projectId: 'proj-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data).toHaveProperty('phase');
    expect(data.phase.name).toBe('Design');
  });

  it('should return 400 when name is missing', async () => {
    const { POST } = await import('@/app/api/project-phases/route');
    const request = new Request(`${BASE}/api/project-phases`, {
      method: 'POST',
      body: JSON.stringify({ description: 'No name' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name');
  });

  it('should accept optional fields (color, estimatedDays, targets)', async () => {
    const phase = { id: 'phase-2', name: 'Build', color: '#ff0000', estimatedDays: 14 };
    mockDb.select.mockImplementation(() => chainable([phase]));

    const { POST } = await import('@/app/api/project-phases/route');
    const request = new Request(`${BASE}/api/project-phases`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Build',
        color: '#ff0000',
        estimatedDays: 14,
        targetStart: '2026-08-01',
        targetEnd: '2026-08-15',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
  });
});

// ─── PROJECT PHASES - Get by ID ────────────────────────────────────────────

describe('GET /api/project-phases/[id]', () => {
  it('should return a phase with its items', async () => {
    const phase = { id: 'phase-1', name: 'Design', status: 'pending' };
    mockDb.select.mockImplementation(() => chainable([phase]));

    const { GET } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1`);
    const response = await GET(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('phase');
    expect(data).toHaveProperty('items');
  });

  it('should return 404 when phase does not exist', async () => {
    mockDb.select.mockImplementation(() => chainable([]));

    const { GET } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/nonexistent`);
    const response = await GET(request, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('not found');
  });
});

// ─── PROJECT PHASES - Update ───────────────────────────────────────────────

describe('PATCH /api/project-phases/[id]', () => {
  it('should update a phase with valid fields', async () => {
    const phase = { id: 'phase-1', name: 'Design v2', status: 'in_progress' };
    mockDb.select.mockImplementation(() => chainable([phase]));

    const { PATCH } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Design v2', status: 'in_progress' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('phase');
  });

  it('should auto-set completedAt when status transitions to completed', async () => {
    const phase = { id: 'phase-1', name: 'Design', status: 'completed', completedAt: '2026-07-18T00:00:00.000Z' };
    mockDb.select.mockImplementation(() => chainable([phase]));

    const { PATCH } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.phase.completedAt).toBeTruthy();
  });
});

// ─── PROJECT PHASES - Delete ───────────────────────────────────────────────

describe('DELETE /api/project-phases/[id]', () => {
  it('should delete a phase and its items', async () => {
    const { DELETE } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1`, { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});

// ─── PHASE ITEMS - List ────────────────────────────────────────────────────

describe('GET /api/project-phases/[id]/items', () => {
  it('should return items for a phase through the selected repository', async () => {
    const items = [
      { id: 'item-1', phaseId: 'phase-1', taskId: 'task-1', sortOrder: 0 },
      { id: 'item-2', phaseId: 'phase-1', taskId: 'task-2', sortOrder: 1 },
    ];
    listProjectPhaseItems.mockResolvedValue(items);

    const { GET } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items`);
    const response = await GET(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.items).toEqual(items);
    expect(listProjectPhaseItems).toHaveBeenCalledWith('phase-1');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('should surface a repository failure as an internal error', async () => {
    listProjectPhaseItems.mockRejectedValue(new Error('backend unavailable'));

    const { GET } = await import('@/app/api/project-phases/[id]/items/route');
    const response = await GET(
      new Request(`${BASE}/api/project-phases/phase-1/items`),
      { params: Promise.resolve({ id: 'phase-1' }) },
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('backend unavailable');
  });
});

// ─── PHASE ITEMS - Create ──────────────────────────────────────────────────

describe('POST /api/project-phases/[id]/items', () => {
  it('should add a task to a phase', async () => {
    const { POST } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data).toHaveProperty('item');
    expect(data.item.taskId).toBe('task-1');
    expect(placeTasksInProjectPhase).toHaveBeenCalledWith(expect.objectContaining({
      preserveExistingPosition: true,
    }));
  });

  it('should return 400 when taskId is missing', async () => {
    const { POST } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items`, {
      method: 'POST',
      body: JSON.stringify({ sortOrder: 1 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('taskId');
  });

  it('should accept optional fields (sortOrder, estimatedEffortHours, isProposed)', async () => {
    const { POST } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-2',
        sortOrder: 5,
        estimatedEffortHours: 8,
        isProposed: true,
        proposalType: 'new_task',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(201);
    expect(placeTasksInProjectPhase).toHaveBeenCalledWith(expect.objectContaining({
      preserveExistingPosition: false,
    }));
  });
});

// ─── PHASE ITEMS - Update (PATCH) ──────────────────────────────────────────

describe('PATCH /api/project-phases/[id]/items', () => {
  it('should update a phase item with valid fields', async () => {
    findProjectPhaseItemTaskId.mockResolvedValue('task-1');

    const { PATCH } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items?item_id=item-1`, {
      method: 'PATCH',
      body: JSON.stringify({ sortOrder: 3, estimatedEffortHours: 4 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('item');
    expect(data.item.sortOrder).toBe(3);
    expect(findProjectPhaseItemTaskId).toHaveBeenCalledWith('phase-1', 'item-1');
    expect(updateProjectPhaseItem).toHaveBeenCalledWith(expect.objectContaining({
      phaseId: 'phase-1',
      taskId: 'task-1',
      toIndex: 3,
    }));
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('should return 404 when the item does not belong to the phase', async () => {
    findProjectPhaseItemTaskId.mockResolvedValue(null);

    const { PATCH } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items?item_id=item-9`, {
      method: 'PATCH',
      body: JSON.stringify({ estimatedEffortHours: 4 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(404);
    expect(updateProjectPhaseItem).not.toHaveBeenCalled();
  });

  it('should return 400 when item_id query param is missing', async () => {
    const { PATCH } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items`, {
      method: 'PATCH',
      body: JSON.stringify({ sortOrder: 1 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('item_id');
  });

  it('should return 400 when no valid fields are provided', async () => {
    const { PATCH } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items?item_id=item-1`, {
      method: 'PATCH',
      body: JSON.stringify({ invalidField: 'nope' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('No valid fields');
  });
});

// ─── PHASE ITEMS - Delete ──────────────────────────────────────────────────

describe('DELETE /api/project-phases/[id]/items', () => {
  it('should remove a task from a phase', async () => {
    const { DELETE } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items?task_id=task-1`, { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('should return 400 when task_id query param is missing', async () => {
    const { DELETE } = await import('@/app/api/project-phases/[id]/items/route');
    const request = new Request(`${BASE}/api/project-phases/phase-1/items`, { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'phase-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('task_id');
  });
});
