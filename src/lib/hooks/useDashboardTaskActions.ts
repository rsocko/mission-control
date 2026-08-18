'use client';

import {
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import { pushUndoWithToast, useUndoStore } from '@/lib/stores/undoStore';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { NAVIGATION_COUNTS_REFRESH_EVENT } from '@/lib/navigation/badges';
import {
  removeTaskFromResponse,
  replaceTaskInKeywordFilteredResponse,
  restoreTaskToResponse,
} from '@/lib/utils/dashboard-helpers';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
  taskRemovalConfirmation,
} from '@/lib/tasks/client-edit-policy';
import type { LocalDisposition, TaskField } from '@/types';
import type {
  DashboardProjectViewModel as HubProject,
  DashboardTaskResponseViewModel as TaskResponse,
  DashboardTaskViewModel as Task,
  SourceList,
} from '@/types/dashboard';
import type { TaskCompletionOutcome } from '@/lib/hooks/useTaskCompletion';

export interface DashboardTaskExit {
  id: string;
  title: string;
  yOffset: number;
  reason: 'complete' | 'remove';
}

export interface DashboardTaskConfirmDialog {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  onConfirm: () => void;
}

export interface DashboardTaskCompletionOptions {
  optimisticUpdate: () => void;
  request: () => Promise<void>;
  rollback: () => void;
}

export type DashboardTaskCompletionRunner = (
  taskId: string,
  options: DashboardTaskCompletionOptions,
) => Promise<TaskCompletionOutcome>;

export type DashboardFetchData = (
  append?: boolean,
  silent?: boolean,
  preserveCount?: boolean,
) => Promise<void>;

export interface UseDashboardTaskActionsOptions {
  taskResponse: TaskResponse;
  setTaskResponse: Dispatch<SetStateAction<TaskResponse>>;
  sourceLists: SourceList[];
  projects: HubProject[];
  quickFilter: string | null;
  textFilter: string;
  myDayItemStatuses: Map<string, string>;
  setMyDayItemStatuses: Dispatch<SetStateAction<Map<string, string>>>;
  setMyDayTaskIds: Dispatch<SetStateAction<Set<string>>>;
  setExitingTasks: Dispatch<SetStateAction<DashboardTaskExit[]>>;
  setConfirmDialog: Dispatch<SetStateAction<DashboardTaskConfirmDialog>>;
  listRef: RefObject<HTMLDivElement | null>;
  completionScopeKey: string;
  runTaskCompletion: DashboardTaskCompletionRunner;
  fetchData: DashboardFetchData;
}

export interface DashboardTaskActions {
  completeTask: (taskId: string) => Promise<void>;
  snoozeTask: (taskId: string, snoozedUntil: string | null) => Promise<void>;
  deleteTask: (taskId: string) => void;
  setTaskDueDate: (taskId: string, date: string | null) => Promise<void>;
  setTaskPriority: (taskId: string, newPriority: string) => Promise<void>;
  setTaskStatus: (taskId: string, newStatus: string) => Promise<void>;
  setTaskLocalDisposition: (taskId: string, disposition: LocalDisposition) => Promise<void>;
  moveTaskToList: (taskId: string, targetListId: string) => Promise<void>;
  addTaskToProject: (taskId: string, projectId: string, phaseId?: string | null) => Promise<void>;
  addToMyDay: (taskId: string) => Promise<void>;
  removeFromMyDay: (taskId: string) => Promise<void>;
  patchTaskInList: (taskId: string, fields: Record<string, unknown>) => void;
  updateSubtaskCount: (taskId: string, done: number, total: number) => void;
  animateTaskExit: (taskId: string, title: string, reason?: 'complete' | 'remove') => void;
}

/**
 * Task mutations used by the dashboard. Options are read through a ref so
 * consumers can pass current state while retaining one stable action contract.
 */
