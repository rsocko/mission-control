import { describe, expect, it, vi } from 'vitest';
import type { ProjectHierarchyPersistence } from '@/db/persistence/project-hierarchy';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';

/**
 * Poisoned-SQLite proof for the L15 owned surface: with a PostgreSQL-shaped
 * worker composition and a throwing `@/db`, every handler on the four owned
 * routes plus the clean service must import and run. Any static or dynamic
 * SQLite reach fails the whole file at import time.
 */

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const PROJECT_ID = 'poisoned-project';
const PHASE_ID = 'poisoned-phase';
const TASK_ID = 'poisoned-task';
const ITEM_ID = 'poisoned-item';

const item = {
  id: ITEM_ID,
  phaseId: PHASE_ID,
  taskId: TASK_ID,
  sortOrder: 0,
  estimatedEffortHours: null,
  isProposed: false,
  proposalType: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const hierarchy: ProjectHierarchySnapshot = {
  projectId: PROJECT_ID,
  revision: 4,
  phases: [{
    id: PHASE_ID,
    projectId: PROJECT_ID,
    name: 'Phase',
    description: null,
    status: 'pending',
    color: null,
    estimatedDays: null,
    targetStart: null,
    targetEnd: null,
    startAfterPhaseId: null,
    sortOrder: 0,
    completedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  phaseItemsByPhase: { [PHASE_ID]: [item] },
};

const calls = vi.hoisted(() => ({
  applyAuthorizedCommand: vi.fn(),
  findCommittedCommand: vi.fn(),
}));

const hierarchyRepository: ProjectHierarchyPersistence = {
  getSnapshot: async (projectId) => (projectId === PROJECT_ID ? hierarchy : null),
  findCommittedCommand: calls.findCommittedCommand.mockResolvedValue(null),
  applyAuthorizedCommand: calls.applyAuthorizedCommand.mockImplementation(
    async (input) => ({
      commandId: input.request.commandId,
      revision: hierarchy.revision + 1,
      hierarchy,
      inverseCommand: { type: 'reorder_phases', orderedPhaseIds: [PHASE_ID] },
    }),
  ),
  findPhaseProjectId: async (phaseId) => (phaseId === PHASE_ID ? PROJECT_ID : null),
  listPhaseItems: async (phaseId) => (phaseId === PHASE_ID ? [item] : []),
  findPhaseItemTask: async (phaseId, itemId) => (
    phaseId === PHASE_ID && itemId === ITEM_ID ? TASK_ID : null
  ),
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    projectAutomation: { hierarchy: hierarchyRepository },
  }),
}));

vi.mock('@/lib/tasks/mutation-policy', () => ({
  getStoredTaskMutationPolicy: vi.fn(async (_taskId: string, field: string) => ({
    task: {},
    capabilities: null,
    policy: { field, sourceModel: 'mc-owned', mutation: 'local', inbound: 'local-wins' },
  })),
}));

const BASE = 'http://localhost:3099';

