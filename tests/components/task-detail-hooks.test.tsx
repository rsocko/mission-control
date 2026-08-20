import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { useTaskDetailData } from '@/components/task-detail/useTaskDetailData';
import {
  useTaskDetailMutations,
  type TaskConfirmRequest,
} from '@/components/task-detail/useTaskDetailMutations';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import type { DuplicateCandidate } from '@/components/task-detail/DuplicateTaskPreview';
import type { TaskDetail, TaskTag } from '@/components/task-detail/task-detail-types';
import { NAVIGATION_COUNTS_REFRESH_EVENT } from '@/lib/navigation/badges';
import { notifyTaskChanged } from '@/lib/task-change-events';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/utils/client-date', () => ({
  getLocalToday: () => '2026-08-01',
}));

const loadProjectHierarchy = vi.fn();
const executeProjectHierarchyCommand = vi.fn();

vi.mock('@/lib/projects/hierarchy-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/projects/hierarchy-client')>(
    '@/lib/projects/hierarchy-client',
  );
  return {
    ...actual,
    loadProjectHierarchy: (...args: unknown[]) => loadProjectHierarchy(...args),
    executeProjectHierarchyCommand: (...args: unknown[]) => executeProjectHierarchyCommand(...args),
  };
});

const baseTask: TaskDetail = {
  id: 'task-1',
  title: 'Write the migration guide',
  description: 'Detailed notes',
  status: 'todo',
  microStatus: null,
  statusReason: null,
  priority: 'high',
  dueDate: '2026-08-01',
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListId: 'list-1',
  sourceListName: 'Inbox',
  sourceId: 'local:task-1',
  sourceUrl: null,
  assignee: null,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-31T12:00:00.000Z',
  tagIds: ['tag-1'],
  projectIds: [],
  subtasks: [],
  metadata: null,
  estimatedDuration: 30,
  recurrence: null,
  effort: 2,
  reminderAt: null,
  isInMyDay: false,
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

const hierarchy: ProjectHierarchySnapshot = {
  projectId: 'project-1',
  revision: 3,
  phases: [
    { id: 'phase-1', projectId: 'project-1', name: 'Discovery' },
    { id: 'phase-2', projectId: 'project-1', name: 'Delivery' },
  ],
  phaseItemsByPhase: {
    'phase-1': [{ id: 'item-1', phaseId: 'phase-1', taskId: 'task-1' }],
    'phase-2': [],
  },
} as unknown as ProjectHierarchySnapshot;

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as unknown as Response;
}

