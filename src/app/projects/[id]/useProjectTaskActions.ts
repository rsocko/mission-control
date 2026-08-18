'use client';

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import type {
  HubProject,
  TaskContextMenuActions,
} from '@/components/task-list/TaskContextMenu';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandResult,
} from '@/lib/projects/hierarchy-types';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import {
  getLocalToday as getClientToday,
  getLocalTomorrow as getClientTomorrow,
} from '@/lib/utils/client-date';
import type {
  LocalDisposition,
  TaskPriority,
  TaskStatus,
} from '@/types';
import type {
  ProjectPhaseItemViewModel as PhaseItem,
  ProjectPhaseViewModel as ProjectPhase,
  ProjectTaskViewModel as ProjectTask,
} from './types';
import { notifyTaskChanged } from '@/lib/task-change-events';

export type RunProjectHierarchyCommand = (
  command: ProjectHierarchyCommand,
  options: { undoLabel: string; announcement: string },
) => Promise<ProjectHierarchyCommandResult>;

interface UseProjectTaskActionsOptions {
  projectId: string;
  tasks: ProjectTask[];
  setTasks: Dispatch<SetStateAction<ProjectTask[]>>;
  phases: ProjectPhase[];
  phaseItemsByPhase: Record<string, PhaseItem[]>;
  projects: HubProject[];
  removeTaskFromView: (taskId: string) => void;
  stageProjectTaskRemoval: (taskId: string) => () => void;
  refreshProjectHierarchy: () => Promise<void>;
  runHierarchyCommand: RunProjectHierarchyCommand;
}

