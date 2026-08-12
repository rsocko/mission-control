/**
 * API Route Tests — Goals: list, develop, promote
 * Tests for issue #91 (Goal to Project promotion)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockInsert = vi.fn(() => chainable([]));
const mockSelect = vi.fn(() => chainable([]));
const mockUpdate = vi.fn(() => chainable(undefined));

vi.mock('@/db', () => {
  // Deep chainable proxy: every property access and every function call
  // returns the same proxy, so tx.insert(x).values({...}).run() all work.
  function deepChainable(): unknown {
    const proxy: unknown = new Proxy(function () { /* callable */ }, {
      get(_target, prop) {
        if (prop === 'then') return undefined; // not a thenable
        return proxy;
      },
      apply() {
        return proxy;
      },
    });
    return proxy;
  }

  return {
    default: {
      select: (...args: unknown[]) => mockSelect(...args),
      insert: (...args: unknown[]) => mockInsert(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: vi.fn(() => chainable(undefined)),
    },
    runTransaction: vi.fn((fn: (tx: unknown) => void) => fn(deepChainable())),
  };
});

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', status: 'status', priority: 'priority', dueDate: 'dueDate', connectorType: 'connectorType', sourceId: 'sourceId', parentId: 'parentId', assignee: 'assignee', metadata: 'metadata', description: 'description' },
  tags: { id: 'id', slug: 'slug', name: 'name', color: 'color', type: 'type' },
  taskTags: { taskId: 'taskId', tagId: 'tagId' },
  taskProjects: { taskId: 'taskId', projectId: 'projectId' },
  hubProjects: { id: 'id', name: 'name', description: 'description', color: 'color', icon: 'icon', category: 'category' },
  projectPhases: { id: 'id', projectId: 'projectId' },
  projectPhaseItems: { id: 'id', phaseId: 'phaseId', taskId: 'taskId' },
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  requestContext: { getStore: vi.fn(() => undefined) },
}));

vi.mock('@/lib/ai', () => ({
  getResolvedAIConfig: vi.fn(() => ({ configured: true })),
  getAIModel: vi.fn(() => ({
    model: 'mock-model',
    context: {
      featureId: 'goal-development',
      sensitivity: 'standard',
      allowedRoutes: ['openai'],
      correlationId: 'test-correlation',
    },
  })),
  getAIRouteOutcome: vi.fn(() => ({
    provider: 'openai',
    model: 'mock-model-id',
    fallbackOccurred: false,
  })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(() => Promise.resolve({
    text: JSON.stringify({
      summary: 'Test summary',
      suggestedTasks: [
        { title: 'Task 1', description: 'Do task 1', effort: '~2d', category: 'implementation' },
        { title: 'Task 2', description: 'Do task 2', effort: '~1d', category: 'testing' },
      ],
      suggestedProject: {
        name: 'Test Project',
        description: 'A test project',
        category: 'engineering',
        phases: [{ name: 'Phase 1', description: 'First phase', taskIndices: [0, 1] }],
        estimatedEffortDays: 3,
      },
    }),
    response: { modelId: 'mock-model-id' },
  })),
}));

// ─── GOALS LIST API ─────────────────────────────────────────────────────────

describe('GET /api/goals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty items when no matching tags exist', async () => {
    mockSelect.mockImplementation(() => chainable([]));

    const { GET } = await import('@/app/api/goals/route');
    const request = new Request('http://localhost:3099/api/goals');
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('items');
    expect(data.items).toEqual([]);
    expect(data.counts).toEqual({ goal: 0, idea: 0, brainstorm: 0 });
  });

  it('should accept filter query param', async () => {
    mockSelect.mockImplementation(() => chainable([]));

    const { GET } = await import('@/app/api/goals/route');
    const request = new Request('http://localhost:3099/api/goals?filter=goal');
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('items');
  });

  it('should accept project query param', async () => {
    mockSelect.mockImplementation(() => chainable([]));

    const { GET } = await import('@/app/api/goals/route');
    const request = new Request('http://localhost:3099/api/goals?project=proj-1');
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should default filter to all when not specified', async () => {
    mockSelect.mockImplementation(() => chainable([]));

    const { GET } = await import('@/app/api/goals/route');
    const request = new Request('http://localhost:3099/api/goals');
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should return 500 on internal error', async () => {
    mockSelect.mockImplementation(() => {
      throw new Error('DB failure');
    });

    const { GET } = await import('@/app/api/goals/route');
    const request = new Request('http://localhost:3099/api/goals');
    const response = await GET(request);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toContain('Failed to fetch goals');
  });

  it('exports GET handler', async () => {
    const mod = await import('@/app/api/goals/route');
    expect(mod.GET).toBeDefined();
    expect(typeof mod.GET).toBe('function');
  });
});

