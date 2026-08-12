import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hubProjects,
  projectAutoIncludeExclusions,
  projectHierarchyMutationContext,
  projectPhaseItems,
  projectPhases,
  taskProjects,
} from '@/db/schema';

const membershipRun = vi.fn();
const phaseItemRun = vi.fn();
const phaseInsertRun = vi.fn();
const membershipInsertRun = vi.fn();
const exclusionInsertRun = vi.fn();
const phaseUpdateRun = vi.fn();
const phaseUpdateSet = vi.fn();
const revisionRun = vi.fn();
const phaseRows = vi.fn();
const existingPhaseItem = vi.fn();
const existingProjectMembership = vi.fn();
const selectedPhaseRows = vi.fn();
const mutationContextRun = vi.fn();
const mutationContextDeleteRun = vi.fn();

const tx = {
  insert: vi.fn((table: unknown) => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({ run: membershipInsertRun })),
      onConflictDoUpdate: vi.fn(() => ({ run: exclusionInsertRun })),
      run: table === projectPhaseItems
        ? phaseInsertRun
        : table === projectHierarchyMutationContext
          ? mutationContextRun
          : membershipInsertRun,
    })),
  })),
  delete: vi.fn((table: unknown) => ({
    where: vi.fn(() => ({
      run: table === taskProjects
        ? membershipRun
        : table === projectAutoIncludeExclusions
          ? phaseItemRun
        : table === projectHierarchyMutationContext
          ? mutationContextDeleteRun
          : phaseItemRun,
    })),
  })),
  select: vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      return {
        where: vi.fn(() => ({
          all: table === projectPhases ? phaseRows : vi.fn(),
          get: table === projectPhaseItems
            ? existingPhaseItem
            : table === taskProjects
              ? existingProjectMembership
              : vi.fn(),
        })),
      };
    }),
  })),
  update: vi.fn((table: unknown) => {
    return {
      set: table === projectPhaseItems ? phaseUpdateSet : vi.fn(() => ({
        where: vi.fn(() => ({
          run: revisionRun,
        })),
      })),
    };
  }),
};

phaseUpdateSet.mockImplementation(() => ({
  where: vi.fn(() => ({ run: phaseUpdateRun })),
}));

const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: selectedPhaseRows,
      })),
    })),
  })),
};

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: vi.fn((callback: (transaction: typeof tx) => void) => callback(tx)),
}));

vi.mock('@/lib/tasks/mutation-policy', () => ({
  getStoredTaskMutationPolicy: vi.fn(async (_taskId: string, field: string) => ({
    task: {},
    capabilities: null,
    policy: { field, sourceModel: 'mc-owned', mutation: 'local', inbound: 'local-wins' },
  })),
}));

vi.mock('crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('crypto')>(),
  randomUUID: () => 'phase-item-id',
}));

beforeEach(() => {
  vi.clearAllMocks();
  membershipRun.mockReturnValue({ changes: 1 });
  phaseRows.mockReturnValue([{ id: 'phase-1' }, { id: 'phase-2' }]);
  existingProjectMembership.mockReturnValue({ taskId: 'task-1', projectId: 'project-1' });
  existingPhaseItem.mockReturnValue({
    id: 'existing-phase-item',
    phaseId: 'phase-1',
    taskId: 'task-1',
    sortOrder: 7,
    estimatedEffortHours: 3,
    isProposed: true,
    proposalType: 'split',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  selectedPhaseRows.mockResolvedValue([{ id: 'phase-2' }]);
});

describe('POST /api/hub-projects/[id]/tasks', () => {
  it('replaces the existing project phase when a new phase is selected', async () => {
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');

    const response = await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', phaseId: 'phase-2' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(tx.delete).not.toHaveBeenCalledWith(projectPhaseItems);
    expect(tx.insert).toHaveBeenCalledWith(projectHierarchyMutationContext);
    expect(tx.insert).not.toHaveBeenCalledWith(taskProjects);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(projectPhaseItems);
    expect(phaseUpdateSet).toHaveBeenCalledWith({ phaseId: 'phase-2' });
    expect(phaseUpdateRun).toHaveBeenCalledOnce();
    expect(revisionRun).toHaveBeenCalledOnce();
    expect(mutationContextRun).toHaveBeenCalledOnce();
    expect(mutationContextDeleteRun).toHaveBeenCalledOnce();
    expect(phaseInsertRun).not.toHaveBeenCalled();
  });

  it('removes phase placement when No phase is selected', async () => {
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');

    const response = await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', phaseId: null }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(phaseItemRun).toHaveBeenCalledOnce();
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(phaseInsertRun).not.toHaveBeenCalled();
  });

  it('does not advance the revision when the selected phase is unchanged', async () => {
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');

    const response = await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', phaseId: 'phase-1' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(revisionRun).not.toHaveBeenCalled();
  });

  it('rejects a phase outside the project before mutating membership', async () => {
    phaseRows.mockReturnValue([{ id: 'phase-1' }]);
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');

    const response = await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', phaseId: 'other-project-phase' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/hub-projects/[id]/tasks', () => {
  it('removes project-scoped phase placement and advances the hierarchy revision', async () => {
    const { DELETE } = await import('@/app/api/hub-projects/[id]/tasks/route');

    const response = await DELETE(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'DELETE',
        body: JSON.stringify({ taskId: 'task-1' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(tx.delete).toHaveBeenNthCalledWith(1, taskProjects);
    expect(tx.delete).toHaveBeenNthCalledWith(2, projectPhaseItems);
    expect(tx.insert).toHaveBeenCalledWith(projectAutoIncludeExclusions);
    expect(exclusionInsertRun).toHaveBeenCalledOnce();
    expect(phaseItemRun).toHaveBeenCalledOnce();
    expect(revisionRun).toHaveBeenCalledOnce();
  });

  it('does not mutate phase placement for a missing project membership', async () => {
    membershipRun.mockReturnValue({ changes: 0 });
    const { DELETE } = await import('@/app/api/hub-projects/[id]/tasks/route');

    const response = await DELETE(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'DELETE',
        body: JSON.stringify({ taskId: 'task-1' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(phaseItemRun).not.toHaveBeenCalled();
    expect(revisionRun).not.toHaveBeenCalled();
  });
});