export function useProjectTaskActions({
  projectId,
  tasks,
  setTasks,
  phases,
  phaseItemsByPhase,
  projects,
  removeTaskFromView,
  stageProjectTaskRemoval,
  refreshProjectHierarchy,
  runHierarchyCommand,
}: UseProjectTaskActionsOptions) {
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [myDayTaskIds, setMyDayTaskIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/my-day')
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { items?: Array<{ taskId: string }> } | null) => {
        if (payload?.items) {
          setMyDayTaskIds(new Set(payload.items.map((item) => item.taskId)));
        }
      })
      .catch(() => {
        // My Day membership is supplementary and should not block project loading.
      });
  }, []);

  const requireEditableTask = useCallback((
    taskId: string,
    field: 'status' | 'priority' | 'dueDate',
  ): ProjectTask | null => {
    const task = tasks.find((candidate) => candidate.id === taskId) ?? null;
    if (task && canEditTaskField(task.editPolicy, field)) return task;
    toast.error(taskFieldBlockedReason(task?.editPolicy, field));
    return null;
  }, [tasks]);

  const handleCompleteTask = useCallback(async (taskId: string) => {
    const task = requireEditableTask(taskId, 'status');
    if (!task) return;

    const previousStatus = task.status;
    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        setTasks((current) => current.map((candidate) => (
          candidate.id === taskId
            ? { ...candidate, status: 'done' as TaskStatus }
            : candidate
        )));
      },
      request: async () => {
        const response = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
        if (!response.ok) throw new Error('Failed to complete task');
        notifyTaskChanged(taskId);
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
  }, [requireEditableTask, runTaskCompletion, setTasks]);

  const handleSetTaskPriority = useCallback(async (
    taskId: string,
    priority: string,
  ) => {
    if (!requireEditableTask(taskId, 'priority')) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      if (!response.ok) throw new Error('Failed to set priority');
      notifyTaskChanged(taskId);
      setTasks((current) => current.map((task) => (
        task.id === taskId
          ? { ...task, priority: priority as TaskPriority }
          : task
      )));
    } catch {
      toast.error('Failed to set priority');
    }
  }, [requireEditableTask, setTasks]);

  const handleSetTaskStatus = useCallback(async (
    taskId: string,
    status: string,
  ) => {
    if (!requireEditableTask(taskId, 'status')) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Failed to set status');
      notifyTaskChanged(taskId);
      setTasks((current) => current.map((task) => (
        task.id === taskId
          ? { ...task, status: status as TaskStatus }
          : task
      )));
    } catch {
      toast.error('Failed to set status');
    }
  }, [requireEditableTask, setTasks]);

  const handleSetTaskDueDate = useCallback(async (
    taskId: string,
    date: string,
  ) => {
    if (!requireEditableTask(taskId, 'dueDate')) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: date || null }),
      });
      if (!response.ok) throw new Error('Failed to set due date');
      notifyTaskChanged(taskId);
      setTasks((current) => current.map((task) => (
        task.id === taskId ? { ...task, dueDate: date || null } : task
      )));
    } catch {
      toast.error('Failed to set due date');
    }
  }, [requireEditableTask, setTasks]);

  const handleSetTaskLocalDisposition = useCallback(async (
    taskId: string,
    disposition: LocalDisposition,
  ) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (
      !task
      || !canSetTaskLocalDisposition(
        task.editPolicy,
        task.localDisposition,
        disposition,
      )
    ) {
      toast.error(task
        ? taskDispositionBlockedReason(
            task.editPolicy,
            task.localDisposition,
            disposition,
          )
        : 'Task disposition is unavailable');
      return;
    }

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localDisposition: disposition }),
      });
      const payload = await response.json() as {
        fields?: { localDisposition?: { persisted?: boolean } };
        error?: string;
      };
      if (
        !response.ok
        || payload.fields?.localDisposition?.persisted !== true
      ) {
        throw new Error(payload.error || 'Mission Control state was not saved');
      }
      notifyTaskChanged(taskId);
      setTasks((current) => disposition === 'active'
        ? current.map((candidate) => candidate.id === taskId
          ? { ...candidate, localDisposition: disposition }
          : candidate)
        : current.filter((candidate) => candidate.id !== taskId));
      toast.success(disposition === 'handled'
        ? 'Marked handled in Mission Control'
        : disposition === 'dismissed'
          ? 'Dismissed in Mission Control'
          : 'Restored in Mission Control');
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : 'Failed to update Mission Control state');
    }
  }, [setTasks, tasks]);

  const handleDeleteTask = useCallback(async (taskId: string) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !canRemoveTask(task.editPolicy)) {
      toast.error(
        task?.editPolicy.removalReason ?? 'This task cannot be removed',
      );
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete task');
      removeTaskFromView(taskId);
      await refreshProjectHierarchy();
      toast.success('Task deleted');
    } catch {
      toast.error('Failed to delete task');
    }
  }, [refreshProjectHierarchy, removeTaskFromView, tasks]);

  const handleRemoveFromProject = useCallback((taskId: string) => {
    const rollback = stageProjectTaskRemoval(taskId);
    let undone = false;

    toast.success('Removed from project', {
      action: {
        label: 'Undo',
        onClick: () => {
          undone = true;
          rollback();
        },
      },
      duration: 5000,
    });

    setTimeout(async () => {
      if (undone) return;
      try {
        const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId }),
        });
        if (!response.ok) {
          rollback();
          toast.error('Failed to remove task from project');
          return;
        }
        await refreshProjectHierarchy();
        notifyTaskChanged(taskId);
      } catch {
        rollback();
        toast.error('Failed to remove task from project');
      }
    }, 5500);
  }, [projectId, refreshProjectHierarchy, stageProjectTaskRemoval]);

  const handleMoveTaskToPhase = useCallback(async (
    taskId: string,
    targetPhaseId: string | null,
  ) => {
    const currentPhaseId = phases.find((phase) => (
      (phaseItemsByPhase[phase.id] ?? []).some((item) => (
        item.taskId === taskId
      ))
    ))?.id ?? null;
    if (currentPhaseId === targetPhaseId) return;

    const taskName = tasks.find((task) => task.id === taskId)?.title ?? 'Task';
    const phaseName = targetPhaseId
      ? phases.find((phase) => phase.id === targetPhaseId)?.name ?? 'phase'
      : 'No phase';
    try {
      await runHierarchyCommand({
        type: 'move_tasks',
        taskIds: [taskId],
        toPhaseId: targetPhaseId,
        toIndex: targetPhaseId
          ? (phaseItemsByPhase[targetPhaseId] ?? []).length
          : 0,
      }, {
        undoLabel: `Moved ${taskName} to ${phaseName}`,
        announcement: `Moved ${taskName} to ${phaseName}`,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to move task');
    }
  }, [phaseItemsByPhase, phases, runHierarchyCommand, tasks]);

  const handleAddToProject = useCallback(async (
    taskId: string,
    targetProjectId: string,
    phaseId?: string | null,
  ) => {
    const targetProject = projects.find((project) => (
      project.id === targetProjectId
    ));

    if (targetProjectId === projectId) {
      await handleMoveTaskToPhase(taskId, phaseId ?? null);
      return;
    }

    try {
      const response = await fetch(
        `/api/hub-projects/${targetProjectId}/tasks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, phaseId: phaseId ?? null }),
        },
      );
      if (!response.ok) throw new Error('Failed to add to project');
      notifyTaskChanged(taskId);

      const phaseName = phaseId
        ? targetProject?.phases?.find((phase) => phase.id === phaseId)?.name
          ?? null
        : null;
      const label = phaseName
        ? `Moved to ${targetProject?.name || 'project'} → ${phaseName}`
        : `Moved to ${targetProject?.name || 'project'} → No phase`;
      toast.success(label);
      setTasks((current) => current.map((task) => (
        task.id === taskId
          ? {
              ...task,
              hubProjectIds: [
                ...(task.hubProjectIds ?? []).filter((id) => (
                  id !== targetProjectId
                )),
                targetProjectId,
              ],
              projectPhaseMemberships: [
                ...(task.projectPhaseMemberships ?? []).filter((membership) => (
                  membership.projectId !== targetProjectId
                )),
                {
                  projectId: targetProjectId,
                  projectName: targetProject?.name || 'Unknown Project',
                  phaseId: phaseId ?? null,
                  phaseName,
                },
              ],
            }
          : task
      )));
    } catch {
      toast.error('Failed to add task to project');
    }
  }, [handleMoveTaskToPhase, projectId, projects, setTasks]);

  const handleAddToMyDay = useCallback(async (taskId: string) => {
    try {
      const response = await fetch('/api/my-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!response.ok) throw new Error('Failed to add to My Day');
      notifyTaskChanged(taskId);
      setMyDayTaskIds((current) => new Set(current).add(taskId));
      toast.success('Added to My Day');
    } catch {
      toast.error('Failed to add to My Day');
    }
  }, []);

  const handleRemoveFromMyDay = useCallback(async (taskId: string) => {
    try {
      const response = await fetch(`/api/my-day?taskId=${taskId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to remove from My Day');
      notifyTaskChanged(taskId);
      setMyDayTaskIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
      toast.success('Removed from My Day');
    } catch {
      toast.error('Failed to remove from My Day');
    }
  }, []);

  const getTaskContextActions = useCallback((
    task: ProjectTask,
  ): TaskContextMenuActions => ({
    onComplete: () => void handleCompleteTask(task.id),
    onSetPriority: (priority) => {
      void handleSetTaskPriority(task.id, priority);
    },
    onSetStatus: (status) => {
      void handleSetTaskStatus(task.id, status);
    },
    onAddToMyDay: () => void handleAddToMyDay(task.id),
    onRemoveFromMyDay: () => void handleRemoveFromMyDay(task.id),
    onMoveToPhase: (phaseId) => {
      void handleMoveTaskToPhase(task.id, phaseId);
    },
    onAddToProject: (targetProjectId, phaseId) => {
      void handleAddToProject(task.id, targetProjectId, phaseId);
    },
    onDueToday: () => {
      void handleSetTaskDueDate(task.id, getClientToday());
    },
    onDueTomorrow: () => {
      void handleSetTaskDueDate(task.id, getClientTomorrow());
    },
    onPickDate: (date) => {
      void handleSetTaskDueDate(task.id, date);
    },
    onClearDueDate: () => {
      void handleSetTaskDueDate(task.id, '');
    },
    onSetLocalDisposition: (disposition) => {
      void handleSetTaskLocalDisposition(task.id, disposition);
    },
    onRemoveFromProject: () => handleRemoveFromProject(task.id),
    onDelete: () => void handleDeleteTask(task.id),
  }), [
    handleAddToMyDay,
    handleAddToProject,
    handleCompleteTask,
    handleDeleteTask,
    handleMoveTaskToPhase,
    handleRemoveFromMyDay,
    handleRemoveFromProject,
    handleSetTaskDueDate,
    handleSetTaskLocalDisposition,
    handleSetTaskPriority,
    handleSetTaskStatus,
  ]);

  return {
    completingIds,
    myDayTaskIds,
    getTaskContextActions,
    handleCompleteTask,
    handleSetTaskPriority,
    handleSetTaskStatus,
    handleSetTaskDueDate,
    handleSetTaskLocalDisposition,
    handleDeleteTask,
    handleRemoveFromProject,
    handleAddToProject,
    handleAddToMyDay,
    handleRemoveFromMyDay,
    handleMoveTaskToPhase,
  };
}