// ─── GOALS DEVELOP API ──────────────────────────────────────────────────────

describe('POST /api/goals/develop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 400 when taskId is missing', async () => {
    const { POST } = await import('@/app/api/goals/develop/route');
    const request = new Request('http://localhost:3099/api/goals/develop', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('taskId');
  });

  it('should return 404 when task not found', async () => {
    mockSelect.mockImplementation(() => chainable([]));

    const { POST } = await import('@/app/api/goals/develop/route');
    const request = new Request('http://localhost:3099/api/goals/develop', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'nonexistent' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(404);
  });

  it('should return 503 when AI not configured', async () => {
    const { getResolvedAIConfig } = await import('@/lib/ai');
    vi.mocked(getResolvedAIConfig).mockReturnValueOnce({ configured: false } as ReturnType<typeof getResolvedAIConfig>);

    const { POST } = await import('@/app/api/goals/develop/route');
    const request = new Request('http://localhost:3099/api/goals/develop', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
  });

  it('should return a proposal when task exists', async () => {
    // First call: task lookup returns a task; subsequent calls return empty arrays
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return chainable([{
          id: 'task-1', title: 'Build a dashboard', description: 'Analytics dashboard',
          status: 'todo', priority: 'high', createdAt: '2026-01-01', updatedAt: '2026-01-01',
          metadata: {},
        }]);
      }
      return chainable([]);
    });

    const { POST } = await import('@/app/api/goals/develop/route');
    const request = new Request('http://localhost:3099/api/goals/develop', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('proposal');
    expect(data.proposal).toHaveProperty('summary');
    expect(data.proposal).toHaveProperty('suggestedTasks');
    expect(data.proposal).toHaveProperty('suggestedProject');
  });

  it('exports POST handler', async () => {
    const mod = await import('@/app/api/goals/develop/route');
    expect(mod.POST).toBeDefined();
    expect(typeof mod.POST).toBe('function');
  });
});

// ─── GOALS PROMOTE API ──────────────────────────────────────────────────────

describe('POST /api/goals/promote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 400 when taskId is missing', async () => {
    const { POST } = await import('@/app/api/goals/promote/route');
    const request = new Request('http://localhost:3099/api/goals/promote', {
      method: 'POST',
      body: JSON.stringify({ projectName: 'Test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('taskId');
  });

  it('should return 400 when projectName is missing', async () => {
    const { POST } = await import('@/app/api/goals/promote/route');
    const request = new Request('http://localhost:3099/api/goals/promote', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('should return 404 when task not found', async () => {
    mockSelect.mockImplementation(() => chainable([]));

    const { POST } = await import('@/app/api/goals/promote/route');
    const request = new Request('http://localhost:3099/api/goals/promote', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'nonexistent', projectName: 'My Project' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(404);
  });

  it('should create project from goal with phases and tasks', async () => {
    mockSelect.mockImplementation(() => chainable([{
      id: 'task-1', title: 'Build dashboard', description: 'Analytics',
      status: 'todo', priority: 'high', metadata: {},
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }]));

    const { POST } = await import('@/app/api/goals/promote/route');
    const request = new Request('http://localhost:3099/api/goals/promote', {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        projectName: 'Dashboard Project',
        projectDescription: 'Full analytics dashboard',
        category: 'engineering',
        phases: [
          {
            name: 'Setup',
            description: 'Initial setup phase',
            tasks: [
              { title: 'Setup repo', description: 'Init the repository' },
              { title: 'Add CI', description: 'Configure CI pipeline' },
            ],
          },
          {
            name: 'Build',
            description: 'Core build phase',
            tasks: [
              { title: 'Build UI', description: 'Create components' },
            ],
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data).toHaveProperty('projectId');
    expect(data).toHaveProperty('projectName', 'Dashboard Project');
    expect(data.phasesCreated).toBe(2);
    expect(data.tasksCreated).toBe(3);
  });

  it('should create project without phases', async () => {
    mockSelect.mockImplementation(() => chainable([{
      id: 'task-2', title: 'Quick idea', description: null,
      status: 'todo', priority: 'low', metadata: {},
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }]));

    const { POST } = await import('@/app/api/goals/promote/route');
    const request = new Request('http://localhost:3099/api/goals/promote', {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-2',
        projectName: 'Quick Project',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.phasesCreated).toBe(0);
    expect(data.tasksCreated).toBe(0);
  });

  it('exports POST handler', async () => {
    const mod = await import('@/app/api/goals/promote/route');
    expect(mod.POST).toBeDefined();
    expect(typeof mod.POST).toBe('function');
  });
});
