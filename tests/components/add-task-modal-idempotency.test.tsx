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
});
