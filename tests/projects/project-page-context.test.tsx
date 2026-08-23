import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import { ProjectHierarchyClientError } from '@/lib/projects/hierarchy-client';
import {
  ProjectPageProvider,
  useProjectPageData,
  useProjectPageMutations,
  useProjectPageTaskInteractions,
} from '@/app/projects/[id]/context';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const mocks = vi.hoisted(() => ({
  loadHierarchy: vi.fn(),
  executeHierarchyCommand: vi.fn(),
}));

vi.mock('@/lib/projects/hierarchy-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects/hierarchy-client')>();
  return {
    ...actual,
    loadProjectHierarchy: mocks.loadHierarchy,
    executeProjectHierarchyCommand: mocks.executeHierarchyCommand,
  };
});

vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({ progress: { refetchKey: 0 } }),
}));

vi.mock('@/lib/hooks/useQuickAddContext', () => ({
  useQuickAddContext: () => ({
    setQuickAddFilter: vi.fn(),
    clearQuickAddFilter: vi.fn(),
  }),
}));

const phase = {
  id: 'phase-1',
  projectId: 'project-1',
  name: 'Plan',
  description: null,
  status: 'pending' as const,
  color: '#3b82f6',
  estimatedDays: null,
  targetStart: null,
  targetEnd: null,
  startAfterPhaseId: null,
  sortOrder: 0,
  completedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const task = {
  id: 'task-1',
  title: 'Shared task',
  status: 'todo' as const,
  priority: 'medium' as const,
  dueDate: null,
  updatedAt: '2026-08-14T12:00:00.000Z',
  connectorType: 'local',
  connectorInstanceId: 'local',
  hubProjectIds: ['project-1'],
  projectPhaseMemberships: [],
  localDisposition: 'active' as const,
  taskSourceModel: 'mc-owned' as const,
  editPolicy: editableTaskPolicy,
};

const hierarchy: ProjectHierarchySnapshot = {
  projectId: 'project-1',
  revision: 4,
  phases: [phase],
  phaseItemsByPhase: {
    [phase.id]: [{
      id: 'item-1',
      phaseId: phase.id,
      taskId: task.id,
      sortOrder: 0,
      estimatedEffortHours: null,
      isProposed: false,
      proposalType: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    }],
  },
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function GuardProbe({ hook }: { hook: () => unknown }) {
  hook();
  return null;
}

function SharedStateProbe({
  onDataRender,
  onMutationRender,
}: {
  onDataRender?: (value: unknown) => void;
  onMutationRender?: (value: unknown) => void;
}) {
  const data = useProjectPageData();
  const mutations = useProjectPageMutations();
  const interactions = useProjectPageTaskInteractions();

  useEffect(() => {
    onDataRender?.(data);
  }, [data, onDataRender]);
  useEffect(() => {
    onMutationRender?.(mutations);
  }, [mutations, onMutationRender]);

  if (data.loading) return <p>Loading provider</p>;
  return (
    <div>
      <p>{data.project?.name}</p>
      <p>{data.progress.percentComplete}% complete</p>
      <p>{data.phaseEntries[phase.id]?.[0]?.task.title}</p>
      <p>{data.taskToPhase.get(task.id)?.name}</p>
      <p>{interactions.selectedTaskId ?? 'No selection'}</p>
      <p>{interactions.detailMode}</p>
      <button type="button" onClick={() => interactions.toggleTask(task.id)}>
        Toggle task
      </button>
      <button type="button" onDoubleClick={() => interactions.handleTaskDoubleClick(task.id)}>
        Open task fullscreen
      </button>
    </div>
  );
}

function HierarchyProbe() {
  const data = useProjectPageData();
  const mutations = useProjectPageMutations();
  if (data.loading) return <p>Loading hierarchy</p>;

  return (
    <div>
      <p>{data.phases[0]?.name}</p>
      <button
        type="button"
        onClick={() => {
          void mutations.runHierarchyCommand({
            type: 'move_tasks',
            taskIds: [task.id],
            toPhaseId: null,
            toIndex: 0,
          }, {
            undoLabel: 'Moved task',
            announcement: 'Moved Shared task',
          }).catch(() => {});
        }}
      >
        Move task
      </button>
    </div>
  );
}

describe('ProjectPageContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    mocks.loadHierarchy.mockResolvedValue(hierarchy);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/hub-projects/project-1') {
        return jsonResponse({
          project: {
            id: 'project-1',
            name: 'Context project',
            description: null,
            color: '#3b82f6',
            icon: null,
            iconColor: null,
            sourceBindings: [],
            autoIncludeRules: [],
            kanbanColumns: [],
            defaultView: 'list',
            status: 'active',
            statusOverride: null,
            category: null,
            targetDate: null,
            startedAt: null,
            completedAt: null,
            sortOrder: 0,
            metadata: {},
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        });
      }
      if (url.startsWith('/api/tasks?')) return jsonResponse({ tasks: [task] });
      if (url === '/api/hub-projects?includePhases=true') return jsonResponse({ projects: [] });
      if (url === '/api/my-day') return jsonResponse({ items: [] });
      return jsonResponse({});
    }));
  });

  it.each([
    ['data', useProjectPageData],
    ['mutations', useProjectPageMutations],
    ['task interactions', useProjectPageTaskInteractions],
  ])('guards the %s hook outside its provider', (_label, hook) => {
    expect(() => render(<GuardProbe hook={hook} />))
      .toThrow(/ProjectPageProvider/);
  });

  it('propagates one coherent project snapshot and cross-surface task selection', async () => {
    render(
      <ProjectPageProvider projectId="project-1">
        <SharedStateProbe />
      </ProjectPageProvider>,
    );

    expect(await screen.findByText('Context project')).toBeInTheDocument();
    expect(screen.getByText('0% complete')).toBeInTheDocument();
    expect(screen.getByText('Shared task')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('No selection')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle task' }));
    expect(screen.getByText(task.id)).toBeInTheDocument();
  });

  it('opens a double-clicked task in the detail dialog', async () => {
    render(
      <ProjectPageProvider projectId="project-1">
        <SharedStateProbe />
      </ProjectPageProvider>,
    );

    await screen.findByText('Context project');
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Open task fullscreen' }));

    expect(screen.getByText(task.id)).toBeInTheDocument();
    expect(screen.getByText('dialog')).toBeInTheDocument();
  });

  it('does not churn read or mutation contracts for selection-only updates', async () => {
    const dataValues: unknown[] = [];
    const mutationValues: unknown[] = [];
    render(
      <ProjectPageProvider projectId="project-1">
        <SharedStateProbe
          onDataRender={(value) => dataValues.push(value)}
          onMutationRender={(value) => mutationValues.push(value)}
        />
      </ProjectPageProvider>,
    );

    await screen.findByText('Context project');
    const dataValue = dataValues.at(-1);
    const mutationValue = mutationValues.at(-1);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle task' }));
    await waitFor(() => expect(screen.getByText(task.id)).toBeInTheDocument());

    expect(dataValues.at(-1)).toBe(dataValue);
    expect(mutationValues.at(-1)).toBe(mutationValue);
  });

  it('ignores a stale project response after the route identity changes', async () => {
    let resolveFirstProject!: (response: Response) => void;
    mocks.loadHierarchy.mockImplementation(async (projectId: string) => ({
      ...hierarchy,
      projectId,
      phases: [{ ...phase, projectId }],
    }));
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/hub-projects/project-1') {
        return new Promise<Response>((resolve) => {
          resolveFirstProject = resolve;
        });
      }
      if (url === '/api/hub-projects/project-2') {
        return jsonResponse({
          project: {
            id: 'project-2',
            name: 'Current project',
            description: null,
            color: '#3b82f6',
            icon: null,
            iconColor: null,
            sourceBindings: [],
            autoIncludeRules: [],
            kanbanColumns: [],
            defaultView: 'list',
            status: 'active',
            statusOverride: null,
            category: null,
            targetDate: null,
            startedAt: null,
            completedAt: null,
            sortOrder: 0,
            metadata: {},
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        });
      }
      if (url.startsWith('/api/tasks?')) return jsonResponse({ tasks: [task] });
      if (url === '/api/hub-projects?includePhases=true') return jsonResponse({ projects: [] });
      if (url === '/api/my-day') return jsonResponse({ items: [] });
      return jsonResponse({});
    });

    const view = render(
      <ProjectPageProvider projectId="project-1">
        <SharedStateProbe />
      </ProjectPageProvider>,
    );
    await waitFor(() => expect(resolveFirstProject).toBeTypeOf('function'));

    view.rerender(
      <ProjectPageProvider projectId="project-2">
        <SharedStateProbe />
      </ProjectPageProvider>,
    );
    expect(await screen.findByText('Current project')).toBeInTheDocument();

    resolveFirstProject(jsonResponse({
      project: {
        id: 'project-1',
        name: 'Stale project',
      },
    }));
    await waitFor(() => {
      expect(screen.queryByText('Stale project')).not.toBeInTheDocument();
    });
  });

  it('reconciles a hierarchy conflict with the authoritative snapshot and tasks', async () => {
    const reconciledHierarchy: ProjectHierarchySnapshot = {
      ...hierarchy,
      revision: 5,
      phases: [{ ...phase, name: 'Reconciled plan' }],
      phaseItemsByPhase: { [phase.id]: [] },
    };
    mocks.executeHierarchyCommand.mockRejectedValueOnce(
      new ProjectHierarchyClientError(
        'Hierarchy revision conflict',
        409,
        'HIERARCHY_REVISION_CONFLICT',
        reconciledHierarchy,
      ),
    );

    render(
      <ProjectPageProvider projectId="project-1">
        <HierarchyProbe />
      </ProjectPageProvider>,
    );
    expect(await screen.findByText('Plan')).toBeInTheDocument();
    const taskLoadsBeforeConflict = vi.mocked(fetch).mock.calls.filter(([input]) => (
      String(input).startsWith('/api/tasks?')
    )).length;

    fireEvent.click(screen.getByRole('button', { name: 'Move task' }));

    expect(await screen.findByText('Reconciled plan')).toBeInTheDocument();
    expect(mocks.executeHierarchyCommand).toHaveBeenCalledWith({
      projectId: 'project-1',
      expectedRevision: 4,
      commandId: expect.any(String),
      command: {
        type: 'move_tasks',
        taskIds: [task.id],
        toPhaseId: null,
        toIndex: 0,
      },
    });
    await waitFor(() => {
      const taskLoadsAfterConflict = vi.mocked(fetch).mock.calls.filter(([input]) => (
        String(input).startsWith('/api/tasks?')
      )).length;
      expect(taskLoadsAfterConflict).toBe(taskLoadsBeforeConflict + 1);
    });
  });
});
