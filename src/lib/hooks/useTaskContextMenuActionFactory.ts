'use client';

import { useCallback, useRef } from 'react';
import type { TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type { LocalDisposition } from '@/types';
import { getLocalToday, getLocalTomorrow } from '@/lib/utils/client-date';
import { extractRecurrenceFromMetadata, getNextRecurringDate } from '@/lib/utils/recurrence';

interface TaskActionDescriptor {
  id: string;
  title: string;
  dueDate?: string | null;
  metadata?: string | null;
  isInMyDay?: boolean;
}

interface TaskActionHandlers {
  complete: (taskId: string) => void | Promise<unknown>;
  addToMyDay?: (taskId: string) => void | Promise<unknown>;
  setPriority: (taskId: string, priority: string) => void | Promise<unknown>;
  setStatus: (taskId: string, status: string) => void | Promise<unknown>;
  removeFromMyDay: (taskId: string) => void | Promise<unknown>;
  setDueDate: (taskId: string, date: string | null) => void | Promise<unknown>;
  setLocalDisposition: (taskId: string, disposition: LocalDisposition) => void | Promise<unknown>;
  moveToList: (taskId: string, listId: string) => void | Promise<unknown>;
  moveToSource?: (taskId: string) => void;
  addToProject: (taskId: string, projectId: string, phaseId?: string | null) => void | Promise<unknown>;
  deleteTask: (taskId: string) => void | Promise<unknown>;
  saveAsTemplate: (task: { id: string; title: string; subtasks?: string[] }) => void;
}

interface CachedActions {
  signature: string;
  actions: TaskContextMenuActions;
}

export function useTaskContextMenuActionFactory(handlers: TaskActionHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const cacheRef = useRef(new Map<string, CachedActions>());

  return useCallback((task: TaskActionDescriptor): TaskContextMenuActions => {
    const recurrence = extractRecurrenceFromMetadata(task.metadata);
    const signature = JSON.stringify([
      task.title,
      task.dueDate,
      recurrence,
      task.isInMyDay,
      Boolean(handlersRef.current.addToMyDay),
      Boolean(handlersRef.current.moveToSource),
    ]);
    const cached = cacheRef.current.get(task.id);
    if (cached?.signature === signature) return cached.actions;

    const actions: TaskContextMenuActions = {
      onComplete: () => { void handlersRef.current.complete(task.id); },
      onSetPriority: (priority) => { void handlersRef.current.setPriority(task.id, priority); },
      onSetStatus: (status) => { void handlersRef.current.setStatus(task.id, status); },
      onAddToMyDay: !task.isInMyDay && handlersRef.current.addToMyDay
        ? () => { void handlersRef.current.addToMyDay?.(task.id); }
        : undefined,
      onRemoveFromMyDay: task.isInMyDay
        ? () => { void handlersRef.current.removeFromMyDay(task.id); }
        : undefined,
      onDueToday: () => { void handlersRef.current.setDueDate(task.id, getLocalToday()); },
      onDueTomorrow: () => { void handlersRef.current.setDueDate(task.id, getLocalTomorrow()); },
      onPickDate: (date) => { void handlersRef.current.setDueDate(task.id, date); },
      onClearDueDate: () => { void handlersRef.current.setDueDate(task.id, ''); },
      onSetLocalDisposition: (disposition) => {
        void handlersRef.current.setLocalDisposition(task.id, disposition);
      },
      onSkipToCurrent: recurrence && task.dueDate
        ? () => {
            void handlersRef.current.setDueDate(
              task.id,
              getNextRecurringDate(task.dueDate!.split('T')[0], recurrence, getLocalToday()),
            );
          }
        : undefined,
      onMoveToList: (listId) => { void handlersRef.current.moveToList(task.id, listId); },
      onMoveToSource: handlersRef.current.moveToSource
        ? () => handlersRef.current.moveToSource?.(task.id)
        : undefined,
      onAddToProject: (projectId, phaseId) => {
        void handlersRef.current.addToProject(task.id, projectId, phaseId);
      },
      onDelete: () => { void handlersRef.current.deleteTask(task.id); },
      onSaveAsTemplate: () => {
        fetch(`/api/tasks/${task.id}/subtasks`)
          .then((response) => response.ok ? response.json() : { subtasks: [] })
          .then((data) => {
            const subtasks = (data.subtasks || []).map(
              (subtask: { title: string }) => subtask.title,
            );
            handlersRef.current.saveAsTemplate({ id: task.id, title: task.title, subtasks });
          })
          .catch(() => {
            handlersRef.current.saveAsTemplate({ id: task.id, title: task.title });
          });
      },
    };
    cacheRef.current.set(task.id, { signature, actions });
    return actions;
  }, []);
}
