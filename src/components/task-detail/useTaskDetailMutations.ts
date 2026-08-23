'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { taskLogger } from '@/lib/client-logger';
import { getLocalToday } from '@/lib/utils/client-date';
import { formatShortDate } from '@/lib/utils/task-detail-date';
import { EFFORT_TO_DURATION, durationToEffort } from '@/lib/constants/task-formatting';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
  taskRemovalConfirmation,
} from '@/lib/tasks/client-edit-policy';
import {
  executeProjectHierarchyCommand,
  ProjectHierarchyClientError,
} from '@/lib/projects/hierarchy-client';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import type { LocalDisposition, TaskField } from '@/types';
import { notifyNavigationCountsChanged } from '@/lib/navigation/badges';
import type { DuplicateCandidate } from './DuplicateTaskPreview';
import {
  addTaskTags,
  addTaskToProject,
  deleteTask as deleteTaskRequest,
  fetchMicroStatusSuggestion,
  fetchTagOptions,
  patchTask,
  removeTaskFromProject,
  removeTaskTag,
  runOptimisticMutation,
  setMyDayMembership,
} from './task-detail-api';
import { taskPhaseInProject } from './useTaskDetailData';
import type {
  MicroStatusSuggestion,
  TagConnectorCaps,
  TaskDetail,
  TaskFieldUpdate,
  TaskTag,
} from './task-detail-types';

/** Confirmation the panel must show before a destructive mutation runs. */
export interface TaskConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  onConfirm: () => void;
  alternateLabel?: string;
  onAlternate?: () => void;
}

export interface UseTaskDetailMutationsOptions {
  taskId: string;
  task: TaskDetail | null;
  setTask: React.Dispatch<React.SetStateAction<TaskDetail | null>>;
  onUpdate?: (fields?: TaskFieldUpdate) => void;
  /** Tags supplied by the host, merged with picker results for display. */
  availableTags: TaskTag[];
  extraTags: TaskTag[];
  setExtraTags: React.Dispatch<React.SetStateAction<TaskTag[]>>;
  connectorCaps: TagConnectorCaps | null;
  projectHierarchies: Record<string, ProjectHierarchySnapshot | null>;
  setProjectHierarchies: React.Dispatch<
    React.SetStateAction<Record<string, ProjectHierarchySnapshot | null>>
  >;
  setPotentialDuplicates: React.Dispatch<React.SetStateAction<DuplicateCandidate[]>>;
  /** Effective My Day membership, host override included. */
  isInMyDay: boolean;
  onClose: () => void;
  onComplete?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onToggleMyDay?: () => void | Promise<void>;
  /** Opens the panel's confirmation dialog. */
  requestConfirm: (request: TaskConfirmRequest) => void;
}

/**
 * Every task detail mutation workflow, including optimistic updates and their
 * rollbacks. Kept free of layout so it can be exercised without the panel.
 */
