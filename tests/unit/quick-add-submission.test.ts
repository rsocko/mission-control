import { describe, expect, it, vi } from 'vitest';
import {
  applyQuickAddWorkflowTemplate,
  createQuickAddTask,
  fetchQuickAddSuggestion,
  getQuickAddSubmissionMessage,
  mergeQuickAddSuggestions,
  planQuickAddSubmission,
  prepareQuickAddTasks,
  resolveQuickAddDestination,
  submitQuickAdd,
  undoQuickAddTasks,
} from '@/lib/quick-add/submission';
import type {
  QuickAddDestination,
  QuickAddPendingTask,
} from '@/components/add-task/quick-add-types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const localDestination: QuickAddDestination = {
  id: 'local',
  label: 'Local',
  shortLabel: 'Local',
  connectorType: 'local',
  account: null,
  color: '#000',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function task(
  text: string,
  parentIndex: number | null = null,
  isComplete = false,
): QuickAddPendingTask {
  return { id: text, text, parentIndex, isComplete };
}

describe('Quick Add submission planning', () => {
  it('reuses compound parsing while preserving pending tasks', () => {
    expect(prepareQuickAddTasks(
      'Email Sarah and call dentist',
      [task('Already queued')],
    )).toEqual([
      task('Already queued'),
      { id: 'current-0', text: 'Email Sarah', parentIndex: null, isComplete: false },
      { id: 'current-1', text: 'call dentist', parentIndex: null, isComplete: false },
    ]);
  });

  it('resolves destination lists from the selected pill before context defaults', () => {
    expect(resolveQuickAddDestination(
      { ...localDestination, listId: 'selected', listName: 'Selected' },
      'context',
      'Context',
    )).toEqual({
      listId: 'selected',
      listName: 'Selected',
      requiresSelection: false,
    });
  });

  it('blocks required destinations until a list is resolved', () => {
    const plan = planQuickAddSubmission({
      input: 'Create issue',
      pendingTasks: [],
      destination: { ...localDestination, listSelectionMode: 'required' },
      projectsLoadState: 'ready',
    });

    expect(plan.block).toEqual({ reason: 'destination-required' });
  });

  it.each([
    ['loading', 'project-loading'],
    ['error', 'project-load-error'],
    ['ready', 'project-not-found'],
  ] as const)('reports unresolved projects when project loading is %s', (loadState, reason) => {
    const plan = planQuickAddSubmission({
      input: 'Ship release +Missing',
      pendingTasks: [],
      destination: localDestination,
      parseOptions: { projects: [] },
      projectsLoadState: loadState,
    });

    expect(plan.block).toEqual({ reason, projectName: 'Missing' });
  });

  it('lets resolved destination context and known project tokens proceed', () => {
    const plan = planQuickAddSubmission({
      input: 'Ship release +"Website refresh"',
      pendingTasks: [],
      destination: { ...localDestination, listSelectionMode: 'required' },
      contextListId: 'context-list',
      contextListName: 'Context list',
      parseOptions: { projects: [{ id: 'project-2', name: 'Website refresh' }] },
      projectsLoadState: 'ready',
    });

    expect(plan.block).toBeNull();
    expect(plan.destination).toMatchObject({
      listId: 'context-list',
      listName: 'Context list',
    });
  });
});

