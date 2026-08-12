import { describe, expect, it, vi, beforeEach } from 'vitest';

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === 'get') return () => Array.isArray(terminal) ? terminal[0] : terminal;
      if (prop === 'all') return () => terminal;
      if (prop === 'run') return () => terminal;
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
};
const mockGetCapabilities = vi.fn();
const mockIsConnectorEnabled = vi.fn();
const mockInsertValues = vi.fn();
const mockGetConnector = vi.fn(() => ({ createSubTask: vi.fn() }));
const mockInitializeConnector = vi.fn();
const mockLogWriteThrough = vi.fn();

vi.mock('crypto', () => {
  const createHash = () => {
    let input = '';
    return {
      update(value: string) {
        input = value;
        return this;
      },
      digest() {
        return input.includes('2026-07-30T13:00:00.000Z') ? 'b'.repeat(64) : 'a'.repeat(64);
      },
    };
  };
  const randomUUID = () => 'f1176433-0535-4914-aac5-1f79dca24971';
  return {
    createHash,
    randomUUID,
    default: { createHash, randomUUID },
  };
});
vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: (callback: (tx: typeof mockDb) => unknown) => callback(mockDb),
}));
vi.mock('@/db/schema', () => ({
  hubProjects: { id: 'project_id', name: 'project_name' },
  tags: { id: 'tag_id', name: 'tag_name' },
  taskProjects: { taskId: 'task_id', projectId: 'project_id' },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
  tasks: {
    id: 'id',
    title: 'title',
    status: 'status',
    effort: 'effort',
    parentId: 'parent_id',
  },
}));
vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: mockGetCapabilities,
  isConnectorEnabled: mockIsConnectorEnabled,
}));
vi.mock('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: mockGetConnector },
}));
vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));
vi.mock('@/lib/sync', () => ({
  syncScheduler: { initializeConnectorFromDb: mockInitializeConnector },
  logWriteThrough: mockLogWriteThrough,
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const taskVersion = '2026-07-30T12:00:00.000Z';
const contextVersion = 'a'.repeat(64);
const proposalId = '3d188f4c-7eca-4d17-8cbe-601cc9d6a898';

function request(body: Record<string, unknown>) {
  return new Request('https://mc.example/api/tasks/parent/subtasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer acceptance-test-token',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockReset();
  delete process.env.MC_PUBLIC_DEMO;
  process.env.MC_API_KEY = 'acceptance-test-token';
  mockIsConnectorEnabled.mockResolvedValue(true);
  mockGetCapabilities.mockResolvedValue({ write: true });
  mockInsertValues.mockReturnValue({ run: vi.fn() });
  mockDb.insert.mockReturnValue({ values: mockInsertValues });
});

describe('AI proposal acceptance through the subtask route', () => {
  it('rejects a proposal when the parent task changed', async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([{
        id: 'parent',
        title: 'Parent',
        sourceId: 'local:parent',
        connectorType: 'local',
        connectorInstanceId: 'local',
        updatedAt: '2026-07-30T13:00:00.000Z',
      }]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([{ updatedAt: '2026-07-30T13:00:00.000Z' }]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('changed') }));
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns a previously accepted proposal without inserting again', async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([{
        id: 'parent',
        title: 'Parent',
        sourceId: 'local:parent',
        connectorType: 'local',
        connectorInstanceId: 'local',
        updatedAt: taskVersion,
      }]))
      .mockReturnValueOnce(chainable([{
        id: proposalId,
        title: 'Proposed step',
        status: 'todo',
        effort: 2,
        parentId: 'parent',
      }]))
      .mockReturnValueOnce(chainable([{ updatedAt: taskVersion }]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      effort: 2,
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ duplicate: true }));
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('blocks acceptance for a read-only connector', async () => {
    mockGetCapabilities.mockResolvedValue({
      write: false,
      taskFieldProfile: {
        dependencies: { authority: 'source', writeBack: 'direct' },
      },
    });
    mockDb.select
      .mockReturnValueOnce(chainable([{
        id: 'parent',
        title: 'Parent',
        sourceId: 'remote:parent',
        connectorType: 'github-issues',
        connectorInstanceId: 'github',
        updatedAt: taskVersion,
      }]));

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('disabled') }));
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('blocks acceptance when connector subtask support is disabled', async () => {
    mockGetCapabilities.mockResolvedValue({
      write: true,
      subtasks: false,
      taskFieldProfile: {
        dependencies: { authority: 'source', writeBack: 'direct' },
      },
    });
    mockDb.select.mockReturnValueOnce(chainable([{
      id: 'parent',
      title: 'Parent',
      sourceId: 'remote:parent',
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
      updatedAt: taskVersion,
    }]));

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('does not support') }));
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('atomically inserts a current proposal with its idempotency ID', async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([{
        id: 'parent',
        title: 'Parent',
        sourceId: 'local:parent',
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListId: null,
        sourceListName: null,
        depth: 0,
        updatedAt: taskVersion,
      }]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([{ updatedAt: taskVersion }]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      effort: 2,
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      id: proposalId,
      parentId: 'parent',
      title: 'Proposed step',
      effort: 2,
    }));
  });

  it('creates remote-shaped subtasks locally without connector access in public demo mode', async () => {
    process.env.MC_PUBLIC_DEMO = 'true';
    mockDb.select.mockReturnValueOnce(chainable([{
      id: 'parent',
      title: 'Parent',
      sourceId: 'remote:parent',
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
      sourceListId: 'repo',
      sourceListName: 'Repository',
      depth: 0,
      updatedAt: taskVersion,
    }]));

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({ title: 'Demo-only subtask' }), {
      params: Promise.resolve({ id: 'parent' }),
    });

    expect(response.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Demo-only subtask',
      syncStatus: 'synced',
    }));
    expect(mockIsConnectorEnabled).not.toHaveBeenCalled();
    expect(mockGetCapabilities).not.toHaveBeenCalled();
    expect(mockGetConnector).not.toHaveBeenCalled();
    expect(mockInitializeConnector).not.toHaveBeenCalled();
    expect(mockLogWriteThrough).not.toHaveBeenCalled();
  });

  it('creates Scout subtasks locally without connector mutation or pending push state', async () => {
    mockGetCapabilities.mockResolvedValue({
      write: false,
      subtasks: false,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    });
    mockDb.select.mockReturnValueOnce(chainable([{
      id: 'parent',
      title: 'Scout parent',
      sourceId: 'scout:email:item-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
      sourceListId: 'scout:email-actions',
      sourceListName: 'Email Actions',
      depth: 0,
      updatedAt: taskVersion,
    }]));

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({ title: 'Local Scout subtask' }), {
      params: Promise.resolve({ id: 'parent' }),
    });

    expect(response.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Local Scout subtask',
      syncStatus: 'synced',
    }));
    expect(mockGetConnector).not.toHaveBeenCalled();
    expect(mockInitializeConnector).not.toHaveBeenCalled();
    expect(mockLogWriteThrough).not.toHaveBeenCalled();
  });
});
