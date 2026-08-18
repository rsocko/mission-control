'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SaveTemplateModal } from '@/components/add-task';
import type { TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import { TaskDetailPanel, type TaskNotesOpenRequest } from '@/components/task-detail/TaskDetailPanel';
import { TodayMainPanel } from '@/components/today/TodayMainPanel';
import { TodayScheduleModal } from '@/components/today/TodayScheduleModal';
import { TodaySidebar } from '@/components/today/TodaySidebar';
import { MobileTodayList } from '@/components/today/MobileTodayList';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MobileSheet } from '@/components/ui/MobileSheet';
import { useMyDayData } from '@/lib/hooks/useMyDayData';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import { useTodayActions } from '@/lib/hooks/useTodayActions';
import { formatDateLocal } from '@/lib/utils/date-format';
import { dashboardKeys } from '@/lib/hooks/useDashboardQueries';
import { getLocalToday, getLocalTomorrow } from '@/lib/utils/client-date';
import type { DashboardProjectViewModel as HubProject, ListGroup } from '@/types/dashboard';
import { extractRecurrenceFromMetadata, getNextRecurringDate } from '@/lib/utils/recurrence';
import type { SuggestionTask } from '@/components/today/types';

export default function TodayPage() {
  const { progress: syncProgress } = useSyncStream();
  const todayISO = useMemo(() => formatDateLocal(new Date()), []);
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [detailSurface, setDetailSurface] = useState<'desktop' | 'mobile'>('desktop');
  const [detailMode, setDetailMode] = useState<'panel' | 'dialog' | 'workspace'>('panel');
  const [pendingMoveDialogTaskId, setPendingMoveDialogTaskId] = useState<string | null>(null);
  const [notesOpenRequest, setNotesOpenRequest] = useState<TaskNotesOpenRequest | null>(null);
  const [selectedSuggestionContext, setSelectedSuggestionContext] = useState<SuggestionTask | null>(null);
  const { items, scheduled, calendarEvents, suggestions, sourceLists, energyLevel, loading, fetchData, setItems, setEnergyLevel } = useMyDayData(todayISO);
  const actions = useTodayActions({ items, setItems, scheduled, calendarEvents, sourceLists, energyLevel, setEnergyLevel, todayISO, fetchData });
  async function completeSelectedTask(taskId: string) {
    if (items.some((item) => item.taskId === taskId)) {
      if (await actions.completeTask(taskId)) {
        setSelectedTaskId((current) => current === taskId ? null : current);
      }
    } else if (await actions.completeTask(taskId, {
      title: selectedSuggestion?.title || 'Task',
      status: selectedSuggestion?.status || 'todo',
      editPolicy: selectedSuggestion?.editPolicy,
    })) {
      setSelectedTaskId((current) => current === taskId ? null : current);
    }
  }
  const taskSelection = useTaskSelection({
    selectedTaskId,
    onSelectionChange: (taskId) => {
      setNotesOpenRequest(null);
      setSelectedSuggestionContext(null);
      setDetailSurface('desktop');
      setDetailMode('panel');
      setSelectedTaskId(taskId);
    },
    onDoubleClick: () => {
      setDetailMode('dialog');
    },
  });
  const projectsQuery = useQuery({
    queryKey: dashboardKeys.projects(),
    queryFn: () => fetch('/api/hub-projects?includePhases=true').then(r => r.json()).then((d: { projects: HubProject[] }) => d.projects || []),
    staleTime: 60 * 1000,
  });
  const projects = useMemo(() => projectsQuery.data || [], [projectsQuery.data]);
  const listGroupsQuery = useQuery({
    queryKey: dashboardKeys.listGroups(),
    queryFn: () => fetch('/api/list-groups').then(r => r.json()).then((d: { groups: ListGroup[] }) => (d.groups || []).map(g => ({ id: g.id, name: g.name, icon: g.icon, iconColor: g.iconColor, sortOrder: g.sortOrder, createdAt: g.createdAt }))),
    staleTime: 60 * 1000,
  });
  const listGroups = useMemo(() => listGroupsQuery.data || [], [listGroupsQuery.data]);

  const addTaskToProject = useCallback(async (taskId: string, projectId: string, phaseId?: string | null) => {
    const project = projects.find((p) => p.id === projectId);
    try {
      const res = await fetch(`/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, phaseId: phaseId ?? null }),
      });
      if (!res.ok) throw new Error('Failed to add to project');
      const phaseName = phaseId ? project?.phases?.find((p) => p.id === phaseId)?.name ?? null : null;
      setItems((current) => current.map((item) =>
        item.taskId === taskId
          ? {
              ...item,
              hubProjectIds: [...(item.hubProjectIds || []).filter((id) => id !== projectId), projectId],
              projectPhaseMemberships: [
                ...(item.projectPhaseMemberships || []).filter((membership) => membership.projectId !== projectId),
                { projectId, phaseId: phaseId ?? null, phaseName },
              ],
            }
          : item
      ));
      toast.success(phaseName
        ? `Moved to ${project?.name || 'project'} → ${phaseName}`
        : `Moved to ${project?.name || 'project'} → No phase`);
    } catch {
      toast.error('Failed to move task to project');
    }
  }, [projects, setItems]);
  const totalMinutes = useMemo(
    () => scheduled
      .filter((task) => task.status !== 'cancelled')
      .reduce((sum, task) => sum + (task.estimatedDuration || 30), 0),
    [scheduled],
  );
  const suggestionTasks = useMemo(() => Object.values(suggestions).flat(), [suggestions]);
  const selectedSuggestion = useMemo(
    () => suggestionTasks.find((item) => item.id === selectedTaskId)
      || (selectedSuggestionContext?.id === selectedTaskId ? selectedSuggestionContext : null),
    [selectedSuggestionContext, selectedTaskId, suggestionTasks],
  );
  const selectedTask = useMemo(() => items.find((item) => item.taskId === selectedTaskId) || null, [items, selectedTaskId]);

  const getSuggestionContextMenuActions = useCallback((task: SuggestionTask): TaskContextMenuActions => {
    const recurrence = extractRecurrenceFromMetadata(task.metadata);
    return {
      onComplete: () => { void actions.completeTask(task.id, { title: task.title, status: task.status, editPolicy: task.editPolicy }); },
      onSetPriority: (priority) => { void actions.setTaskPriority(task.id, priority, task); },
      onSetStatus: (status) => { void actions.setTaskStatus(task.id, status, task); },
      onAddToMyDay: () => { void actions.addToDay(task.id); },
      onDueToday: () => { void actions.setTaskDueDate(task.id, getLocalToday(), task); },
      onDueTomorrow: () => { void actions.setTaskDueDate(task.id, getLocalTomorrow(), task); },
      onPickDate: (date) => { void actions.setTaskDueDate(task.id, date, task); },
      onClearDueDate: () => { void actions.setTaskDueDate(task.id, '', task); },
      onSetLocalDisposition: (disposition) => {
        void actions.setTaskLocalDisposition(task.id, disposition, task);
      },
      onSkipToCurrent: recurrence && task.dueDate
        ? () => { void actions.setTaskDueDate(task.id, getNextRecurringDate(task.dueDate!.split('T')[0], recurrence, getLocalToday()), task); }
        : undefined,
      onMoveToList: (listId) => { void actions.moveTaskToList(task.id, listId); },
      onMoveToSource: () => {
        setSelectedSuggestionContext(task);
        setPendingMoveDialogTaskId(task.id);
        setSelectedTaskId(task.id);
      },
      onAddToProject: (projectId, phaseId) => { void addTaskToProject(task.id, projectId, phaseId); },
      onDelete: () => { void actions.deleteTask(task.id, { title: task.title, editPolicy: task.editPolicy }); },
    };
  }, [actions, addTaskToProject]);

  // Set quick-add context so tasks created from this view are added to My Day
  const { setQuickAddFilter, clearQuickAddFilter } = useQuickAddContext();
  useEffect(() => {
    setQuickAddFilter({ addToMyDay: true, placeholderOverride: 'Add to My Day...' });
    return () => clearQuickAddFilter();
  }, [setQuickAddFilter, clearQuickAddFilter]);

  // React Query handles initial data fetch; only refetch on sync complete (debounced)
  useEffect(() => {
    if (syncProgress.refetchKey > 0) {
      const timeoutId = window.setTimeout(() => {
        void fetchData();
      }, 500);
      return () => window.clearTimeout(timeoutId);
    }
  }, [fetchData, syncProgress.refetchKey]);

  // Refetch when a task is added (immediate + delayed to pick up write-through metadata like issue #)
  const handleTaskAdded = useCallback(() => {
    void fetchData({ skipSync: true });
    const delayedId = window.setTimeout(() => {
      void fetchData({ skipSync: true });
    }, 3000);
    return delayedId;
  }, [fetchData]);

  useEffect(() => {
    let delayedId: number | undefined;
    const listener = () => { delayedId = handleTaskAdded(); };
    window.addEventListener('mission-control:task-added', listener);
    return () => {
      window.removeEventListener('mission-control:task-added', listener);
      if (delayedId) window.clearTimeout(delayedId);
    };
  }, [handleTaskAdded]);

  // Optimistic insert: immediately show newly added My Day tasks without waiting for refetch
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.taskId) return;
      setItems((prev) => {
        if (prev.some((item) => item.taskId === detail.taskId)) return prev;
        const optimisticItem = {
          id: `optimistic-${detail.taskId}`,
          taskId: detail.taskId,
          order: prev.length + 1,
          isAutoIncluded: false,
          addedAt: new Date().toISOString(),
          title: detail.title || 'New task',
          status: detail.status || 'todo',
          priority: detail.priority || 'none',
          dueDate: detail.dueDate || null,
          connectorType: detail.connectorType || 'local',
          connectorInstanceId: 'local',
          sourceListName: detail.sourceListName || null,
          createdAt: new Date().toISOString(),
          tags: [],
          hasDescription: false,
          localDisposition: detail.localDisposition || 'active',
          taskSourceModel: detail.taskSourceModel || detail.editPolicy?.sourceModel || 'mc-owned',
          editPolicy: detail.editPolicy,
        };
        return [...prev, optimisticItem];
      });
    };
    window.addEventListener('mission-control:my-day-item-added', listener);
    return () => window.removeEventListener('mission-control:my-day-item-added', listener);
  }, [setItems]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden sm:flex-row">
      {/* Mobile: compact priority-sorted list (F-16 through F-30) */}
      <MobileTodayList
        items={items}
        loading={loading}
        completingIds={actions.completingIds}
        suggestions={suggestions}
        onCompleteTask={actions.completeTask}
        onRemoveFromDay={actions.removeFromDay}
        onSetTaskDueDate={actions.setTaskDueDate}
        onSetTaskLocalDisposition={(taskId, disposition) => actions.setTaskLocalDisposition(
          taskId,
          disposition,
          items.find((item) => item.taskId === taskId),
        )}
        onAddToDay={actions.addToDay}
        selectedTaskId={detailSurface === 'mobile' ? selectedTaskId : null}
        onSelectTask={(taskId) => {
          setSelectedSuggestionContext(suggestionTasks.find((task) => task.id === taskId) || null);
          setDetailSurface('mobile');
          setDetailMode('panel');
          setSelectedTaskId(taskId);
        }}
        fetchData={fetchData}
        projects={projects}
      />

      {/* Desktop: full-featured main panel */}
      <TodayMainPanel
        data={{
          items, scheduled, calendarEvents, loading, energyLevel, todayISO, sourceLists,
          listGroups, projects, completingIds: actions.completingIds, suggestions,
        }}
        taskActions={{
          setItems,
          fetchData,
          completeTask: actions.completeTask,
          removeFromDay: actions.removeFromDay,
          setPriority: actions.setTaskPriority,
          setStatus: actions.setTaskStatus,
          setDueDate: actions.setTaskDueDate,
          setLocalDisposition: (taskId, disposition) => actions.setTaskLocalDisposition(
            taskId,
            disposition,
            items.find((item) => item.taskId === taskId),
          ),
          openNotes: (taskId, mode) => {
            setDetailSurface('desktop');
            setSelectedTaskId(taskId);
            setNotesOpenRequest((current) => ({
              requestId: (current?.requestId ?? 0) + 1,
              taskId,
              mode,
            }));
          },
          moveToList: actions.moveTaskToList,
          deleteTask: actions.deleteTask,
          addToProject: addTaskToProject,
          saveTemplateTask: actions.setSaveTemplateTask,
          addToDay: actions.addToDay,
          moveToSource: (taskId) => {
            setPendingMoveDialogTaskId(taskId);
            setSelectedTaskId(taskId);
          },
        }}
        selection={{
          selectedTaskId,
          selectTask: (taskId) => {
            setSelectedSuggestionContext(null);
            if (taskId === null) setSelectedTaskId(null);
            else taskSelection.handleTaskClick(taskId);
          },
          doubleClickTask: taskSelection.handleTaskDoubleClick,
          cancelPendingTaskSelection: taskSelection.cancelPendingDeselect,
        }}
        focus={{
          showTimer: actions.showTimer,
          setShowTimer: actions.setShowTimer,
          focusTask: actions.focusTask,
          setFocusTask: actions.setFocusTask,
          startFocus: actions.startFocus,
        }}
        planning={{
          openScheduleModal: actions.setShowScheduleModal,
          whatsNextResult: actions.whatsNextResult,
          setWhatsNextResult: actions.setWhatsNextResult,
          getWhatsNext: actions.getWhatsNext,
          dayPlan: actions.dayPlan,
          setDayPlan: actions.setDayPlan,
          planningDay: actions.planningDay,
          planMyDay: actions.planMyDay,
          scheduleAtTime: actions.scheduleTaskAtTime,
          unscheduleTask: actions.unscheduleTask,
          resizeScheduledTask: actions.resizeScheduledTask,
          setConfirmDialog: actions.setConfirmDialog,
        }}
        setEnergyLevel={setEnergyLevel}
      />

      {selectedTaskId && detailSurface === 'desktop' && detailMode === 'panel' && (
        <div className="hidden min-w-0 shrink sm:flex">
          <TaskDetailPanel
            taskId={selectedTaskId}
            onClose={() => {
              setSelectedTaskId(null);
              setPendingMoveDialogTaskId(null);
              setNotesOpenRequest(null);
            }}
            onUpdate={fetchData}
            availableTags={selectedTask?.tags}
            onSubtaskCountChange={(done, total) => {
              setItems((prev) => prev.map((item) =>
                item.taskId === selectedTaskId ? { ...item, subtaskDone: done, subtaskTotal: total } : item
              ));
            }}
            mode="panel"
            onModeChange={(m) => setDetailMode(m)}
            sourceLists={sourceLists}
            onMoveToList={(targetListId) => actions.moveTaskToList(selectedTaskId, targetListId)}
            onComplete={() => completeSelectedTask(selectedTaskId)}
            onDelete={() => {
              void actions.deleteTask(selectedTaskId, selectedSuggestion ? { title: selectedSuggestion.title, editPolicy: selectedSuggestion.editPolicy } : undefined);
              setSelectedTaskId(null);
            }}
            autoOpenMoveDialog={pendingMoveDialogTaskId === selectedTaskId}
            onMoveDialogDismissed={() => setPendingMoveDialogTaskId(null)}
            notesOpenRequest={notesOpenRequest}
          />
        </div>
      )}

      {selectedTaskId && detailSurface === 'desktop' && detailMode !== 'panel' && (
        <div className="hidden sm:block">
          <TaskDetailPanel
            taskId={selectedTaskId}
            onClose={() => {
              setSelectedTaskId(null);
              setPendingMoveDialogTaskId(null);
              setNotesOpenRequest(null);
            }}
            onUpdate={fetchData}
            availableTags={selectedTask?.tags}
            onSubtaskCountChange={(done, total) => {
              setItems((prev) => prev.map((item) =>
                item.taskId === selectedTaskId ? { ...item, subtaskDone: done, subtaskTotal: total } : item
              ));
            }}
            mode={detailMode}
            onModeChange={(m) => setDetailMode(m)}
            sourceLists={sourceLists}
            onMoveToList={(targetListId) => actions.moveTaskToList(selectedTaskId, targetListId)}
            onComplete={() => completeSelectedTask(selectedTaskId)}
            onDelete={() => {
              void actions.deleteTask(selectedTaskId, selectedSuggestion ? { title: selectedSuggestion.title, editPolicy: selectedSuggestion.editPolicy } : undefined);
              setSelectedTaskId(null);
            }}
            autoOpenMoveDialog={pendingMoveDialogTaskId === selectedTaskId}
            onMoveDialogDismissed={() => setPendingMoveDialogTaskId(null)}
            notesOpenRequest={notesOpenRequest}
          />
        </div>
      )}

      {/* Mobile: task detail in a bottom sheet (fixed position escapes parent layout) */}
      <MobileSheet
        isOpen={!!selectedTaskId && detailSurface === 'mobile'}
        onClose={() => { setSelectedTaskId(null); setPendingMoveDialogTaskId(null); }}
        ariaLabel="Task details"
        height="full"
        className="sm:hidden"
      >
        {selectedTaskId && detailSurface === 'mobile' && (
          <TaskDetailPanel
            taskId={selectedTaskId}
            mode="mobile"
            onClose={() => { setSelectedTaskId(null); setPendingMoveDialogTaskId(null); }}
            onUpdate={() => fetchData()}
            availableTags={selectedTask?.tags}
            onSubtaskCountChange={(done, total) => {
              setItems((prev) => prev.map((item) =>
                item.taskId === selectedTaskId ? { ...item, subtaskDone: done, subtaskTotal: total } : item
              ));
            }}
            isInMyDay={!!selectedTask}
            onToggleMyDay={() => {
              if (selectedTask) {
                void actions.removeFromDay(selectedTaskId);
              } else {
                void actions.addToDay(selectedTaskId);
              }
              setSelectedTaskId(null);
            }}
            sourceLists={sourceLists}
            onMoveToList={(targetListId) => actions.moveTaskToList(selectedTaskId, targetListId)}
            onComplete={() => completeSelectedTask(selectedTaskId)}
            onDelete={() => {
              void actions.deleteTask(selectedTaskId, selectedSuggestion ? { title: selectedSuggestion.title, editPolicy: selectedSuggestion.editPolicy } : undefined);
              setSelectedTaskId(null);
            }}
            autoOpenMoveDialog={pendingMoveDialogTaskId === selectedTaskId}
            onMoveDialogDismissed={() => setPendingMoveDialogTaskId(null)}
          />
        )}
      </MobileSheet>

      <div className="hidden h-full min-h-0 sm:block">
        <TodaySidebar
        suggestions={suggestions}
        totalMinutes={totalMinutes}
        whatsNextLoading={actions.whatsNextLoading}
        onAddToDay={actions.addToDay}
        onSelectTask={(taskId) => {
          const isClosing = selectedTaskId === taskId;
          setDetailSurface('desktop');
          setDetailMode('panel');
          taskSelection.toggleTask(taskId);
          if (!isClosing) {
            setSelectedSuggestionContext(suggestionTasks.find((task) => task.id === taskId) || null);
          }
        }}
        getContextMenuActions={getSuggestionContextMenuActions}
        sourceLists={sourceLists}
        listGroups={listGroups}
        projects={projects}
        onGetWhatsNext={() => { void actions.getWhatsNext(); }}
      />
      </div>

      <TodayScheduleModal
        taskId={actions.showScheduleModal}
        scheduleTime={actions.scheduleTime}
        scheduleDuration={actions.scheduleDuration}
        onClose={() => actions.setShowScheduleModal(null)}
        onSetScheduleTime={actions.setScheduleTime}
        onSetScheduleDuration={actions.setScheduleDuration}
        onSchedule={(taskId) => { void actions.scheduleTask(taskId); }}
      />

      <ConfirmDialog
        open={actions.confirmDialog.open}
        title={actions.confirmDialog.title}
        message={actions.confirmDialog.message}
        confirmLabel={actions.confirmDialog.confirmLabel}
        confirmVariant={actions.confirmDialog.variant}
        onConfirm={actions.confirmDialog.onConfirm}
        onCancel={() => actions.setConfirmDialog((dialog) => ({ ...dialog, open: false }))}
      />

      {actions.saveTemplateTask && (
        <SaveTemplateModal
          tasks={[actions.saveTemplateTask]}
          onClose={() => actions.setSaveTemplateTask(null)}
          onSaved={() => {
            actions.setSaveTemplateTask(null);
            toast.success('Template saved');
          }}
        />
      )}
    </div>
  );
}