function stubFetch(handler: (input: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => (
    Promise.resolve(handler(String(input), init))
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

interface HarnessOptions {
  task?: TaskDetail;
  onUpdate?: (fields?: Record<string, unknown>) => void;
  onClose?: () => void;
  onComplete?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onToggleMyDay?: () => void | Promise<void>;
  availableTags?: TaskTag[];
  isInMyDay?: boolean;
  hierarchies?: Record<string, ProjectHierarchySnapshot | null>;
  requestConfirm?: (request: TaskConfirmRequest) => void;
}

function renderMutations(options: HarnessOptions = {}) {
  const confirmRequests: TaskConfirmRequest[] = [];
  const harness = renderHook(() => {
    const [task, setTask] = useState<TaskDetail | null>(options.task ?? baseTask);
    const [extraTags, setExtraTags] = useState<TaskTag[]>([]);
    const [projectHierarchies, setProjectHierarchies] = useState<
      Record<string, ProjectHierarchySnapshot | null>
    >(options.hierarchies ?? {});
    const [duplicates, setPotentialDuplicates] = useState<DuplicateCandidate[]>([]);
    const mutations = useTaskDetailMutations({
      taskId: 'task-1',
      task,
      setTask,
      onUpdate: options.onUpdate,
      availableTags: options.availableTags ?? [],
      extraTags,
      setExtraTags,
      connectorCaps: null,
      projectHierarchies,
      setProjectHierarchies,
      setPotentialDuplicates,
      isInMyDay: options.isInMyDay ?? false,
      onClose: options.onClose ?? (() => {}),
      onComplete: options.onComplete,
      onDelete: options.onDelete,
      onToggleMyDay: options.onToggleMyDay,
      requestConfirm: options.requestConfirm ?? ((request) => { confirmRequests.push(request); }),
    });
    return { task, extraTags, projectHierarchies, duplicates, mutations };
  });
  return { ...harness, confirmRequests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useTaskDetailData', () => {
  it('loads the task, capabilities, projects, and connectors without rendering the panel', async () => {
    loadProjectHierarchy.mockResolvedValue(hierarchy);
    stubFetch((input) => {
      if (input === '/api/tasks/task-1') return jsonResponse({ task: { ...baseTask, projectIds: ['project-1'] } });
      if (input === '/api/features') {
        return jsonResponse({
          taskDestinations: [{ id: 'local', capabilities: { attachments: true, subtasks: true, tagWriteBack: true } }],
        });
      }
      if (input.startsWith('/api/hub-projects')) return jsonResponse({ projects: [{ id: 'project-1', name: 'Docs' }] });
      if (input === '/api/connectors') {
        return jsonResponse({ connectors: [{ id: 'local', type: 'local', name: 'Local', capabilities: { taskCreate: true } }] });
      }
      if (input.startsWith('/api/tasks/detect-duplicates')) return jsonResponse({ duplicates: [{ id: 'dupe-1' }] });
      return jsonResponse({});
    });

    const onTaskLoaded = vi.fn();
    const { result } = renderHook(() => useTaskDetailData({ taskId: 'task-1', onTaskLoaded }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.task?.id).toBe('task-1');
    expect(onTaskLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
    await waitFor(() => expect(result.current.supportsAttachments).toBe(true));
    expect(result.current.connectorCaps).toEqual({
      tagWriteBack: true,
      tagCreationMode: 'freeform',
      tagScope: 'global',
    });
    await waitFor(() => expect(result.current.hubProjects).toHaveLength(1));
    await waitFor(() => expect(result.current.writableConnectors).toHaveLength(1));
    await waitFor(() => expect(result.current.potentialDuplicates).toHaveLength(1));
    await waitFor(() => expect(result.current.projectHierarchies['project-1']).toBe(hierarchy));
  });

  it('refreshes the open task when another task surface reports a change', async () => {
    let status = 'todo';
    let taskFetches = 0;
    stubFetch((input) => {
      if (input === '/api/tasks/task-1') {
        taskFetches += 1;
        return jsonResponse({ task: { ...baseTask, status } });
      }
      return jsonResponse({});
    });

    const { result } = renderHook(() => useTaskDetailData({ taskId: 'task-1' }));
    await waitFor(() => expect(result.current.task?.status).toBe('todo'));

    status = 'in_progress';
    act(() => notifyTaskChanged('another-task'));
    expect(taskFetches).toBe(1);

    act(() => notifyTaskChanged('task-1'));
    await waitFor(() => expect(result.current.task?.status).toBe('in_progress'));
    expect(taskFetches).toBe(2);
  });

  it('resets editors and keeps loading resilient when the task fetch fails', async () => {
    stubFetch((input) => {
      if (input === '/api/tasks/task-1') return Promise.reject(new Error('offline'));
      return jsonResponse({});
    });
    const onTaskReset = vi.fn();

    const { result } = renderHook(() => useTaskDetailData({ taskId: 'task-1', onTaskReset }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onTaskReset).toHaveBeenCalledOnce();
    expect(result.current.task).toBeNull();
  });

  it('records an unavailable hierarchy when project phases fail to load', async () => {
    loadProjectHierarchy.mockRejectedValue(new Error('nope'));
    stubFetch((input) => {
      if (input === '/api/tasks/task-1') return jsonResponse({ task: { ...baseTask, projectIds: ['project-1'] } });
      return jsonResponse({});
    });

    const { result } = renderHook(() => useTaskDetailData({ taskId: 'task-1' }));

    await waitFor(() => expect(result.current.projectHierarchies).toHaveProperty('project-1', null));
  });
});

describe('useTaskDetailMutations', () => {
  it('saves the canonical relative reminder returned by the server', async () => {
    const reminder = {
      reminderAt: '2026-08-02T13:00:00.000Z',
      reminderRelative: '1_day_before' as const,
      reminderDueTime: '09:00',
    };
    const fetchMock = stubFetch(() => jsonResponse({ reminder }));
    const { result } = renderMutations({
      task: { ...baseTask, dueDate: '2026-08-03' },
    });

    await act(async () => {
      expect(await result.current.mutations.handleReminderChange({
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      })).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      body: JSON.stringify({
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      }),
    }));
    expect(result.current.task).toMatchObject(reminder);
  });

  it('asks how to resolve a relative reminder before removing its due date', async () => {
    const task = {
      ...baseTask,
      reminderAt: '2026-08-02T13:00:00.000Z',
      reminderRelative: '1_day_before' as const,
      reminderDueTime: '09:00',
    };
    const { result, confirmRequests } = renderMutations({ task });

    await act(async () => {
      expect(await result.current.mutations.handleDueDateChange('')).toBe(false);
    });

    expect(confirmRequests[0]).toMatchObject({
      confirmLabel: 'Keep reminder time',
      alternateLabel: 'Remove reminder',
    });
  });

  it('saves a field and reports the change to the host', async () => {
    const onUpdate = vi.fn();
    const onNavigationCountsRefresh = vi.fn();
    window.addEventListener(NAVIGATION_COUNTS_REFRESH_EVENT, onNavigationCountsRefresh, { once: true });
    const fetchMock = stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({ onUpdate });

    await act(async () => {
      await result.current.mutations.handlePriorityChange('low');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ priority: 'low' }),
    }));
    expect(result.current.task?.priority).toBe('low');
    expect(onUpdate).toHaveBeenCalledWith({ priority: 'low' });
    expect(onNavigationCountsRefresh).toHaveBeenCalledOnce();
  });

  it('refuses blocked fields with the policy reason', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({
      task: { ...baseTask, editPolicy: makeTaskEditPolicy({ mutations: { priority: 'blocked' } }) },
    });

    await act(async () => {
      await result.current.mutations.handlePriorityChange('low');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('priority'));
    expect(result.current.task?.priority).toBe('high');
  });

  it('rolls back an optimistic tag removal when the request fails', async () => {
    const onUpdate = vi.fn();
    stubFetch(() => jsonResponse({}, false));
    const { result } = renderMutations({ onUpdate });

    await act(async () => {
      await result.current.mutations.handleRemoveTag('tag-1');
    });

    expect(result.current.task?.tagIds).toEqual(['tag-1']);
    expect(toast.error).toHaveBeenCalledWith('Failed to remove tag');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('keeps an optimistic tag removal when the request succeeds', async () => {
    const onUpdate = vi.fn();
    stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({ onUpdate });

    await act(async () => {
      await result.current.mutations.handleRemoveTag('tag-1');
    });

    expect(result.current.task?.tagIds).toEqual([]);
    expect(onUpdate).toHaveBeenCalled();
  });

  it('adds a known tag and records it for display', async () => {
    stubFetch((input) => {
      if (input === '/api/tasks/task-1/tags') return jsonResponse({ addedTagIds: ['tag-2'] });
      return jsonResponse({});
    });
    const { result } = renderMutations({
      availableTags: [{ id: 'tag-2', name: 'urgent', slug: 'urgent', color: null }],
    });

    await act(async () => {
      await result.current.mutations.handleAddTag('urgent');
    });

    expect(result.current.task?.tagIds).toEqual(['tag-1', 'tag-2']);
    expect(result.current.extraTags).toEqual([{ id: 'tag-2', name: 'urgent', slug: 'urgent', color: null }]);
  });

  it('explains rejected labels from predefined sources', async () => {
    stubFetch(() => jsonResponse({ addedTagIds: [], rejectedTags: ['unknown'] }));
    const { result } = renderMutations();

    await act(async () => {
      await result.current.mutations.handleAddTag('unknown');
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Label "unknown" doesn\'t exist in this source. Please create it there first.',
    );
    expect(result.current.task?.tagIds).toEqual(['tag-1']);
  });

  it('defers GitHub cancellation to the close reason picker', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({
      task: { ...baseTask, connectorType: 'github-issues' },
    });

    await act(async () => {
      await result.current.mutations.handleStatusChange('cancelled');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.mutations.showCloseReasonPicker).toBe(true);

    await act(async () => {
      await result.current.mutations.handleCloseWithReason('duplicate');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      body: JSON.stringify({ status: 'cancelled', statusReason: 'duplicate' }),
    }));
    expect(result.current.task).toMatchObject({ status: 'cancelled', statusReason: 'duplicate' });
    expect(result.current.mutations.showCloseReasonPicker).toBe(false);
  });

  it('delegates completion to the host when it owns the workflow', async () => {
    const onComplete = vi.fn();
    const fetchMock = stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({ onComplete });

    act(() => { result.current.mutations.handleComplete(); });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds the task to My Day and warns when write-back fails', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ writeBack: { attempted: true, success: false } }));
    const { result } = renderMutations();

    await act(async () => {
      await result.current.mutations.handleToggleMyDay();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/my-day', expect.objectContaining({ method: 'POST' }));
    expect(result.current.task?.isInMyDay).toBe(true);
    expect(toast.warning).toHaveBeenCalledWith(
      'Added to My Day locally, but failed to sync to Microsoft To Do',
    );
  });

  it('surfaces My Day failures without changing local state', async () => {
    stubFetch(() => jsonResponse({ error: 'My Day is unavailable' }, false));
    const { result } = renderMutations();

    await act(async () => {
      await result.current.mutations.handleToggleMyDay();
    });

    expect(result.current.task?.isInMyDay).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('My Day is unavailable');
  });

  it('confirms before deleting and closes the panel afterwards', async () => {
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    const fetchMock = stubFetch(() => jsonResponse({}));
    const { result, confirmRequests } = renderMutations({ onClose, onUpdate });

    act(() => { result.current.mutations.handleDelete(); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirmRequests).toHaveLength(1);

    await act(async () => {
      confirmRequests[0].onConfirm();
      await Promise.resolve();
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1', { method: 'DELETE' });
    expect(toast.success).toHaveBeenCalledWith('Task deleted');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('rolls back a Mission Control disposition that was not persisted', async () => {
    stubFetch(() => jsonResponse({ fields: { localDisposition: { persisted: false } } }));
    const { result } = renderMutations({
      task: {
        ...baseTask,
        taskSourceModel: 'remote-mirror',
        editPolicy: makeTaskEditPolicy({ sourceModel: 'remote-mirror' }),
      },
    });

    await act(async () => {
      await result.current.mutations.handleLocalDispositionChange('handled');
    });

    expect(result.current.task?.localDisposition).toBe('active');
    expect(toast.error).toHaveBeenCalledWith('Mission Control state was not saved');
    expect(result.current.mutations.updatingDisposition).toBe(false);
  });

  it('suggests a duration when effort changes and clears the highlight', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => jsonResponse({}));
      const { result } = renderMutations();

      await act(async () => {
        await result.current.mutations.handleEffortChange(3);
      });

      expect(result.current.mutations.durationHighlight).toBe(true);
      expect(result.current.task?.estimatedDuration).toBeGreaterThan(0);

      act(() => { vi.advanceTimersByTime(700); });
      expect(result.current.mutations.durationHighlight).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips overdue recurrences once, ignoring re-entrant clicks', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));
    const { result } = renderMutations();

    await act(async () => {
      await Promise.all([
        result.current.mutations.handleSkipToCurrent('2026-08-08'),
        result.current.mutations.handleSkipToCurrent('2026-08-08'),
      ]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.task?.dueDate).toBe('2026-08-08');
    expect(result.current.mutations.skippingToCurrent).toBe(false);
  });

  it('moves the task between project phases and stores the returned hierarchy', async () => {
    const nextHierarchy = { ...hierarchy, revision: 4 } as ProjectHierarchySnapshot;
    executeProjectHierarchyCommand.mockResolvedValue({ hierarchy: nextHierarchy });
    stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({
      task: { ...baseTask, projectIds: ['project-1'] },
      hierarchies: { 'project-1': hierarchy },
    });

    await act(async () => {
      await result.current.mutations.handleProjectPhaseChange('project-1', 'phase-2');
    });

    expect(executeProjectHierarchyCommand).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      expectedRevision: 3,
    }));
    expect(result.current.projectHierarchies['project-1']).toBe(nextHierarchy);
    expect(result.current.mutations.updatingProjectPhaseIds.size).toBe(0);
  });

  it('reports missing hierarchies instead of guessing a phase move', async () => {
    stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({ task: { ...baseTask, projectIds: ['project-1'] } });

    await act(async () => {
      await result.current.mutations.handleProjectPhaseChange('project-1', 'phase-2');
    });

    expect(executeProjectHierarchyCommand).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Project phases are unavailable');
  });

  it('closes the task as a duplicate and clears the banner', async () => {
    const onUpdate = vi.fn();
    stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({ onUpdate });

    await act(async () => {
      await result.current.mutations.handleCloseAsDuplicate();
    });

    expect(result.current.task).toMatchObject({ status: 'cancelled', statusReason: 'duplicate' });
    expect(result.current.duplicates).toEqual([]);
    expect(onUpdate).toHaveBeenCalledWith({ status: 'cancelled', statusReason: 'duplicate' });
  });

  it('clears pickers that must not survive a task switch', () => {
    stubFetch(() => jsonResponse({}));
    const { result } = renderMutations({ task: { ...baseTask, connectorType: 'github-issues' } });

    act(() => { result.current.mutations.toggleMicroStatusPicker(); });
    expect(result.current.mutations.showMicroStatusPicker).toBe(true);

    act(() => { void result.current.mutations.handleStatusChange('cancelled'); });
    act(() => { result.current.mutations.resetTransientState(); });

    expect(result.current.mutations.showCloseReasonPicker).toBe(false);
    expect(result.current.mutations.showTagPicker).toBe(false);
  });
});
