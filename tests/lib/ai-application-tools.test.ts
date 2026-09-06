import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for the clean, backend-neutral Houston AI tools introduced by
 * the application-workflow parity layer: task-tools (bounded reads + clean
 * task-core mutations), reasoning-tools (day-plan read + organization
 * service), and the Houston memory recall tool (retrieval-core, never the
 * legacy retrieval.ts module).
 */

const aiWorkflowMocks = vi.hoisted(() => ({
  getSummary: vi.fn(async () => ({
    total: 3,
    open: 2,
    overdue: 1,
    critical: 1,
    done: 1,
    bySource: { local: 2 },
    overdueItems: [{
      id: 'task-1',
      title: 'Overdue task',
      status: 'todo',
      microStatus: null,
      dueDate: '2026-01-01',
      priority: 'high',
      source: 'local',
    }],
  })),
  search: vi.fn(async () => [{
    id: 'task-1',
    title: 'Overdue task',
    status: 'todo',
    microStatus: null,
    priority: 'high',
    dueDate: '2026-01-01',
    source: 'local',
    sourceList: 'Work',
    description: null,
  }]),
  listAllTags: vi.fn(async () => [{ id: 'tag-1', name: 'Engineering', type: 'hub', color: '#10b981' }]),
  listTaskTags: vi.fn(async () => [{ id: 'tag-1', name: 'Engineering', type: 'hub', color: '#10b981' }]),
  listSuggestions: vi.fn(async () => ({
    suggestions: [{
      id: 'task-1',
      title: 'Overdue task',
      priority: 'critical',
      dueDate: '2020-01-01',
      connectorType: 'local',
      reason: 'overdue' as const,
    }],
    counts: { open: 12, overdue: 1, dueToday: 0 },
  })),
}));

vi.mock('@/lib/ai/workflow-persistence', () => ({
  getAIWorkflowPersistence: async () => ({
    taskTools: aiWorkflowMocks,
    dayPlan: { listSuggestions: aiWorkflowMocks.listSuggestions },
  }),
}));

const taskCoreMocks = vi.hoisted(() => ({
  getTaskWriteContext: vi.fn(async (taskId: string) => (
    taskId === 'missing'
      ? null
      : {
          task: {
            id: taskId,
            title: 'Ship feature',
            status: 'todo',
            microStatus: null,
            priority: 'medium',
            dueDate: null,
            connectorType: 'local',
            sourceListName: 'Work',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        }
  )),
  mutateTask: vi.fn(async (request: { taskId: string; patch: Record<string, unknown> }): Promise<
    | { kind: 'committed'; task: Record<string, unknown>; recurrenceNextTaskId: string | null }
    | { kind: 'revision-conflict'; currentUpdatedAt: string }
    | { kind: 'not-found' }
  > => ({
    kind: 'committed',
    task: {
      id: request.taskId,
      title: 'Ship feature',
      status: request.patch.status ?? 'todo',
      microStatus: null,
      priority: request.patch.priority ?? 'medium',
      dueDate: null,
      connectorType: 'local',
      sourceListName: 'Work',
      updatedAt: '2026-01-01T01:00:00.000Z',
    },
    recurrenceNextTaskId: null,
  })),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({ mutations: taskCoreMocks }),
}));

vi.mock('@/lib/projects/organization-service', () => ({
  listHubProjects: vi.fn(async () => [{ id: 'proj-1', name: 'Mission Control', description: null, color: '#3b82f6' }]),
  listProjectPhases: vi.fn(async () => [{
    id: 'phase-1',
    name: 'Build',
    projectId: 'proj-1',
    status: 'in_progress',
    estimatedDays: 3,
    startAfterPhaseId: null,
  }]),
}));

const retrieveHoustonMemoriesCore = vi.hoisted(() => vi.fn(async () => ({
  state: 'keyword-only' as const,
  results: [],
  truncated: false,
})));
vi.mock('@/lib/houston-memory/retrieval-core', () => ({ retrieveHoustonMemoriesCore }));

describe('Houston task-tools (clean AI workflow + task-core seams)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the bounded task summary from the AI workflow persistence port', async () => {
    const { taskTools } = await import('@/lib/ai/tools/task-tools');
    const execute = taskTools.getTaskSummary.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ includeOverdueList: true }, {});
    expect(aiWorkflowMocks.getSummary).toHaveBeenCalledWith({
      today: expect.any(String),
      overdueLimit: 10,
    });
    expect(result.total).toBe(3);
    expect(result.overdueItems).toEqual([expect.objectContaining({ id: 'task-1' })]);
  });

  it('searches tasks through the bounded persistence read', async () => {
    const { taskTools } = await import('@/lib/ai/tools/task-tools');
    const execute = taskTools.searchTasks.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown[]>;
    const results = await execute({ query: 'Overdue', limit: 5 }, {});
    expect(aiWorkflowMocks.search).toHaveBeenCalledWith({
      query: 'Overdue',
      status: undefined,
      priority: undefined,
      source: undefined,
      limit: 5,
    });
    expect(results).toEqual([expect.objectContaining({ id: 'task-1' })]);
  });

  it('completes a task through the clean task-core write context and mutation', async () => {
    const { taskTools } = await import('@/lib/ai/tools/task-tools');
    const execute = taskTools.completeTask.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ taskId: 'task-1' }, {});
    expect(taskCoreMocks.getTaskWriteContext).toHaveBeenCalledWith('task-1');
    expect(taskCoreMocks.mutateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      patch: expect.objectContaining({ status: 'done' }),
    }));
    expect(result.success).toBe(true);
    expect(result.status).toBe('done');
  });

  it('reports a not-found error without throwing when the task does not exist', async () => {
    const { taskTools } = await import('@/lib/ai/tools/task-tools');
    const execute = taskTools.updateTaskPriority.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ taskId: 'missing', priority: 'high' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(taskCoreMocks.mutateTask).not.toHaveBeenCalled();
  });

  it('retries a bounded number of times on revision conflicts before giving up', async () => {
    taskCoreMocks.mutateTask.mockResolvedValue({ kind: 'revision-conflict', currentUpdatedAt: 'x' });
    const { taskTools } = await import('@/lib/ai/tools/task-tools');
    const execute = taskTools.updateTaskEffort.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ taskId: 'task-1', effort: 3 }, {});
    expect(result.success).toBe(false);
    expect(taskCoreMocks.mutateTask.mock.calls.length).toBeGreaterThan(1);
  });

  it('lists tags for a task or all tags via the bounded persistence read', async () => {
    const { taskTools } = await import('@/lib/ai/tools/task-tools');
    const execute = taskTools.getTaskTags.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown[]>;
    await execute({ taskId: 'task-1' }, {});
    expect(aiWorkflowMocks.listTaskTags).toHaveBeenCalledWith('task-1');
    await execute({}, {});
    expect(aiWorkflowMocks.listAllTags).toHaveBeenCalled();
  });
});