describe('Quick Add task creation', () => {
  it('merges defaults into the task request and applies the contextual project', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: 'task-1', editPolicy: editableTaskPolicy })
    );

    await createQuickAddTask({ fetcher }, {
      task: task('Ship release #release'),
      destination: {
        ...localDestination,
        id: 'connector-1',
        connectorType: 'microsoft-todo',
      },
      resolvedDestination: { listId: 'list-1', listName: 'Work', requiresSelection: false },
      defaultTags: ['default', 'release'],
      addToMyDay: false,
      contextProject: { id: 'project-default', name: 'Default project' },
      contextProjectActive: true,
    });

    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      title: 'Ship release',
      connectorInstanceId: 'connector-1',
      sourceListId: 'list-1',
      sourceListName: 'Work',
      projectIds: ['project-default'],
      tagSlugs: ['release', 'default'],
    });
  });

  it('lets an explicit project token override the contextual default', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: 'task-1', editPolicy: editableTaskPolicy })
    );

    await createQuickAddTask({ fetcher }, {
      task: task('Ship release +"Explicit project"'),
      destination: localDestination,
      resolvedDestination: { requiresSelection: false },
      addToMyDay: false,
      contextProject: { id: 'project-default', name: 'Default project' },
      contextProjectActive: true,
      parseOptions: { projects: [{ id: 'project-explicit', name: 'Explicit project' }] },
    });

    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).projectIds).toEqual([
      'project-explicit',
    ]);
  });

  it('marks completed tasks done and emits My Day details without failing creation', async () => {
    const onMyDayItemAdded = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks') {
        return jsonResponse({ id: 'task-1', editPolicy: editableTaskPolicy });
      }
      if (url === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return jsonResponse({});
      }
      if (url === '/api/my-day') return jsonResponse({});
      return jsonResponse({}, 404);
    });

    await createQuickAddTask({
      fetcher,
      getToday: () => '2026-08-15',
      onMyDayItemAdded,
    }, {
      task: task('Completed task', null, true),
      destination: localDestination,
      resolvedDestination: { listName: 'Inbox', requiresSelection: false },
      addToMyDay: true,
      contextProject: null,
      contextProjectActive: false,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ status: 'done' });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      taskId: 'task-1',
      date: '2026-08-15',
    });
    expect(onMyDayItemAdded).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      status: 'done',
      sourceListName: 'Inbox',
    }));
  });
});

describe('Quick Add orchestration', () => {
  it('creates parents before their subtasks and returns notification metadata', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/tasks') {
        return jsonResponse({ id: 'parent-1', editPolicy: editableTaskPolicy });
      }
      if (url === '/api/tasks/parent-1/subtasks') {
        return jsonResponse({
          subtask: { id: 'subtask-1' },
          editPolicy: editableTaskPolicy,
        });
      }
      return jsonResponse({}, 404);
    });
    const plan = planQuickAddSubmission({
      input: '',
      pendingTasks: [task('Parent'), task('Child', 0)],
      destination: localDestination,
      projectsLoadState: 'ready',
    });

    const result = await submitQuickAdd({ fetcher }, {
      plan,
      destination: localDestination,
      addToMyDay: false,
      contextProject: null,
      contextProjectActive: false,
    });

    expect(calls).toEqual(['/api/tasks', '/api/tasks/parent-1/subtasks']);
    expect(result.status).toBe('success');
    expect(result.createdTasks.map(({ id }) => id)).toEqual(['parent-1', 'subtask-1']);
    expect(getQuickAddSubmissionMessage(result)).toBe('Added 1 task (1 subtask)');
  });

  it('captures partial failures and requeues failed parent hierarchies', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/tasks') {
        const body = JSON.parse(String(init?.body)) as { title: string };
        return body.title === 'Failed parent'
          ? jsonResponse({ error: 'failed' }, 500)
          : jsonResponse({ id: 'successful-parent', editPolicy: editableTaskPolicy });
      }
      return jsonResponse({}, 404);
    });
    const plan = planQuickAddSubmission({
      input: '',
      pendingTasks: [
        task('Failed parent'),
        task('Failed child', 0),
        task('Successful parent'),
      ],
      destination: localDestination,
      projectsLoadState: 'ready',
    });

    const result = await submitQuickAdd({ fetcher }, {
      plan,
      destination: localDestination,
      addToMyDay: false,
      contextProject: null,
      contextProjectActive: false,
    });

    expect(result.status).toBe('partial');
    expect(result.createdTasks.map(({ id }) => id)).toEqual(['successful-parent']);
    expect(result.failures.map(({ kind, task: failedTask }) => [
      kind,
      failedTask.text,
    ])).toEqual([
      ['task', 'Failed parent'],
      ['subtask', 'Failed child'],
    ]);
    expect(result.retryTasks).toEqual([
      task('Failed parent'),
      task('Failed child', 0),
    ]);
    expect(getQuickAddSubmissionMessage(result)).toBe('Added 1 item · 2 still pending');
  });

  it('retries a failed subtask under its already-created parent', async () => {
    let subtaskAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === '/api/tasks') {
        return jsonResponse({ id: 'parent-1', editPolicy: editableTaskPolicy });
      }
      if (url === '/api/tasks/parent-1/subtasks') {
        subtaskAttempts++;
        return subtaskAttempts === 1
          ? jsonResponse({ error: 'temporary failure' }, 500)
          : jsonResponse({
              subtask: { id: 'subtask-1' },
              editPolicy: editableTaskPolicy,
            });
      }
      return jsonResponse({}, 404);
    });
    const firstPlan = planQuickAddSubmission({
      input: '',
      pendingTasks: [task('Parent'), task('Child', 0)],
      destination: localDestination,
      projectsLoadState: 'ready',
    });

    const firstResult = await submitQuickAdd({ fetcher }, {
      plan: firstPlan,
      destination: localDestination,
      addToMyDay: false,
      contextProject: null,
      contextProjectActive: false,
    });
    expect(firstResult.retryTasks).toEqual([{
      ...task('Child'),
      parentTaskId: 'parent-1',
    }]);

    const retryPlan = planQuickAddSubmission({
      input: '',
      pendingTasks: firstResult.retryTasks,
      destination: localDestination,
      projectsLoadState: 'ready',
    });
    const retryResult = await submitQuickAdd({ fetcher }, {
      plan: retryPlan,
      destination: localDestination,
      addToMyDay: false,
      contextProject: null,
      contextProjectActive: false,
    });

    expect(retryResult.status).toBe('success');
    expect(retryResult.createdTasks.map(({ id }) => id)).toEqual(['subtask-1']);
    expect(getQuickAddSubmissionMessage(retryResult)).toBe('Added 1 subtask');
    expect(fetcher.mock.calls.filter(([input]) =>
      String(input) === '/api/tasks/parent-1/subtasks'
    )).toHaveLength(2);
  });
});