export function useTaskDetailMutations({
  taskId,
  task,
  setTask,
  onUpdate,
  availableTags,
  extraTags,
  setExtraTags,
  connectorCaps,
  projectHierarchies,
  setProjectHierarchies,
  setPotentialDuplicates,
  isInMyDay,
  onClose,
  onComplete,
  onDelete,
  onToggleMyDay,
  requestConfirm,
}: UseTaskDetailMutationsOptions) {
  const [durationHighlight, setDurationHighlight] = useState(false);
  const [effortHighlight, setEffortHighlight] = useState(false);
  const [updatingDisposition, setUpdatingDisposition] = useState(false);
  const [updatingMyDay, setUpdatingMyDay] = useState(false);
  const [updatingProjectPhaseIds, setUpdatingProjectPhaseIds] = useState<Set<string>>(new Set());
  const [skippingToCurrent, setSkippingToCurrent] = useState(false);
  const [reminderSaving, setReminderSaving] = useState(false);
  const [microStatusSuggestion, setMicroStatusSuggestion] = useState<MicroStatusSuggestion | null>(null);
  const [showMicroStatusPicker, setShowMicroStatusPicker] = useState(false);
  const [showCloseReasonPicker, setShowCloseReasonPicker] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [pickerTags, setPickerTags] = useState<TaskTag[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const skipToCurrentInFlightRef = useRef(false);
  const highlightTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => () => {
    highlightTimeoutsRef.current.forEach(clearTimeout);
    highlightTimeoutsRef.current = [];
  }, []);

  const flashHighlight = useCallback((setHighlight: (value: boolean) => void) => {
    setHighlight(true);
    const timeout = setTimeout(() => setHighlight(false), 700);
    highlightTimeoutsRef.current.push(timeout);
  }, []);

  const editPolicy = task?.editPolicy;
  const ensureFieldsEditable = useCallback((...fields: TaskField[]) => {
    const blockedField = fields.find((field) => !canEditTaskField(editPolicy, field));
    if (!blockedField) return true;
    toast.error(taskFieldBlockedReason(editPolicy, blockedField));
    return false;
  }, [editPolicy]);

  /** Reset pickers that must not survive a task switch. */
  const resetTransientState = useCallback(() => {
    setShowTagPicker(false);
    setShowCloseReasonPicker(false);
    setPendingStatus(null);
  }, []);

  const saveField = useCallback(async (
    field: TaskField,
    value: string | number | null | undefined,
    reportError = true,
  ) => {
    if (!ensureFieldsEditable(field)) return false;
    try {
      const result = await patchTask(taskId, { [field]: value });
      if (!result.ok) throw new Error(`Failed to save ${field}`);
      onUpdate?.({ [field]: value });
      notifyNavigationCountsChanged();
      return true;
    } catch {
      if (reportError) {
        toast.error(`Failed to save ${field === 'description' ? 'notes' : field}`);
      }
      return false;
    }
  }, [ensureFieldsEditable, taskId, onUpdate]);

  const openTagPicker = useCallback(async () => {
    setShowTagPicker(true);
    setTagInput('');
    setPickerLoading(true);
    try {
      const tags = await fetchTagOptions({
        connectorCaps,
        sourceListId: task?.sourceListId,
        connectorType: task?.connectorType,
      });
      setPickerTags(tags);
      // Merge any new tags into extraTags so display is consistent
      setExtraTags((prev) => {
        const existing = new Set(prev.map((tag) => tag.id));
        return [...prev, ...tags.filter((tag) => !existing.has(tag.id))];
      });
    } catch {
      setPickerTags([]);
    } finally {
      setPickerLoading(false);
    }
  }, [connectorCaps, setExtraTags, task?.sourceListId, task?.connectorType]);

  const closeTagPicker = useCallback(() => {
    setShowTagPicker(false);
    setTagInput('');
  }, []);

  const handleAddTag = useCallback(async (tagName: string) => {
    if (!tagName.trim() || !ensureFieldsEditable('tags')) return;
    const result = await addTaskTags(taskId, [tagName.trim()]);
    if (!result.ok) {
      toast.error(result.error || 'Failed to add tag');
      return;
    }
    if (result.rejectedTags.length && !result.addedTagIds.length) {
      toast.error(`Label "${result.rejectedTags[0]}" doesn't exist in this source. Please create it there first.`);
      return;
    }
    if (result.addedTagIds.length) {
      // Find the tag in pickerTags or available tags to get its full details
      const allKnown = [...pickerTags, ...availableTags, ...extraTags];
      const addedTag = allKnown.find((tag) => result.addedTagIds.includes(tag.id));
      setTask((prev) => prev ? { ...prev, tagIds: [...(prev.tagIds || []), ...result.addedTagIds] } : prev);
      if (addedTag) {
        setExtraTags((prev) => prev.some((tag) => tag.id === addedTag.id) ? prev : [...prev, addedTag]);
      } else {
        // Tag was newly created (freeform); refresh picker to get it
        fetchTagOptions({
          connectorCaps,
          sourceListId: task?.sourceListId,
          connectorType: task?.connectorType,
        })
          .then((tags) => {
            const newTag = tags.find((tag) => result.addedTagIds.includes(tag.id));
            if (newTag) setExtraTags((prev) => prev.some((tag) => tag.id === newTag.id) ? prev : [...prev, newTag]);
          })
          .catch((err) => { taskLogger.error('Failed to refresh tags after creation', { err }); });
      }
      onUpdate?.();
    }
    setTagInput('');
  }, [
    availableTags,
    connectorCaps,
    ensureFieldsEditable,
    extraTags,
    onUpdate,
    pickerTags,
    setExtraTags,
    setTask,
    task?.connectorType,
    task?.sourceListId,
    taskId,
  ]);

  const handleRemoveTag = useCallback(async (tagId: string) => {
    if (!ensureFieldsEditable('tags')) return;
    const removed = await runOptimisticMutation({
      apply: () => setTask((prev) => (
        prev ? { ...prev, tagIds: (prev.tagIds || []).filter((id) => id !== tagId) } : prev
      )),
      mutate: () => removeTaskTag(taskId, tagId),
      rollback: () => setTask((prev) => (
        prev ? { ...prev, tagIds: [...(prev.tagIds || []), tagId] } : prev
      )),
      onError: () => toast.error('Failed to remove tag'),
    });
    if (removed) onUpdate?.();
  }, [ensureFieldsEditable, onUpdate, setTask, taskId]);

  const handleStatusChange = useCallback(async (status: string) => {
    // Handle "Close as Not Planned" / "Close as Duplicate" from dropdown
    if (status.startsWith('cancelled:')) {
      if (!ensureFieldsEditable('status', 'statusReason')) return;
      const reason = status.slice('cancelled:'.length) as 'not_planned' | 'duplicate';
      const result = await patchTask(taskId, { status: 'cancelled', statusReason: reason });
      if (!result.ok) {
        toast.error('Failed to update task status');
        return;
      }
      const reminder = result.data.reminder as Pick<
        TaskDetail,
        'reminderAt' | 'reminderRelative' | 'reminderDueTime'
      > | undefined;
      if (!ensureFieldsEditable('status')) return;
      setTask((prev) => prev
        ? { ...prev, status: 'cancelled', statusReason: reason, ...(reminder ?? {}) }
        : prev);
      onUpdate?.({ status: 'cancelled', statusReason: reason });
      notifyNavigationCountsChanged();
      return;
    }
    // For GitHub tasks being cancelled (plain), offer close reason selection
    if (status === 'cancelled' && task?.connectorType === 'github-issues') {
      setPendingStatus(status);
      setShowCloseReasonPicker(true);
      return;
    }
    const result = await patchTask(taskId, { status });
    if (!result.ok) {
      toast.error('Failed to update task status');
      return;
    }
    const reminder = result.data.reminder as Pick<
      TaskDetail,
      'reminderAt' | 'reminderRelative' | 'reminderDueTime'
    > | undefined;
    setTask((prev) => prev ? { ...prev, status, statusReason: null, ...(reminder ?? {}) } : prev);
    onUpdate?.({ status });
    notifyNavigationCountsChanged();
  }, [ensureFieldsEditable, onUpdate, setTask, task?.connectorType, taskId]);

  const handleComplete = useCallback(() => {
    if (onComplete) {
      void onComplete();
      return;
    }
    void handleStatusChange('done');
  }, [handleStatusChange, onComplete]);

  const handleCloseWithReason = useCallback(async (reason: 'not_planned' | 'duplicate') => {
    if (!ensureFieldsEditable('status', 'statusReason')) return;
    const status = pendingStatus || 'cancelled';
    const result = await patchTask(taskId, { status, statusReason: reason });
    if (!result.ok) {
      toast.error('Failed to update task status');
      return;
    }
    setTask((prev) => prev ? { ...prev, status, statusReason: reason } : prev);
    setShowCloseReasonPicker(false);
    setPendingStatus(null);
    onUpdate?.({ status, statusReason: reason });
    notifyNavigationCountsChanged();
  }, [ensureFieldsEditable, onUpdate, pendingStatus, setTask, taskId]);

  const cancelCloseReason = useCallback(() => {
    setShowCloseReasonPicker(false);
    setPendingStatus(null);
  }, []);

  const handleCloseAsDuplicate = useCallback(async () => {
    const updates = { status: 'cancelled', statusReason: 'duplicate' };
    await patchTask(taskId, updates);
    setTask((prev) => prev ? { ...prev, status: 'cancelled', statusReason: 'duplicate' } : prev);
    setPotentialDuplicates([]);
    onUpdate?.(updates);
    notifyNavigationCountsChanged();
  }, [onUpdate, setPotentialDuplicates, setTask, taskId]);

  const handleToggleMyDay = useCallback(async () => {
    if (updatingMyDay) return;
    setUpdatingMyDay(true);
    try {
      if (onToggleMyDay) {
        await onToggleMyDay();
        return;
      }

      const result = await setMyDayMembership({
        taskId,
        date: getLocalToday(),
        isInMyDay,
      });
      if (!result.ok) {
        throw new Error(result.error || 'Failed to update My Day');
      }

      const nextIsInMyDay = !isInMyDay;
      setTask((current) => (
        current?.id === taskId ? { ...current, isInMyDay: nextIsInMyDay } : current
      ));
      onUpdate?.();
      notifyNavigationCountsChanged();
      if (nextIsInMyDay) {
        window.dispatchEvent(new CustomEvent('mission-control:my-day-item-added', {
          detail: { taskId, title: task?.title },
        }));
      }
      if (result.writeBackAttempted && !result.writeBackSucceeded) {
        toast.warning(`${nextIsInMyDay ? 'Added to' : 'Removed from'} My Day locally, but failed to sync to Microsoft To Do`);
      } else {
        toast.success(nextIsInMyDay ? 'Added to My Day' : 'Removed from My Day');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update My Day');
    } finally {
      setUpdatingMyDay(false);
    }
  }, [isInMyDay, onToggleMyDay, onUpdate, setTask, task?.title, taskId, updatingMyDay]);

  const handleDelete = useCallback(() => {
    if (!task || !canRemoveTask(task.editPolicy)) return;
    if (onDelete) {
      void onDelete();
      return;
    }
    const confirmation = taskRemovalConfirmation(task.editPolicy, task.title);
    requestConfirm({
      ...confirmation,
      variant: 'danger',
      onConfirm: () => {
        void (async () => {
          try {
            await deleteTaskRequest(task.id);
            toast.success('Task deleted');
            onUpdate?.();
            notifyNavigationCountsChanged();
            onClose();
          } catch {
            toast.error('Failed to delete task');
          }
        })();
      },
    });
  }, [onClose, onDelete, onUpdate, requestConfirm, task]);

  const handlePriorityChange = useCallback(async (priority: string) => {
    if (!(await saveField('priority', priority))) return;
    setTask((prev) => prev ? { ...prev, priority } : prev);
  }, [saveField, setTask]);

  const handleLocalDispositionChange = useCallback(async (localDisposition: LocalDisposition) => {
    if (!task || !canSetTaskLocalDisposition(
      task.editPolicy,
      task.localDisposition,
      localDisposition,
    )) {
      toast.error(task
        ? taskDispositionBlockedReason(task.editPolicy, task.localDisposition, localDisposition)
        : 'Task disposition is unavailable');
      return;
    }

    const previousDisposition = task.localDisposition;
    setUpdatingDisposition(true);
    setTask((current) => current ? { ...current, localDisposition } : current);
    try {
      const result = await patchTask(taskId, { localDisposition });
      const fields = result.data.fields as { localDisposition?: { persisted?: boolean } } | undefined;
      if (!result.ok || fields?.localDisposition?.persisted !== true) {
        throw new Error(
          typeof result.data.error === 'string'
            ? result.data.error
            : 'Mission Control state was not saved',
        );
      }
      toast.success(localDisposition === 'handled'
        ? 'Marked handled in Mission Control'
        : localDisposition === 'dismissed'
          ? 'Dismissed in Mission Control'
          : 'Restored in Mission Control');
      onUpdate?.({ localDisposition });
    } catch (error) {
      setTask((current) => current ? { ...current, localDisposition: previousDisposition } : current);
      toast.error(error instanceof Error ? error.message : 'Failed to update Mission Control state');
    } finally {
      setUpdatingDisposition(false);
    }
  }, [onUpdate, setTask, task, taskId]);

  const handleEffortChange = useCallback(async (effort: number | null) => {
    const suggestedDuration = effort ? EFFORT_TO_DURATION[effort] : undefined;
    const updates = suggestedDuration
      ? { effort, estimatedDuration: suggestedDuration }
      : { effort };
    const fields: TaskField[] = suggestedDuration ? ['effort', 'estimatedDuration'] : ['effort'];
    if (!ensureFieldsEditable(...fields)) return;
    const result = await patchTask(taskId, updates);
    if (!result.ok) {
      toast.error('Failed to update effort');
      return;
    }
    if (suggestedDuration) flashHighlight(setDurationHighlight);
    setTask((prev) => prev ? { ...prev, ...updates } : prev);
    onUpdate?.(updates);
  }, [ensureFieldsEditable, flashHighlight, onUpdate, setTask, taskId]);

  const handleDurationChange = useCallback(async (minutes: number | null) => {
    const suggestedEffort = minutes ? durationToEffort(minutes) : undefined;
    const updates = suggestedEffort
      ? { estimatedDuration: minutes, effort: suggestedEffort }
      : { estimatedDuration: minutes };
    const fields: TaskField[] = suggestedEffort ? ['estimatedDuration', 'effort'] : ['estimatedDuration'];
    if (!ensureFieldsEditable(...fields)) return;
    const result = await patchTask(taskId, updates);
    if (!result.ok) {
      toast.error('Failed to update duration');
      return;
    }
    if (suggestedEffort) flashHighlight(setEffortHighlight);
    setTask((prev) => prev ? { ...prev, ...updates } : prev);
    onUpdate?.(updates);
  }, [ensureFieldsEditable, flashHighlight, onUpdate, setTask, taskId]);

  const applyDueDateChange = useCallback(async (
    dueDate: string,
    relativeReminderDueDateResolution?: 'remove' | 'convert_to_absolute',
  ) => {
    if (!ensureFieldsEditable('dueDate', ...(task?.reminderRelative ? ['reminderAt'] as const : []))) {
      return false;
    }
    const result = await patchTask(taskId, {
      dueDate: dueDate || null,
      ...(relativeReminderDueDateResolution ? { relativeReminderDueDateResolution } : {}),
    });
    if (!result.ok) {
      toast.error(typeof result.data.error === 'string' ? result.data.error : 'Failed to save due date');
      return false;
    }
    const reminder = result.data.reminder as Pick<
      TaskDetail,
      'reminderAt' | 'reminderRelative' | 'reminderDueTime'
    > | undefined;
    setTask((prev) => prev?.id === taskId
      ? { ...prev, dueDate: dueDate || null, ...(reminder ?? {}) }
      : prev);
    onUpdate?.({ dueDate: dueDate || null });
    notifyNavigationCountsChanged();
    return true;
  }, [ensureFieldsEditable, onUpdate, setTask, task?.reminderRelative, taskId]);

  const handleDueDateChange = useCallback(async (dueDate: string) => {
    if (!dueDate && task?.reminderRelative) {
      requestConfirm({
        title: 'Remove due date?',
        message: 'This reminder is relative to the due date. Keep its currently computed time as an absolute reminder, or remove the reminder with the due date.',
        confirmLabel: 'Keep reminder time',
        variant: 'warning',
        onConfirm: () => { void applyDueDateChange('', 'convert_to_absolute'); },
        alternateLabel: 'Remove reminder',
        onAlternate: () => { void applyDueDateChange('', 'remove'); },
      });
      return false;
    }
    return applyDueDateChange(dueDate);
  }, [applyDueDateChange, requestConfirm, task?.reminderRelative]);

  const handleSkipToCurrent = useCallback(async (skipToCurrentDate: string | null) => {
    if (!skipToCurrentDate || skipToCurrentInFlightRef.current) return;
    skipToCurrentInFlightRef.current = true;
    setSkippingToCurrent(true);
    try {
      if (await handleDueDateChange(skipToCurrentDate)) {
        toast.success(`Due date moved to ${formatShortDate(skipToCurrentDate)}`);
      }
    } finally {
      skipToCurrentInFlightRef.current = false;
      setSkippingToCurrent(false);
    }
  }, [handleDueDateChange]);

  const handleReminderChange = useCallback(async (updates: {
    reminderAt?: string | null;
    reminderRelative?: TaskDetail['reminderRelative'];
    reminderDueTime?: string | null;
  }) => {
    if (!ensureFieldsEditable('reminderAt') || reminderSaving) return false;
    setReminderSaving(true);
    try {
      const result = await patchTask(taskId, updates);
      if (!result.ok) {
        toast.error(typeof result.data.error === 'string'
          ? result.data.error
          : 'Failed to save reminder');
        return false;
      }
      const reminder = result.data.reminder as Pick<
        TaskDetail,
        'reminderAt' | 'reminderRelative' | 'reminderDueTime'
      > | undefined;
      if (reminder) {
        setTask((prev) => prev ? { ...prev, ...reminder } : prev);
        onUpdate?.(reminder);
      }
      return true;
    } finally {
      setReminderSaving(false);
    }
  }, [ensureFieldsEditable, onUpdate, reminderSaving, setTask, taskId]);

  const handleRecurrenceChange = useCallback(async (recurrence: string) => {
    const value = recurrence === 'none' ? null : recurrence;
    if (!(await saveField('recurrence', value))) return;
    setTask((prev) => prev ? {
      ...prev,
      recurrence: value,
      ...(value === null ? { recurrenceMode: 'schedule' as const } : {}),
    } : prev);
  }, [saveField, setTask]);

  const handleRecurrenceModeChange = useCallback(async (recurrenceMode: 'schedule' | 'completion') => {
    if (!ensureFieldsEditable('recurrence')) return;
    const result = await patchTask(taskId, { recurrenceMode });
    if (!result.ok) {
      toast.error('Failed to save recurrence timing');
      return;
    }
    setTask((prev) => prev ? { ...prev, recurrenceMode } : prev);
    onUpdate?.({ recurrenceMode });
  }, [ensureFieldsEditable, onUpdate, setTask, taskId]);

  const handleMicroStatusChange = useCallback(async (microStatus: string | null) => {
    if (!ensureFieldsEditable('microStatus')) return;
    const result = await patchTask(taskId, { microStatus });
    if (!result.ok) {
      toast.error('Failed to update micro-status');
      return;
    }
    setTask((prev) => prev ? { ...prev, microStatus } : prev);
    setShowMicroStatusPicker(false);
    setMicroStatusSuggestion(null);
    onUpdate?.({ microStatus });
  }, [ensureFieldsEditable, onUpdate, setTask, taskId]);

  const requestMicroStatusSuggestion = useCallback(async () => {
    try {
      const suggestion = await fetchMicroStatusSuggestion(taskId);
      if (suggestion) setMicroStatusSuggestion(suggestion);
    } catch { /* ignore */ }
  }, [taskId]);

  const dismissMicroStatusSuggestion = useCallback(() => setMicroStatusSuggestion(null), []);

  const toggleMicroStatusPicker = useCallback(() => {
    setShowMicroStatusPicker((open) => !open);
  }, []);

  const handleAddProject = useCallback(async (projectId: string) => {
    if (!task || !projectId || task.projectIds?.includes(projectId) || !ensureFieldsEditable('projects')) return;
    if (!(await addTaskToProject(projectId, task.id))) {
      toast.error('Failed to add project');
      return;
    }
    setTask((prev) => prev ? { ...prev, projectIds: [...(prev.projectIds || []), projectId] } : prev);
    onUpdate?.();
  }, [ensureFieldsEditable, onUpdate, setTask, task]);

  const handleRemoveProject = useCallback(async (projectId: string) => {
    if (!task || !ensureFieldsEditable('projects')) return;
    if (!(await removeTaskFromProject(projectId, task.id))) {
      toast.error('Failed to remove project');
      return;
    }
    setTask((prev) => prev ? { ...prev, projectIds: (prev.projectIds || []).filter((id) => id !== projectId) } : prev);
    setProjectHierarchies((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    onUpdate?.();
  }, [ensureFieldsEditable, onUpdate, setProjectHierarchies, setTask, task]);

  const handleProjectPhaseChange = useCallback(async (projectId: string, phaseId: string | null) => {
    if (!task || !ensureFieldsEditable('phases')) return;
    const hierarchy = projectHierarchies[projectId];
    if (!hierarchy) {
      toast.error('Project phases are unavailable');
      return;
    }
    if (taskPhaseInProject(hierarchy, task.id)?.id === phaseId) return;

    setUpdatingProjectPhaseIds((prev) => new Set(prev).add(projectId));
    try {
      const result = await executeProjectHierarchyCommand({
        projectId,
        expectedRevision: hierarchy.revision,
        command: {
          type: 'move_tasks',
          taskIds: [task.id],
          toPhaseId: phaseId,
          toIndex: phaseId ? (hierarchy.phaseItemsByPhase[phaseId]?.length ?? 0) : 0,
        },
      });
      setProjectHierarchies((prev) => ({ ...prev, [projectId]: result.hierarchy }));
      onUpdate?.();
    } catch (error) {
      if (error instanceof ProjectHierarchyClientError && error.current) {
        setProjectHierarchies((prev) => ({ ...prev, [projectId]: error.current! }));
      }
      toast.error(error instanceof Error ? error.message : 'Failed to update project phase');
    } finally {
      setUpdatingProjectPhaseIds((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
    }
  }, [ensureFieldsEditable, onUpdate, projectHierarchies, setProjectHierarchies, task]);

  return {
    // transient mutation state
    durationHighlight,
    effortHighlight,
    updatingDisposition,
    updatingMyDay,
    updatingProjectPhaseIds,
    skippingToCurrent,
    microStatusSuggestion,
    showMicroStatusPicker,
    showCloseReasonPicker,
    showTagPicker,
    pickerTags,
    pickerLoading,
    tagInput,
    setTagInput,
    resetTransientState,
    // workflows
    ensureFieldsEditable,
    saveField,
    openTagPicker,
    closeTagPicker,
    handleAddTag,
    handleRemoveTag,
    handleStatusChange,
    handleComplete,
    handleCloseWithReason,
    cancelCloseReason,
    handleCloseAsDuplicate,
    handleToggleMyDay,
    handleDelete,
    handlePriorityChange,
    handleLocalDispositionChange,
    handleEffortChange,
    handleDurationChange,
    handleDueDateChange,
    handleSkipToCurrent,
    handleReminderChange,
    reminderSaving,
    handleRecurrenceChange,
    handleRecurrenceModeChange,
    handleMicroStatusChange,
    requestMicroStatusSuggestion,
    dismissMicroStatusSuggestion,
    toggleMicroStatusPicker,
    handleAddProject,
    handleRemoveProject,
    handleProjectPhaseChange,
  };
}

export type UseTaskDetailMutationsResult = ReturnType<typeof useTaskDetailMutations>;
