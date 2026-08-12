'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import { pushUndoWithToast } from '@/lib/stores/undoStore';
import { getLocalToday as getClientToday, getLocalTomorrow as getClientTomorrow } from '@/lib/utils/client-date';
import type {
  CalendarEvent,
  ConfirmDialogState,
  DayPlan,
  EnergyLevel,
  MyDayItem,
  SaveTemplateTask,
  ScheduledTask,
  SourceList,
} from '@/components/today/types';
import type { LocalDisposition, TaskEditPolicy, TaskField } from '@/types';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
  taskRemovalConfirmation,
} from '@/lib/tasks/client-edit-policy';

interface UseTodayActionsParams {
  items: MyDayItem[];
  setItems: Dispatch<SetStateAction<MyDayItem[]>>;
  scheduled: ScheduledTask[];
  calendarEvents: CalendarEvent[];
  sourceLists: SourceList[];
  energyLevel: EnergyLevel | null;
  setEnergyLevel: Dispatch<SetStateAction<EnergyLevel | null>>;
  todayISO: string;
  fetchData: (options?: { skipSync?: boolean }) => Promise<void>;
}

const DEFAULT_CONFIRM_DIALOG: ConfirmDialogState = {
  open: false,
  title: '',
  message: '',
  confirmLabel: '',
  variant: 'danger',
  onConfirm: () => {},
};

