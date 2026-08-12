'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { getLocalToday as getClientToday, getLocalTomorrow as getClientTomorrow } from '@/lib/utils/client-date';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import type { TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type { PhaseItem, ProjectPhase, ProjectTask } from './types';
import {
  canEditTaskField,
  canRemoveTask,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';

/**
 * Hook encapsulating task CRUD actions used across all project tabs.
 * Provides handlers for completion, priority, status, due date, delete,
 * My Day, and move-to-phase operations.
 */
export function useProjectTaskActions({
  tasks,
  setTasks,
  phases,
  phaseItemsByPhase,
  loadProjectDetail,
  projectId,
}: {
  tasks: ProjectTask[];
  setTasks: React.Dispatch<React.SetStateAction<ProjectTask[]>>;
  phases: ProjectPhase[];
  phaseItemsByPhase: Record<string, PhaseItem[]>;
  loadProjectDetail: () => void;
  projectId: string;
}) {
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [myDayTaskIds, setMyDayTaskIds] = useState<Set<string>>(new Set());

  const loadMyDayIds = useCallback(async () => {
    try {
      const res = await fetch('/api/my-day');
      if (res.ok) {
        const data = (await res.json()) as { items?: Array<{ taskId: string }> };
        if (data.items) {
          setMyDayTaskIds(new Set(data.items.map((i) => i.taskId)));
        }
      }
    } catch { /* non-critical */ }
  }, []);

  async function handleCompleteTask(taskId: string) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (!canEditTaskField(task.editPolicy, 'status')) {
      toast.error(taskFieldBlockedReason(task.editPolicy, 'status'));
      return;
    }

    const previousStatus = task.status;
    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        setTasks((current) => current.map((candidate) => (
          candidate.id === taskId ? { ...candidate, status: 'done' as const } : candidate
        )));
      },
      request: async () => {
        const response = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
        if (!response.ok) throw new Error('Failed to complete task');
      },
      rollback: () => {
        setTasks((current) => current.map((candidate) => (
          candidate.id === taskId && candidate.status === 'done'
            ? { ...candidate, status: previousStatus }
            : candidate
        )));
      },
    });

    if (outcome === 'completed') {
      toast.success('Task completed');
    } else if (outcome === 'failed') {
      toast.error('Failed to complete task');
    }
  }

  async function handleSetTaskPriority(taskId: string, priority: string) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!canEditTaskField(task?.editPolicy, 'priority')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'priority'));
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      if (!response.ok) throw new Error('Failed');
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, priority: priority as ProjectTask['priority'] } : t)));
    } catch {
      toast.error('Failed to update priority');
    }
  }

  async function handleSetTaskStatus(taskId: string, status: string) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!canEditTaskField(task?.editPolicy, 'status')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'status'));
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Failed');
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: status as ProjectTask['status'] } : t)));
    } catch {
      toast.error('Failed to update status');
    }
  }

  async function handleSetTaskDueDate(taskId: string, date: string) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!canEditTaskField(task?.editPolicy, 'dueDate')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'dueDate'));
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: date || null }),
      });
      if (!response.ok) throw new Error('Failed');
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, dueDate: date || null } : t)));
    } catch {
      toast.error('Failed to update due date');
    }
  }

  async function handleDeleteTask(taskId: string) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!canRemoveTask(task?.editPolicy)) {
      toast.error(task?.editPolicy.removalReason ?? 'This task cannot be removed');
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed');
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      toast.success('Task deleted');
    } catch {
      toast.error('Failed to delete task');
    }
  }

  async function handleAddToMyDay(taskId: string) {
    try {
      const response = await fetch('/api/my-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!response.ok) throw new Error('Failed');
      setMyDayTaskIds((prev) => new Set(prev).add(taskId));
      toast.success('Added to My Day');
    } catch {
      toast.error('Failed to add to My Day');
    }
  }

  async function handleRemoveFromMyDay(taskId: string) {
    try {
      const response = await fetch(`/api/my-day?taskId=${taskId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed');
      setMyDayTaskIds((prev) => { const next = new Set(prev); next.delete(taskId); return next; });
      toast.success('Removed from My Day');
    } catch {
      toast.error('Failed to remove from My Day');
    }
  }

  async function handleMoveTaskToPhase(taskId: string, targetPhaseId: string | null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!canEditTaskField(task?.editPolicy, 'phases')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'phases'));
      return;
    }
    try {
      // Find current phase for this task
      let currentPhaseId: string | null = null;
      for (const phase of phases) {
        if ((phaseItemsByPhase[phase.id] ?? []).some((item) => item.taskId === taskId)) {
          currentPhaseId = phase.id;
          break;
        }
      }
      if (currentPhaseId) {
        await fetch(`/api/project-phases/${currentPhaseId}/items?task_id=${taskId}`, { method: 'DELETE' });
      }
      if (targetPhaseId) {
        const existingItems = phaseItemsByPhase[targetPhaseId] ?? [];
        const nextOrder = existingItems.length > 0 ? Math.max(...existingItems.map((i) => i.sortOrder)) + 1 : 0;
        await fetch(`/api/project-phases/${targetPhaseId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, sortOrder: nextOrder }),
        });
      }
      loadProjectDetail();
      const phaseName = targetPhaseId ? phases.find((p) => p.id === targetPhaseId)?.name : 'No phase';
      toast.success(`Moved to ${phaseName}`);
    } catch {
      toast.error('Failed to move task');
    }
  }

  function handleRemoveFromProject(taskId: string) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!canEditTaskField(task?.editPolicy, 'projects')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'projects'));
      return;
    }
    const previousTasks = tasks;
    setTasks((prev) => prev.filter((t) => t.id !== taskId));

    let undone = false;
    toast.success('Removed from project', {
      action: {
        label: 'Undo',
        onClick: () => {
          undone = true;
          setTasks(previousTasks);
        },
      },
      duration: 5000,
    });

    setTimeout(async () => {
      if (!undone) {
        try {
          const res = await fetch(`/api/hub-projects/${projectId}/tasks`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId }),
          });
          if (!res.ok) {
            setTasks(previousTasks);
            toast.error('Failed to remove task from project');
          }
        } catch {
          setTasks(previousTasks);
          toast.error('Failed to remove task from project');
        }
      }
    }, 5500);
  }

  function getTaskContextActions(task: ProjectTask): TaskContextMenuActions {
    return {
      onComplete: () => void handleCompleteTask(task.id),
      onSetPriority: (priority) => void handleSetTaskPriority(task.id, priority),
      onSetStatus: (status) => void handleSetTaskStatus(task.id, status),
      onAddToMyDay: () => void handleAddToMyDay(task.id),
      onRemoveFromMyDay: () => void handleRemoveFromMyDay(task.id),
      onMoveToPhase: (phaseId) => void handleMoveTaskToPhase(task.id, phaseId),
      onDueToday: () => void handleSetTaskDueDate(task.id, getClientToday()),
      onDueTomorrow: () => void handleSetTaskDueDate(task.id, getClientTomorrow()),
      onPickDate: (date) => void handleSetTaskDueDate(task.id, date),
      onClearDueDate: () => void handleSetTaskDueDate(task.id, ''),
      onRemoveFromProject: () => void handleRemoveFromProject(task.id),
      onDelete: () => void handleDeleteTask(task.id),
    };
  }

  return {
    completingIds,
    myDayTaskIds,
    loadMyDayIds,
    getTaskContextActions,
    handleCompleteTask,
    handleSetTaskPriority,
    handleSetTaskStatus,
    handleSetTaskDueDate,
    handleDeleteTask,
    handleAddToMyDay,
    handleRemoveFromMyDay,
    handleRemoveFromProject,
    handleMoveTaskToPhase,
  };
}