describe('Houston reasoning-tools (day-plan read + organization service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suggests a day plan from the bounded AI day-plan read', async () => {
    const { reasoningTools } = await import('@/lib/ai/tools/reasoning-tools');
    const execute = reasoningTools.suggestDayPlan.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ availableMinutes: 60 }, {});
    expect(aiWorkflowMocks.listSuggestions).toHaveBeenCalledWith({
      today: expect.any(String),
      limit: 8,
    });
    expect(result.suggestions).toEqual([expect.objectContaining({
      id: 'task-1',
      reason: 'overdue',
    })]);
    // Totals are the adapter's exact aggregates, not the bounded row count.
    expect(result.totalOpen).toBe(12);
    expect(result.totalOverdue).toBe(1);
  });

  it('lists project phases across every project unless a project name matches', async () => {
    const { listProjectPhases } = await import('@/lib/projects/organization-service');
    const { reasoningTools } = await import('@/lib/ai/tools/reasoning-tools');
    const execute = reasoningTools.getProjectPhases.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown[]>;

    await execute({}, {});
    expect(listProjectPhases).toHaveBeenCalledWith({ projectId: null, crossProject: false });

    await execute({ projectName: 'Mission Control' }, {});
    expect(listProjectPhases).toHaveBeenCalledWith({ projectId: 'proj-1', crossProject: false });
  });

  it('lists hub projects through the existing organization service', async () => {
    const { reasoningTools } = await import('@/lib/ai/tools/reasoning-tools');
    const execute = reasoningTools.getProjects.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown[]>;
    const result = await execute({}, {});
    expect(result).toEqual([expect.objectContaining({ id: 'proj-1' })]);
  });

  it('lists project phases through the existing organization service', async () => {
    const { reasoningTools } = await import('@/lib/ai/tools/reasoning-tools');
    const execute = reasoningTools.getProjectPhases.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown[]>;
    const result = await execute({ projectName: 'Mission Control' }, {});
    expect(result).toEqual([expect.objectContaining({ id: 'phase-1' })]);
  });
});

describe('Houston memory recall tool (clean retrieval-core, never legacy retrieval.ts)', () => {
  it('delegates to retrieval-core without dynamically importing the legacy module', async () => {
    const { houstonMemoryTools } = await import('@/lib/ai/tools/houston-memory-tools');
    const execute = houstonMemoryTools.recall_houston_memory.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const result = await execute({ query: 'roadmap decisions', limit: 3 }, {});
    expect(retrieveHoustonMemoriesCore).toHaveBeenCalledWith({ query: 'roadmap decisions', limit: 3 });
    expect(result.state).toBe('keyword-only');
  });
});