export function useTodayActions({
  items,
  setItems,
  scheduled,
  calendarEvents,
  sourceLists,
  energyLevel,
  setEnergyLevel,
  todayISO,
  fetchData,
}: UseTodayActionsParams) {
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [focusTask, setFocusTask] = useState<MyDayItem | null>(null);
  const [showTimer, setShowTimer] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState<string | null>(null);
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleDuration, setScheduleDuration] = useState(30);
  const [whatsNextResult, setWhatsNextResult] = useState<string | null>(null);
  const [whatsNextLoading, setWhatsNextLoading] = useState(false);
  const [dayPlan, setDayPlan] = useState<DayPlan | null>(null);
  const [planningDay, setPlanningDay] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(DEFAULT_CONFIRM_DIALOG);
  const [saveTemplateTask, setSaveTemplateTask] = useState<SaveTemplateTask | null>(null);
  const taskPolicy = (taskId: string, context?: { editPolicy?: TaskEditPolicy }) => (
    items.find((item) => item.taskId === taskId)?.editPolicy ?? context?.editPolicy
  );
  const ensureFieldEditable = (
    taskId: string,
    field: TaskField,
    context?: { editPolicy?: TaskEditPolicy },
  ) => {
    const policy = taskPolicy(taskId, context);
    if (canEditTaskField(policy, field)) return true;
    toast.error(taskFieldBlockedReason(policy, field));
    return false;
  };

  async function addToDay(taskId: string) {
    const res = await fetch('/api/my-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, date: todayISO }),
    });
    const data = await res.json();
    if (data.writeBack?.attempted && !data.writeBack?.success) {
      toast.warning('Added to My Day locally, but failed to sync to Microsoft To Do');
    }
    fetchData();
  }

  async function removeFromDay(taskId: string) {
    setItems((prev) => prev.filter((item) => item.taskId !== taskId));
    const params = new URLSearchParams({ taskId, date: todayISO });
    const res = await fetch(`/api/my-day?${params.toString()}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.writeBack?.attempted && !data.writeBack?.success) {
      toast.warning('Removed from My Day locally, but failed to sync to Microsoft To Do');
    }
    fetchData({ skipSync: true });
  }

  async function setTaskLocalDisposition(
    taskId: string,
    disposition: LocalDisposition,
    taskContext?: { localDisposition: LocalDisposition; editPolicy: TaskEditPolicy },
  ) {
    const item = items.find((candidate) => candidate.taskId === taskId);
    const currentDisposition = item?.localDisposition ?? taskContext?.localDisposition;
    const policy = item?.editPolicy ?? taskContext?.editPolicy;
    if (
      !currentDisposition
      || !canSetTaskLocalDisposition(policy, currentDisposition, disposition)
    ) {
      toast.error(currentDisposition
        ? taskDispositionBlockedReason(policy, currentDisposition, disposition)
        : 'Task disposition is unavailable');
      return false;
    }

    const previousItems = items;
    setItems((current) => disposition === 'active'
      ? current.map((candidate) => candidate.taskId === taskId
        ? { ...candidate, localDisposition: disposition }
        : candidate)
      : current.filter((candidate) => candidate.taskId !== taskId));

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localDisposition: disposition }),
      });
      const data = await response.json() as {
        fields?: { localDisposition?: { persisted?: boolean } };
        error?: string;
      };
      if (!response.ok || data.fields?.localDisposition?.persisted !== true) {
        throw new Error(data.error || 'Mission Control state was not saved');
      }
      toast.success(disposition === 'handled'
        ? 'Marked handled in Mission Control'
        : disposition === 'dismissed'
          ? 'Dismissed in Mission Control'
          : 'Restored in Mission Control');
      await fetchData({ skipSync: true });
      return true;
    } catch (error) {
      setItems(previousItems);
      toast.error(error instanceof Error ? error.message : 'Failed to update Mission Control state');
      return false;
    }
  }

  async function completeTask(taskId: string, taskContext?: { title: string; status: string; editPolicy?: TaskEditPolicy }) {
    if (!ensureFieldEditable(taskId, 'status', taskContext)) return false;
    const item = items.find((current) => current.taskId === taskId);
    const taskTitle = item?.title || taskContext?.title || 'Task';
    const previousStatus = item?.status || taskContext?.status || 'todo';

    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        setItems((current) => current.map((candidate) => (
          candidate.taskId === taskId ? { ...candidate, status: 'done' } : candidate
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
        setItems((current) => current.map((candidate) => (
          candidate.taskId === taskId && candidate.status === 'done'
            ? { ...candidate, status: previousStatus }
            : candidate
        )));
      },
    });

    if (outcome === 'completed') {
      pushUndoWithToast(`"${taskTitle}" completed`, async () => {
        await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: previousStatus }),
        });
        fetchData();
        window.dispatchEvent(new CustomEvent('mc:task-completed'));
      });
      window.dispatchEvent(new CustomEvent('mc:task-completed'));
      fetchData();
      return true;
    }

    if (outcome === 'failed') toast.error('Failed to complete task');
    return false;
  }

  async function setTaskDueDate(taskId: string, date: string | null, taskContext?: { editPolicy?: TaskEditPolicy }) {
    if (!ensureFieldEditable(taskId, 'dueDate', taskContext)) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: date }),
      });
      if (!res.ok) throw new Error('Failed');
      toast.success('Due date updated');
      fetchData();
    } catch {
      toast.error('Failed to update due date');
    }

  }

  async function setTaskPriority(taskId: string, priority: string, taskContext?: { editPolicy?: TaskEditPolicy }) {
    if (!ensureFieldEditable(taskId, 'priority', taskContext)) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      if (!res.ok) throw new Error('Failed');
      toast.success('Priority updated');
      fetchData();
    } catch {
      toast.error('Failed to update priority');
    }
  }

  async function updateTaskTitle(taskId: string, title: string) {
    if (!ensureFieldEditable(taskId, 'title')) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error('Failed');
      fetchData({ skipSync: true });
    } catch {
      toast.error('Failed to update title');
    }
  }

  async function updateTaskDescription(taskId: string, description: string) {
    if (!ensureFieldEditable(taskId, 'description')) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      if (!res.ok) throw new Error('Failed');
    } catch {
      toast.error('Failed to update description');
    }
  }

  async function setTaskStatus(taskId: string, status: string, taskContext?: { editPolicy?: TaskEditPolicy }) {
    if (!ensureFieldEditable(taskId, 'status', taskContext)) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('Failed');
      toast.success('Status updated');
      fetchData();
    } catch {
      toast.error('Failed to update status');
    }
  }

  async function deleteTask(taskId: string, taskContext?: { title: string; editPolicy?: TaskEditPolicy }) {
    const item = items.find((current) => current.taskId === taskId);
    const editPolicy = item?.editPolicy ?? taskContext?.editPolicy;
    if (!editPolicy || !canRemoveTask(editPolicy)) {
      toast.error(editPolicy?.removalReason ?? 'This task cannot be removed');
      return;
    }

    const taskTitle = item?.title || taskContext?.title || 'this task';
    const confirmation = taskRemovalConfirmation(editPolicy, taskTitle);
    setConfirmDialog({
      open: true,
      ...confirmation,
      variant: 'danger',
      onConfirm: () => {
        setConfirmDialog((dialog) => ({ ...dialog, open: false }));
        // Defer heavy state updates to the next frame so Radix can finish its
        // close sequence (removing pointer-events:none from <body>) before React
        // re-renders the task list.
        requestAnimationFrame(() => {
          const previousItems = items;
          setItems((prev) => prev.filter((current) => current.taskId !== taskId));
          let undone = false;
          toast.success('Task deleted', {
            action: {
              label: 'Undo',
              onClick: () => {
                undone = true;
                setItems(previousItems);
              },
            },
            duration: 5000,
          });
          setTimeout(async () => {
            if (!undone) {
              try {
                const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('Failed');
                fetchData({ skipSync: true });
              } catch {
                setItems(previousItems);
                toast.error('Failed to delete task');
              }
            }
          }, 5500);
        });
      },
    });
  }

  async function moveTaskToList(taskId: string, targetListId: string) {
    const targetList = sourceLists.find((list) => list.id === targetListId);
    try {
      const res = await fetch(`/api/tasks/${taskId}/move-to-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetListId }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      toast.success(`Moved to ${targetList?.name || 'list'}`, {
        action: data.previousListId ? {
          label: 'Undo',
          onClick: async () => {
            await fetch(`/api/tasks/${taskId}/move-to-list`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ targetListId: data.previousListId }),
            });
            fetchData();
          },
        } : undefined,
        duration: 5000,
      });
      fetchData();
    } catch {
      toast.error('Failed to move task');
    }
  }

  async function scheduleTask(taskId: string) {
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        date: todayISO,
        time: scheduleTime,
        duration: scheduleDuration,
        isTimeBlocked: true,
      }),
    });
    setShowScheduleModal(null);
    fetchData();
  }

  async function unscheduleTask(taskId: string) {
    await fetch(`/api/schedule?taskId=${taskId}`, { method: 'DELETE' });
    fetchData();
  }

  async function scheduleTaskAtTime(taskId: string, time: string, duration: number) {
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, date: todayISO, time, duration, isTimeBlocked: true }),
    });
    fetchData();
  }

  async function resizeScheduledTask(taskId: string, newDuration: number) {
    const task = scheduled.find((current) => current.taskId === taskId);
    if (!task) return;

    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        date: todayISO,
        time: task.scheduledTime,
        duration: newDuration,
        isTimeBlocked: true,
      }),
    });
    fetchData();
  }

  async function getWhatsNext() {
    setWhatsNextLoading(true);
    try {
      const res = await fetch('/api/ai/whats-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeAvailable: 60, energy: energyLevel || 'medium' }),
      });
      const data = await res.json();
      setWhatsNextResult(data.recommendation || data.error);
    } catch {
      setWhatsNextResult('Could not get recommendation. Check AI provider.');
    } finally {
      setWhatsNextLoading(false);
    }
  }

  async function planMyDay() {
    setPlanningDay(true);
    setDayPlan(null);
    try {
      const res = await fetch('/api/ai/plan-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: todayISO, calendarEvents, energy: energyLevel || 'medium' }),
      });
      const data = await res.json();
      if (data.error) setWhatsNextResult(`Plan failed: ${data.error}`);
      else setDayPlan(data);
    } catch {
      setWhatsNextResult('Could not generate day plan. Check AI provider.');
    } finally {
      setPlanningDay(false);
    }
  }

  function startFocus(item: MyDayItem) {
    setFocusTask(item);
    setShowTimer(true);
  }

  return {
    addToDay,
    removeFromDay,
    setTaskLocalDisposition,
    completeTask,
    setTaskDueDate,
    setTaskPriority,
    setTaskStatus,
    updateTaskTitle,
    updateTaskDescription,
    deleteTask,
    moveTaskToList,
    scheduleTask,
    unscheduleTask,
    scheduleTaskAtTime,
    resizeScheduledTask,
    getWhatsNext,
    planMyDay,
    startFocus,
    getLocalToday: getClientToday,
    getLocalTomorrow: getClientTomorrow,
    completingIds,
    focusTask,
    setFocusTask,
    showTimer,
    setShowTimer,
    showScheduleModal,
    setShowScheduleModal,
    scheduleTime,
    setScheduleTime,
    scheduleDuration,
    setScheduleDuration,
    whatsNextResult,
    setWhatsNextResult,
    whatsNextLoading,
    dayPlan,
    setDayPlan,
    planningDay,
    confirmDialog,
    setConfirmDialog,
    saveTemplateTask,
    setSaveTemplateTask,
    setEnergyLevel,
  };
}