export function useDashboardTaskActions(
  options: UseDashboardTaskActionsOptions,
): DashboardTaskActions {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const animateTaskExit = useCallback((
    taskId: string,
    title: string,
    reason: 'complete' | 'remove' = 'remove',
  ) => {
    const { listRef, setExitingTasks } = optionsRef.current;
    const el = listRef.current?.querySelector(`[data-task-id="${taskId}"]`);
    const containerRect = listRef.current?.getBoundingClientRect();
    if (el && containerRect) {
      const elRect = el.getBoundingClientRect();
      const yOffset = elRect.top - containerRect.top + listRef.current!.scrollTop;
      setExitingTasks((prev) => [...prev, { id: taskId, title, yOffset, reason }]);
      setTimeout(() => {
        setExitingTasks((prev) => prev.filter((task) => task.id !== taskId));
      }, 500);
    }
  }, []);

  const ensureTaskFieldEditable = useCallback((taskId: string, field: TaskField): Task | null => {
    const task = optionsRef.current.taskResponse.tasks.find((candidate) => candidate.id === taskId) ?? null;
    if (task && canEditTaskField(task.editPolicy, field)) return task;
    toast.error(taskFieldBlockedReason(task?.editPolicy, field));
    return null;
  }, []);

  const completeTask = useCallback(async (taskId: string) => {
    const dependencies = optionsRef.current;
    const task = ensureTaskFieldEditable(taskId, 'status');
    if (!task) return;

    const scopeKey = dependencies.completionScopeKey;
    const taskIndex = dependencies.taskResponse.tasks.findIndex((candidate) => candidate.id === taskId);
    const previousMyDayStatus = dependencies.myDayItemStatuses.get(taskId);
    let removedFromVisibleResponse = false;
    let optimisticMyDayStatuses: Map<string, string> | null = null;
    const outcome = await dependencies.runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        if (optionsRef.current.completionScopeKey !== scopeKey) return;
        animateTaskExit(taskId, task.title, 'complete');
        dependencies.setTaskResponse((current) => {
          removedFromVisibleResponse = current.tasks.some((candidate) => candidate.id === taskId);
          return removeTaskFromResponse(current, taskId, task);
        });
        dependencies.setMyDayItemStatuses((current) => {
          if (!current.has(taskId)) return current;
          const next = new Map(current);
          next.set(taskId, 'done');
          optimisticMyDayStatuses = next;
          return next;
        });
      },
      request: async () => {
        const response = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
        if (!response.ok) throw new Error('Failed');
      },
      rollback: () => {
        if (!removedFromVisibleResponse || optionsRef.current.completionScopeKey !== scopeKey) return;
        dependencies.setTaskResponse((current) => (
          current.tasks.some((candidate) => candidate.id === taskId)
            ? current
            : restoreTaskToResponse(current, task, taskIndex)
        ));
        dependencies.setMyDayItemStatuses((current) => {
          if (previousMyDayStatus === undefined || current !== optimisticMyDayStatuses) return current;
          const next = new Map(current);
          next.set(taskId, previousMyDayStatus);
          return next;
        });
        void optionsRef.current.fetchData(false, true, true);
      },
    });

    if (outcome === 'completed') {
      pushUndoWithToast(`"${task.title}" completed`, async () => {
        await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'todo' }),
        });
        void optionsRef.current.fetchData(false, true, true);
        window.dispatchEvent(new CustomEvent('mc:task-completed'));
      });
      window.dispatchEvent(new CustomEvent('mc:task-completed'));
      setTimeout(() => void optionsRef.current.fetchData(false, true, true), 3000);
    } else if (outcome === 'failed') {
      toast.error('Failed to complete task');
    }
  }, [animateTaskExit, ensureTaskFieldEditable]);

  const updateSubtaskCount = useCallback((taskId: string, done: number, total: number) => {
    optionsRef.current.setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (
        task.id === taskId ? { ...task, subtaskDone: done, subtaskTotal: total } : task
      )),
    }));
  }, []);

  const snoozeTask = useCallback(async (taskId: string, snoozedUntil: string | null) => {
    const dependencies = optionsRef.current;
    const task = ensureTaskFieldEditable(taskId, 'snoozedUntil');
    if (!task) return;
    const previous = dependencies.taskResponse;
    dependencies.setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((candidate) => (
        candidate.id === taskId ? { ...candidate, snoozedUntil } : candidate
      )),
    }));

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snoozedUntil }),
      });
      if (!response.ok) throw new Error('Failed');
      pushUndoWithToast(snoozedUntil ? 'Task snoozed' : 'Snooze cleared', () => {
        dependencies.setTaskResponse(previous);
        fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snoozedUntil: task.snoozedUntil || null }),
        }).then(() => void optionsRef.current.fetchData(false, true, true))
          .catch(() => toast.error('Failed to undo snooze'));
      }, { type: 'info' });
      setTimeout(() => void optionsRef.current.fetchData(false, true, true), 3000);
    } catch {
      dependencies.setTaskResponse(previous);
      toast.error('Failed to snooze task');
    }
  }, [ensureTaskFieldEditable]);

  const addToMyDay = useCallback(async (taskId: string) => {
    const dependencies = optionsRef.current;
    try {
      const response = await fetch('/api/my-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, date: getClientToday() }),
      });
      const data = await response.json();
      dependencies.setMyDayTaskIds((previous) => new Set(previous).add(taskId));
      const task = dependencies.taskResponse.tasks.find((candidate) => candidate.id === taskId);
      dependencies.setMyDayItemStatuses((previous) => {
        const next = new Map(previous);
        next.set(taskId, task?.status || 'todo');
        return next;
      });
      window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
      if (data.writeBack?.attempted && !data.writeBack?.success) {
        toast.warning('Added to My Day locally, but failed to sync to Microsoft To Do');
      } else {
        toast.success('Added to My Day');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add task to My Day');
    }
  }, []);

  const removeFromMyDay = useCallback(async (taskId: string) => {
    const dependencies = optionsRef.current;
    try {
      const params = new URLSearchParams({ taskId, date: getClientToday() });
      const response = await fetch(`/api/my-day?${params.toString()}`, { method: 'DELETE' });
      const data = await response.json();
      dependencies.setMyDayTaskIds((previous) => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
      dependencies.setMyDayItemStatuses((previous) => {
        const next = new Map(previous);
        next.delete(taskId);
        return next;
      });
      window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
      if (data.writeBack?.attempted && !data.writeBack?.success) {
        toast.warning('Removed from My Day locally, but failed to sync to Microsoft To Do');
      } else {
        toast.success('Removed from My Day');
      }
      void optionsRef.current.fetchData(false, true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove task from My Day');
    }
  }, []);

  const setTaskDueDate = useCallback(async (taskId: string, date: string | null) => {
    const dependencies = optionsRef.current;
    const task = ensureTaskFieldEditable(taskId, 'dueDate');
    if (!task) return;
    const previous = dependencies.taskResponse;
    const willLeaveView = dependencies.quickFilter === 'overdue'
      && (date === null || date >= getClientToday());

    if (willLeaveView) {
      animateTaskExit(taskId, task.title);
      dependencies.setTaskResponse((current) => removeTaskFromResponse(current, taskId, task));
    } else {
      dependencies.setTaskResponse((current) => ({
        ...current,
        tasks: current.tasks.map((candidate) => (
          candidate.id === taskId ? { ...candidate, dueDate: date } : candidate
        )),
      }));
    }

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: date }),
      });
      if (!response.ok) throw new Error('Failed');
      toast.success('Due date updated');
      void optionsRef.current.fetchData(false, true);
    } catch {
      dependencies.setTaskResponse(previous);
      toast.error('Failed to update due date');
    }
  }, [animateTaskExit, ensureTaskFieldEditable]);

  const setTaskPriority = useCallback(async (taskId: string, newPriority: string) => {
    const dependencies = optionsRef.current;
    if (!ensureTaskFieldEditable(taskId, 'priority')) return;
    const previous = dependencies.taskResponse;
    dependencies.setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, priority: newPriority } : task),
    }));
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: newPriority }),
      });
      if (!response.ok) throw new Error('Failed');
      void optionsRef.current.fetchData(false, true);
    } catch {
      dependencies.setTaskResponse(previous);
      toast.error('Failed to update priority');
    }
  }, [ensureTaskFieldEditable]);

  const setTaskStatus = useCallback(async (taskId: string, newStatus: string) => {
    const dependencies = optionsRef.current;
    if (!ensureTaskFieldEditable(taskId, 'status')) return;
    const previous = dependencies.taskResponse;
    dependencies.setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, status: newStatus } : task),
    }));
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!response.ok) throw new Error('Failed');
      void optionsRef.current.fetchData(false, true);
    } catch {
      dependencies.setTaskResponse(previous);
      toast.error('Failed to update status');
    }
  }, [ensureTaskFieldEditable]);

  const setTaskLocalDisposition = useCallback(async (
    taskId: string,
    disposition: LocalDisposition,
  ) => {
    const dependencies = optionsRef.current;
    const previous = dependencies.taskResponse;
    const task = dependencies.taskResponse.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (!canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, disposition)) {
      toast.error(taskDispositionBlockedReason(task.editPolicy, task.localDisposition, disposition));
      return;
    }
    dependencies.setTaskResponse((current) => disposition === 'active'
      ? {
          ...current,
          tasks: current.tasks.map((candidate) => (
            candidate.id === taskId ? { ...candidate, localDisposition: disposition } : candidate
          )),
        }
      : removeTaskFromResponse(current, taskId, task));

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localDisposition: disposition }),
      });
      const data = await response.json() as {
        fields?: { localDisposition?: { persisted?: boolean } };
      };
      if (!response.ok || data.fields?.localDisposition?.persisted !== true) {
        throw new Error('Mission Control state was not saved');
      }
      toast.success(disposition === 'handled'
        ? 'Marked handled in Mission Control; upstream task unchanged'
        : disposition === 'dismissed'
          ? 'Dismissed in Mission Control; upstream task unchanged'
          : 'Restored in Mission Control');
      void optionsRef.current.fetchData(false, true);
    } catch (error) {
      dependencies.setTaskResponse(previous);
      toast.error(error instanceof Error
        ? error.message
        : 'Failed to update the Mission Control disposition');
    }
  }, []);

  const patchTaskInList = useCallback((taskId: string, fields: Record<string, unknown>) => {
    optionsRef.current.setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, ...fields } : task),
    }));
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    const dependencies = optionsRef.current;
    const task = dependencies.taskResponse.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (!canRemoveTask(task.editPolicy)) {
      toast.error(task.editPolicy.removalReason ?? 'This task cannot be removed');
      return;
    }
    const confirmation = taskRemovalConfirmation(task.editPolicy, task.title);
    dependencies.setConfirmDialog({
      open: true,
      ...confirmation,
      variant: 'danger',
      onConfirm: () => {
        dependencies.setConfirmDialog((dialog) => ({ ...dialog, open: false }));
        requestAnimationFrame(() => {
          animateTaskExit(taskId, task.title);
          const previous = dependencies.taskResponse;
          dependencies.setTaskResponse((current) => ({
            ...current,
            tasks: current.tasks.filter((candidate) => candidate.id !== taskId),
            total: current.total - 1,
          }));
          let undone = false;
          const undoId = useUndoStore.getState().pushUndo({
            label: 'Task deleted',
            undo: () => {
              undone = true;
              dependencies.setTaskResponse(previous);
            },
          });
          toast.success('Task deleted', {
            action: {
              label: 'Undo',
              onClick: () => {
                undone = true;
                useUndoStore.getState().removeEntry(undoId);
                dependencies.setTaskResponse(previous);
              },
            },
            duration: 5000,
          });
          setTimeout(async () => {
            if (!undone) {
              try {
                const response = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
                if (!response.ok) {
                  const data = await response.json().catch(() => ({}));
                  dependencies.setTaskResponse(previous);
                  toast.error(data.error || 'Failed to delete task');
                }
              } catch {
                dependencies.setTaskResponse(previous);
                toast.error('Failed to delete task');
              }
            }
          }, 5500);
        });
      },
    });
  }, [animateTaskExit]);

  const moveTaskToList = useCallback(async (taskId: string, targetListId: string) => {
    const dependencies = optionsRef.current;
    const task = dependencies.taskResponse.tasks.find((candidate) => candidate.id === taskId);
    const targetList = dependencies.sourceLists.find((list) => list.id === targetListId);
    try {
      const response = await fetch(`/api/tasks/${taskId}/move-to-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetListId }),
      });
      if (!response.ok) throw new Error('Failed');
      const data = await response.json();
      if (data.previousListId) {
        pushUndoWithToast(`Moved to ${targetList?.name || 'list'}`, async () => {
          await fetch(`/api/tasks/${taskId}/move-to-list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetListId: data.previousListId }),
          });
          void optionsRef.current.fetchData(false, true);
        });
      } else {
        toast.success(`Moved to ${targetList?.name || 'list'}`);
      }
      if (task) {
        animateTaskExit(taskId, task.title, 'remove');
        dependencies.setTaskResponse((current) => removeTaskFromResponse(current, taskId, task));
      } else {
        void optionsRef.current.fetchData(false, true);
      }
    } catch {
      toast.error('Failed to move task');
    }
  }, [animateTaskExit]);

  const addTaskToProject = useCallback(async (
    taskId: string,
    projectId: string,
    phaseId?: string | null,
  ) => {
    const dependencies = optionsRef.current;
    const project = dependencies.projects.find((candidate) => candidate.id === projectId);
    try {
      const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, phaseId: phaseId ?? null }),
      });
      if (!response.ok) throw new Error('Failed to add to project');

      const phaseName = phaseId
        ? project?.phases?.find((phase) => phase.id === phaseId)?.name ?? null
        : null;
      const label = phaseName
        ? `Moved to ${project?.name || 'project'} → ${phaseName}`
        : `Moved to ${project?.name || 'project'} → No phase`;
      toast.success(label);

      dependencies.setTaskResponse((current) => {
        const task = current.tasks.find((candidate) => candidate.id === taskId);
        if (!task) return current;
        const updatedTask: Task = {
          ...task,
          hubProjectIds: [...(task.hubProjectIds || []).filter((id) => id !== projectId), projectId],
          projectPhaseMemberships: [
            ...(task.projectPhaseMemberships || []).filter((membership) => membership.projectId !== projectId),
            {
              projectId,
              projectName: project?.name || 'Unknown Project',
              phaseId: phaseId ?? null,
              phaseName,
            },
          ],
        };
        return replaceTaskInKeywordFilteredResponse(current, updatedTask, dependencies.textFilter);
      });
    } catch {
      toast.error('Failed to add task to project');
    }
  }, []);

  return useMemo(() => ({
    completeTask,
    snoozeTask,
    deleteTask,
    setTaskDueDate,
    setTaskPriority,
    setTaskStatus,
    setTaskLocalDisposition,
    moveTaskToList,
    addTaskToProject,
    addToMyDay,
    removeFromMyDay,
    patchTaskInList,
    updateSubtaskCount,
    animateTaskExit,
  }), [
    addTaskToProject,
    addToMyDay,
    animateTaskExit,
    completeTask,
    deleteTask,
    moveTaskToList,
    patchTaskInList,
    removeFromMyDay,
    setTaskDueDate,
    setTaskLocalDisposition,
    setTaskPriority,
    setTaskStatus,
    snoozeTask,
    updateSubtaskCount,
  ]);
}