describe('Quick Add follow-up workflows', () => {
  it('applies selected workflow-template tasks through the dedicated API helper', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ created: 2 }));

    await applyQuickAddWorkflowTemplate({ fetcher }, {
      templateId: 'template-1',
      destination: { ...localDestination, listId: 'list-1', listName: 'Inbox' },
      selectedIndices: [0, 2],
    });

    expect(fetcher).toHaveBeenCalledWith('/api/subtask-templates', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        templateId: 'template-1',
        connectorType: 'local',
        sourceListId: 'list-1',
        sourceListName: 'Inbox',
        selectedIndices: [0, 2],
      }),
    }));
  });

  it('surfaces workflow-template API errors', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'Template is unavailable' }, 409)
    );

    await expect(applyQuickAddWorkflowTemplate({ fetcher }, {
      templateId: 'template-1',
      destination: localDestination,
      selectedIndices: [0],
    })).rejects.toThrow('Template is unavailable');
  });

  it('undoes created tasks and reports remote close semantics', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('task-2')
        ? jsonResponse({ action: 'closed', connectorType: 'github-issues' })
        : jsonResponse({ action: 'deleted' })
    );

    await expect(undoQuickAddTasks({ fetcher }, ['task-1', 'task-2'])).resolves.toEqual({
      closedConnectorType: 'github-issues',
    });
  });

  it('rejects undo when any deletion fails', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('task-2')
        ? jsonResponse({}, 500)
        : jsonResponse({ action: 'deleted' })
    );

    await expect(undoQuickAddTasks({ fetcher }, ['task-1', 'task-2']))
      .rejects.toThrow('Undo failed');
  });

  it('filters low-confidence follow-up suggestions and merges duplicate tags', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      suggestions: {
        'task-1': {
          priority: { value: 'high', confidence: 0.8, reason: 'urgent' },
          effort: { value: 3, confidence: 0.2, reason: 'uncertain' },
          tags: [
            { id: 'tag-1', name: 'Release', confidence: 0.9 },
            { id: 'tag-2', name: 'Maybe', confidence: 0.1 },
          ],
        },
      },
    }));

    const fetched = await fetchQuickAddSuggestion({ fetcher }, 'task-1');
    expect(fetched).toEqual({
      priority: { value: 'high', confidence: 0.8, reason: 'urgent' },
      effort: null,
      tags: [{ id: 'tag-1', name: 'Release', confidence: 0.9 }],
    });
    expect(mergeQuickAddSuggestions({
      priority: null,
      effort: null,
      tags: [{ id: 'other-id', name: 'release', confidence: 0.7 }],
    }, fetched)).toEqual(fetched);
  });
});
