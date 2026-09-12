import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddTaskModal } from '@/components/add-task/AddTaskModal';
import { TooltipProvider } from '@/components/ui/Tooltip';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AddTaskModal submission guard', () => {
  it('applies Quick Add semantic tokens during mobile capture', async () => {
    const taskBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks') {
        taskBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response(JSON.stringify({ id: 'task-1' })));
      }
      if (url === '/api/tags') {
        return Promise.resolve(new Response(JSON.stringify({
          tags: [{ id: 'tag-ops', name: 'ops', slug: 'ops', color: null }],
        })));
      }
      if (url === '/api/hub-projects') {
        return Promise.resolve(new Response(JSON.stringify({
          projects: [{ id: 'project-launch', name: 'Launch', color: '#3b82f6' }],
        })));
      }
      if (url === '/api/subtask-templates') {
        return Promise.resolve(new Response(JSON.stringify({ templates: [] })));
      }
      if (url === '/api/connectors/work/lists') {
        return Promise.resolve(new Response(JSON.stringify({ sourceLists: [] })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    vi.stubGlobal('fetch', fetchMock);

    const localDestination: ComponentProps<typeof AddTaskModal>['initialDestination'] = {
      id: 'local',
      label: 'Local',
      connectorType: 'local',
      account: null,
      color: '#64748b',
    };
    const workDestination: ComponentProps<typeof AddTaskModal>['initialDestination'] = {
      id: 'work',
      label: 'Work',
      connectorType: 'microsoft-todo',
      account: 'work',
      color: '#3b82f6',
    };

    render(
      <TooltipProvider>
        <AddTaskModal
          initialInput=""
          initialParsed={null}
          initialDestination={localDestination}
          destinations={[localDestination, workDestination]}
          enableQuickAddSemantics
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    const titleInput = screen.getByPlaceholderText('Task, date, #tag, !priority…');
    fireEvent.change(titleInput, {
      target: { value: 'Ship release !high #ops +Launch ^3 ~soon ~30m weekly @work' },
    });

    await screen.findByText('#ops');
    await waitFor(() => expect(screen.getByText('+Launch')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add Task' }));

    await waitFor(() => expect(taskBodies).toHaveLength(1));
    expect(taskBodies[0]).toEqual(expect.objectContaining({
      title: 'Ship release',
      priority: 'high',
      planningHorizon: 'soon',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'work',
      tags: ['tag-ops'],
      tagSlugs: [],
      projectIds: ['project-launch'],
      estimatedDuration: 30,
      effort: 3,
      recurrence: 'weekly',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Task' }));

    await waitFor(() => expect(taskBodies).toHaveLength(2));
    expect(taskBodies[1]).toEqual(expect.objectContaining({
      connectorType: 'local',
    }));
    expect(taskBodies[1]).not.toHaveProperty('connectorInstanceId');
  });

  it('sends one task request when submit is triggered twice before React rerenders', async () => {
    let resolveTaskRequest: ((response: Response) => void) | undefined;
    const taskRequest = new Promise<Response>((resolve) => {
      resolveTaskRequest = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url === '/api/tasks') return taskRequest;
      if (url === '/api/tags') {
        return Promise.resolve(new Response(JSON.stringify({ tags: [] })));
      }
      if (url === '/api/hub-projects') {
        return Promise.resolve(new Response(JSON.stringify({ projects: [] })));
      }
      if (url === '/api/subtask-templates') {
        return Promise.resolve(new Response(JSON.stringify({ templates: [] })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    vi.stubGlobal('fetch', fetchMock);

    const destination: ComponentProps<typeof AddTaskModal>['initialDestination'] = {
      id: 'local',
      label: 'Local',
      connectorType: 'local',
      account: null,
      color: '#999999',
    };

    render(
      <TooltipProvider>
        <AddTaskModal
          initialInput="Create one task"
          initialParsed={null}
          initialDestination={destination}
          destinations={[destination]}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
          triageItemId="triage-item-1"
        />
      </TooltipProvider>,
    );

    const submit = screen.getByRole('button', { name: 'Add Task' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/tasks')).toHaveLength(1);
    const taskCall = fetchMock.mock.calls.find(([url]) => url === '/api/tasks');
    expect(JSON.parse(String(taskCall?.[1]?.body))).toEqual(
      expect.objectContaining({ triageItemId: 'triage-item-1' }),
    );

    resolveTaskRequest?.(new Response(JSON.stringify({ id: 'task-1' })));
    await waitFor(() => expect(screen.queryByText('Adding...')).not.toBeInTheDocument());
  });

  it('defers a preselected project assignment to the caller when requested', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'task-1' })));
      }
      if (url === '/api/tags') {
        return Promise.resolve(new Response(JSON.stringify({ tags: [] })));
      }
      if (url === '/api/hub-projects') {
        return Promise.resolve(new Response(JSON.stringify({
          projects: [{ id: 'project-1', name: 'Project 1', color: '#3b82f6' }],
        })));
      }
      if (url === '/api/subtask-templates') {
        return Promise.resolve(new Response(JSON.stringify({ templates: [] })));
      }
      void init;
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    vi.stubGlobal('fetch', fetchMock);
    const destination: ComponentProps<typeof AddTaskModal>['initialDestination'] = {
      id: 'local',
      label: 'Local',
      connectorType: 'local',
      account: null,
      color: '#999999',
    };

    render(
      <TooltipProvider>
        <AddTaskModal
          initialInput="Create project task"
          initialParsed={null}
          initialDestination={destination}
          destinations={[destination]}
          initialProjectId="project-1"
          deferProjectAssignment
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Task' }));

    await waitFor(() => {
      const taskCall = fetchMock.mock.calls.find(([url]) => url === '/api/tasks');
      expect(JSON.parse(String(taskCall?.[1]?.body))).toEqual(
        expect.objectContaining({ projectIds: [] }),
      );
    });
  });

  it('retains batch organization and clears task-specific fields when adding another task', async () => {
    const taskBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks') {
        taskBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response(JSON.stringify({ id: `task-${taskBodies.length}` })));
      }
      if (url === '/api/tags') {
        return Promise.resolve(new Response(JSON.stringify({
          tags: [{ id: 'tag-1', name: '3dprint', slug: '3dprint', color: null }],
        })));
      }
      if (url === '/api/hub-projects') {
        return Promise.resolve(new Response(JSON.stringify({
          projects: [{ id: 'project-1', name: '3D Models', color: '#3b82f6' }],
        })));
      }
      if (url === '/api/subtask-templates') {
        return Promise.resolve(new Response(JSON.stringify({ templates: [] })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    vi.stubGlobal('fetch', fetchMock);
    const destination: ComponentProps<typeof AddTaskModal>['initialDestination'] = {
      id: 'local',
      label: 'Local',
      connectorType: 'local',
      account: null,
      color: '#3b82f6',
    };

    render(
      <TooltipProvider>
        <AddTaskModal
          initialInput=""
          initialParsed={null}
          initialDestination={destination}
          destinations={[destination]}
          initialProjectId="project-1"
          prefill={{
            title: 'First task',
            description: 'Only for the first task',
            tags: ['3dprint', 'new-tag'],
            dueDate: '2026-09-10',
            priority: 'high',
            planningHorizon: 'now',
          }}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    await screen.findByText('3dprint');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add another' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Task' }));

    const titleInput = screen.getByPlaceholderText('What needs to be done?');
    await waitFor(() => expect(titleInput).toHaveValue(''));
    fireEvent.change(titleInput, { target: { value: 'Second task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Task' }));

    await waitFor(() => expect(taskBodies).toHaveLength(2));
    expect(taskBodies[1]).toEqual(expect.objectContaining({
      title: 'Second task',
      priority: 'none',
      planningHorizon: null,
      tags: ['tag-1'],
      tagSlugs: ['new-tag'],
      projectIds: ['project-1'],
    }));
    expect(taskBodies[1]).not.toHaveProperty('description');
    expect(taskBodies[1]).not.toHaveProperty('dueDate');
  });
});