describe('poisoned-SQLite project-hierarchy web surface', () => {
  it('serves phase-item reads and mutations without evaluating SQLite', async () => {
    const route = await import('@/app/api/project-phases/[id]/items/route');
    const params = { params: Promise.resolve({ id: PHASE_ID }) };

    const list = await route.GET(
      new Request(`${BASE}/api/project-phases/${PHASE_ID}/items`),
      params,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [item] });

    const created = await route.POST(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}/items`,
      { method: 'POST', body: JSON.stringify({ taskId: TASK_ID }) },
    ), params);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ item });

    const patched = await route.PATCH(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}/items?item_id=${ITEM_ID}`,
      { method: 'PATCH', body: JSON.stringify({ estimatedEffortHours: 2 }) },
    ), params);
    expect(patched.status).toBe(200);

    const missing = await route.PATCH(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}/items?item_id=other`,
      { method: 'PATCH', body: JSON.stringify({ estimatedEffortHours: 2 }) },
    ), params);
    expect(missing.status).toBe(404);

    const removed = await route.DELETE(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}/items?task_id=${TASK_ID}`,
      { method: 'DELETE' },
    ), params);
    expect(removed.status).toBe(200);
  });

  it('serves the hierarchy route reads and commands without evaluating SQLite', async () => {
    const route = await import('@/app/api/projects/[id]/hierarchy/route');
    const params = { params: Promise.resolve({ id: PROJECT_ID }) };

    const read = await route.GET(new Request(`${BASE}/api/projects/${PROJECT_ID}/hierarchy`), params);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ hierarchy });

    const notFound = await route.GET(
      new Request(`${BASE}/api/projects/other/hierarchy`),
      { params: Promise.resolve({ id: 'other' }) },
    );
    expect(notFound.status).toBe(404);

    const applied = await route.POST(new Request(
      `${BASE}/api/projects/${PROJECT_ID}/hierarchy`,
      {
        method: 'POST',
        body: JSON.stringify({
          commandId: '20000000-0000-4000-8000-000000000001',
          expectedRevision: 4,
          command: { type: 'reorder_phases', orderedPhaseIds: [PHASE_ID] },
        }),
      },
    ), params);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ revision: 5 });

    const invalid = await route.POST(new Request(
      `${BASE}/api/projects/${PROJECT_ID}/hierarchy`,
      { method: 'POST', body: JSON.stringify({ commandId: 'nope' }) },
    ), params);
    expect(invalid.status).toBe(400);
  });

  it('serves project membership and phase reorder routes without evaluating SQLite', async () => {
    const membership = await import('@/app/api/hub-projects/[id]/tasks/route');
    const params = { params: Promise.resolve({ id: PROJECT_ID }) };

    const assigned = await membership.POST(new Request(
      `${BASE}/api/hub-projects/${PROJECT_ID}/tasks`,
      { method: 'POST', body: JSON.stringify({ taskId: TASK_ID, phaseId: PHASE_ID }) },
    ), params);
    expect(assigned.status).toBe(200);

    const unassigned = await membership.DELETE(new Request(
      `${BASE}/api/hub-projects/${PROJECT_ID}/tasks`,
      { method: 'DELETE', body: JSON.stringify({ taskId: TASK_ID }) },
    ), params);
    expect(unassigned.status).toBe(200);

    const reorder = await import('@/app/api/project-phases/[id]/items/reorder/route');
    const reordered = await reorder.PUT(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}/items/reorder`,
      { method: 'PUT', body: JSON.stringify({ orderedTaskIds: [TASK_ID] }) },
    ), { params: Promise.resolve({ id: PHASE_ID }) });
    expect(reordered.status).toBe(200);
    expect(await reordered.json()).toEqual({ items: [item] });
  });

  it('resolves the clean service directly against the selected repository', async () => {
    const service = await import('@/lib/projects/hierarchy-service');

    await expect(service.getProjectHierarchySnapshot(PROJECT_ID)).resolves.toEqual(hierarchy);
    await expect(service.getProjectHierarchySnapshot('other')).resolves.toBeNull();
    await expect(service.listProjectPhaseItems(PHASE_ID)).resolves.toEqual([item]);
    await expect(service.findProjectPhaseItemTaskId(PHASE_ID, ITEM_ID)).resolves.toBe(TASK_ID);
    await expect(service.assignTasksToProject({
      projectId: PROJECT_ID,
      taskIds: [TASK_ID],
    })).resolves.toMatchObject({ revision: 5 });
    await expect(service.removeTasksFromProjectPhase({
      phaseId: 'unknown-phase',
      taskIds: [TASK_ID],
    })).rejects.toMatchObject({ status: 404, code: 'PHASE_NOT_IN_PROJECT' });

    calls.findCommittedCommand.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      request: {
        commandId: '20000000-0000-4000-8000-000000000002',
        expectedRevision: 4,
        command: { type: 'reorder_phases', orderedPhaseIds: [PHASE_ID] },
      },
      result: { commandId: 'replayed', revision: 4, hierarchy, inverseCommand: null },
    });
    await expect(service.applyProjectHierarchyCommand({
      projectId: PROJECT_ID,
      request: {
        // Same values, different key order: replay must be canonical.
        command: { orderedPhaseIds: [PHASE_ID], type: 'reorder_phases' },
        expectedRevision: 4,
        commandId: '20000000-0000-4000-8000-000000000002',
      },
    })).resolves.toMatchObject({ commandId: 'replayed' });
  });

  it('constructs the PostgreSQL adapter without evaluating SQLite', async () => {
    const { createPostgresProjectHierarchyRepository } = await import(
      '@/db/postgres/repositories/project-hierarchy-repository'
    );
    expect(() => createPostgresProjectHierarchyRepository({} as never)).not.toThrow();

    const statements: string[] = [];
    const client = {
      async query(text: string) {
        statements.push(text);
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };
    const repository = createPostgresProjectHierarchyRepository({
      connect: async () => client,
    } as never);

    await expect(repository.applyAuthorizedCommand({
      projectId: PROJECT_ID,
      request: {
        commandId: '20000000-0000-4000-8000-000000000003',
        expectedRevision: 0,
        command: { type: 'reorder_phases', orderedPhaseIds: [PHASE_ID] },
      },
    })).rejects.toMatchObject({ status: 404, code: 'PROJECT_NOT_FOUND' });

    const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_lock'));
    const beginIndex = statements.findIndex((sql) => (
      sql.includes('BEGIN ISOLATION LEVEL SERIALIZABLE')
    ));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeGreaterThan(lockIndex);
    expect(statements).toContain('ROLLBACK');
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
  });
});
