'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Circle, ListChecks, Loader2, X } from 'lucide-react';
import { SubtaskSection } from './SubtaskSection';
import { TaskRelationshipsSection } from './TaskRelationshipsSection';
import { useImagePasteHandler } from './TaskAttachmentSection';
import { LinkedSourcesSection } from './LinkedSourcesSection';
import { TaskMoveDialog } from './TaskMoveDialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { TaskField } from '@/types';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  TASK_DISPOSITION_OPTIONS,
  taskFieldBlockedReason,
  taskFieldSaveLabel,
  taskRemovalLabel,
} from '@/lib/tasks/client-edit-policy';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { getDeepLinkInfo } from '@/lib/utils/deep-links';
import { getLocalToday } from '@/lib/utils/client-date';
import { getNextRecurringDate } from '@/lib/utils/recurrence';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { cn } from '@/lib/utils';
import { formatTaskDetailUpdatedAt } from '@/lib/utils/task-detail-date';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';
import { useResizablePanel } from '@/lib/hooks/useResizablePanel';
import { modalContent, modalOverlay, panelSlideFromRight } from '@/lib/motion';
import { TaskDetailHeader } from './TaskDetailHeader';
import { TaskPropertiesSection } from './TaskPropertiesSection';
import { TaskNotesSection } from './TaskNotesSection';
import { TaskNotesDialog } from './TaskNotesDialog';
import { TaskTagsSection } from './TaskTagsSection';
import { TaskProjectAssignmentSection } from './TaskProjectAssignmentSection';
import { TaskPlanningSection } from './TaskPlanningSection';
import { TaskDuplicatesSection } from './TaskDuplicatesSection';
import { TaskSourceActionsSection } from './TaskSourceActionsSection';
import { TaskDocumentPreviewSection } from './TaskDocumentPreviewSection';
import { TaskAttachmentCard } from './TaskAttachmentCard';
import { TaskDetailFooter, TaskMobileActionBar } from './TaskDetailFooter';
import { toggleMarkdownCheckbox } from './TaskDetailMarkdown';
import { useTaskDetailData } from './useTaskDetailData';
import { useTaskDetailMutations, type TaskConfirmRequest } from './useTaskDetailMutations';
import { parseTaskMetadata } from './task-detail-types';
import type {
  TaskConfirmDialogState,
  TaskDetailPanelProps,
} from './task-detail-types';

export type {
  HubProject,
  SourceList,
  Subtask,
  TagConnectorCaps,
  TaskDetail,
  TaskDetailMode,
  TaskDetailPanelProps,
  TaskFieldUpdate,
  TaskNotesOpenRequest,
  TaskSubtasksOpenRequest,
  TaskTag,
} from './task-detail-types';

const CONNECTOR_ICON_PATHS: Record<string, string> = {
  'local': LOCAL_CONNECTOR_ICON_PATH,
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
};

// Connectors that support recurrence
const RECURRENCE_CONNECTORS = ['microsoft-todo', 'outlook-calendar'];

const PANEL_WIDTH_STORAGE_KEY = 'mission-control:detail-panel-width';

export function TaskDetailPanel({
  taskId,
  onClose,
  onUpdate,
  onSubtaskCountChange,
  availableTags = [],
  mode = 'panel',
  onModeChange,
  isInMyDay,
  onToggleMyDay,
  sourceLists = [],
  onMoveToList,
  onComplete,
  onDelete,
  autoOpenMoveDialog = false,
  onMoveDialogDismissed,
  animatePanel = true,
  portalDialog = false,
  minPanelWidth = 280,
  focusPanelOnMount = false,
  notesOpenRequest = null,
  subtasksOpenRequest = null,
}: TaskDetailPanelProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [expandedNotesEditing, setExpandedNotesEditing] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [descValue, setDescValue] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<TaskConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    confirmLabel: '',
    variant: 'danger',
    onConfirm: () => {},
  });
  const [recurrenceFocused, setRecurrenceFocused] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const recurrenceSectionRef = useRef<HTMLElement>(null);
  const recurrenceHeadingRef = useRef<HTMLHeadingElement>(null);
  const subtasksSectionRef = useRef<HTMLElement>(null);
  const subtasksHeadingRef = useRef<HTMLHeadingElement>(null);
  const modalDialogRef = useRef<HTMLDivElement>(null);
  const notesDialogRef = useRef<HTMLElement>(null);
  const notesExpandButtonRef = useRef<HTMLButtonElement>(null);
  const expandedDescRef = useRef<HTMLTextAreaElement>(null);
  const handledNotesRequestRef = useRef<number | null>(null);
  const handledSubtasksRequestRef = useRef<number | null>(null);
  const recurrenceFocusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTransientStateRef = useRef<() => void>(() => {});

  const {
    task,
    setTask,
    loading,
    connectorCaps,
    supportsAttachments,
    supportsSubtasks,
    extraTags,
    setExtraTags,
    potentialDuplicates,
    setPotentialDuplicates,
    hubProjects,
    projectHierarchies,
    setProjectHierarchies,
    writableConnectors,
  } = useTaskDetailData({
    taskId,
    onTaskReset: () => {
      setEditingTitle(false);
      setEditingDesc(false);
      setNotesExpanded(false);
      setExpandedNotesEditing(false);
      resetTransientStateRef.current();
    },
    onTaskLoaded: (loaded) => {
      setTitleValue(loaded.title);
      setDescValue(loaded.description || '');
    },
  });

  const effectiveIsInMyDay = isInMyDay ?? task?.isInMyDay ?? false;

  const requestConfirm = useCallback((request: TaskConfirmRequest) => {
    setConfirmDialog({
      open: true,
      title: request.title,
      message: request.message,
      confirmLabel: request.confirmLabel,
      variant: request.variant,
      onConfirm: () => {
        setConfirmDialog((dialog) => ({ ...dialog, open: false }));
        request.onConfirm();
      },
    });
  }, []);

  const mutations = useTaskDetailMutations({
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
    isInMyDay: effectiveIsInMyDay,
    onClose,
    onComplete,
    onDelete,
    onToggleMyDay,
    requestConfirm,
  });
  const { resetTransientState, saveField } = mutations;
  useEffect(() => {
    resetTransientStateRef.current = resetTransientState;
  }, [resetTransientState]);

  const { width: panelWidth, handleResizeStart } = useResizablePanel({
    storageKey: PANEL_WIDTH_STORAGE_KEY,
    minWidth: minPanelWidth,
    elementRef: panelRef,
  });

  const canEdit = (field: TaskField) => canEditTaskField(task?.editPolicy, field);
  const blockedReason = (field: TaskField) => taskFieldBlockedReason(task?.editPolicy, field);
  const saveLabel = (field: TaskField) => (
    task ? taskFieldSaveLabel(task.editPolicy, field) : undefined
  );
  const canEditTitle = canEdit('title');
  const canEditDescription = canEdit('description');
  const canEditStatus = canEdit('status');
  const canEditPriority = canEdit('priority');
  const canEditDueDate = canEdit('dueDate');
  const canEditEffort = canEdit('effort');
  const canEditDuration = canEdit('estimatedDuration');
  const canEditEffortAndDuration = canEditEffort && canEditDuration;
  const effortDurationBlockedReason = !canEditEffort
    ? blockedReason('effort')
    : !canEditDuration
      ? blockedReason('estimatedDuration')
      : undefined;
  const canEditMicroStatus = canEdit('microStatus');
  const canEditTags = canEdit('tags');
  const canEditProjects = canEdit('projects');
  const canEditPhases = canEdit('phases');
  const canEditReminder = canEdit('reminderAt');
  const canEditRecurrence = canEdit('recurrence');
  const canEditDependencies = canEdit('dependencies');
  const canDeleteTask = canRemoveTask(task?.editPolicy);
  const dispositionOptions = task
    ? TASK_DISPOSITION_OPTIONS.filter((option) => (
        option.value !== task.localDisposition
        && canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, option.value)
      ))
    : [];
  const canManageSourceOperation = Boolean(
    task?.editPolicy.connectorEnabled
    || task?.editPolicy.sourceModel === 'mc-owned'
    || task?.editPolicy.sourceModel === 'ingested',
  );
  const canManageAttachments = supportsAttachments && canManageSourceOperation;
  const canManageSubtasks = supportsSubtasks && canEditDependencies;

  const closeExpandedNotes = useCallback(() => {
    setDescValue(task?.description || '');
    setEditingDesc(false);
    setExpandedNotesEditing(false);
    setNotesExpanded(false);
  }, [task?.description]);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => () => {
    if (recurrenceFocusTimeoutRef.current) clearTimeout(recurrenceFocusTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!focusPanelOnMount || mode !== 'panel') return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => previousFocus?.focus({ preventScroll: true });
  }, [focusPanelOnMount, mode]);

  useEffect(() => {
    if (!task || !notesOpenRequest) return;
    if (task.id !== notesOpenRequest.taskId) return;
    if (handledNotesRequestRef.current === notesOpenRequest.requestId) return;
    handledNotesRequestRef.current = notesOpenRequest.requestId;
    setDescValue(task.description || '');
    setExpandedNotesEditing(notesOpenRequest.mode === 'edit' && canEditDescription);
    setNotesExpanded(true);
  }, [canEditDescription, notesOpenRequest, task]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      if (
        document.activeElement instanceof HTMLElement
        && document.activeElement.closest('[data-task-relationship-editor]')
      ) return;
      if (document.querySelector('[data-testid="task-attachment-preview"]')) return;
      if (confirmDialog.open) return;
      if (notesExpanded) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeExpandedNotes();
        return;
      }
      if (showMoveDialog) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setShowMoveDialog(false);
        onMoveDialogDismissed?.();
        return;
      }
      if (
        editingDesc
        && e.target instanceof HTMLElement
        && e.target.closest('[data-markdown-editor]')
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDescValue(task?.description || '');
        setEditingDesc(false);
        return;
      }
      if (mode === 'panel' && panelRef.current?.offsetParent === null) return;
      onClose();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [
    closeExpandedNotes,
    confirmDialog.open,
    editingDesc,
    mode,
    notesExpanded,
    onClose,
    onMoveDialogDismissed,
    showMoveDialog,
    task?.description,
  ]);

  useEffect(() => {
    if (!notesExpanded) return;
    const dialog = notesDialogRef.current;
    const overlay = dialog?.parentElement;
    const backgroundElements = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay);
    const previousInert = backgroundElements.map((element) => element.inert);
    const returnFocus = notesExpandButtonRef.current;
    backgroundElements.forEach((element) => { element.inert = true; });
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const frame = requestAnimationFrame(() => {
      (dialog?.querySelector<HTMLElement>('[data-notes-autofocus]') ?? focusable()[0])?.focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', trapFocus);
      backgroundElements.forEach((element, index) => { element.inert = previousInert[index]; });
      returnFocus?.focus();
    };
  }, [notesExpanded]);

  useEffect(() => {
    if ((mode !== 'dialog' && mode !== 'workspace') || !task) return;
    const dialog = modalDialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = dialog.parentElement;
    const containingBodyChild = Array.from(document.body.children).find((element) => element.contains(dialog));
    const backgroundElements = [
      ...Array.from(document.body.children).filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element !== containingBodyChild,
      ),
      ...Array.from(overlay?.parentElement?.children ?? []).filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay,
      ),
    ];
    const uniqueBackgroundElements = [...new Set(backgroundElements)];
    const previousInert = uniqueBackgroundElements.map((element) => element.inert);
    uniqueBackgroundElements.forEach((element) => { element.inert = true; });
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ));
    const frame = requestAnimationFrame(() => (focusable()[0] ?? dialog).focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', trapFocus);
      uniqueBackgroundElements.forEach((element, index) => { element.inert = previousInert[index]; });
      previousFocus?.focus();
    };
  }, [mode, task?.id]);

  // Auto-open move dialog when requested via prop (e.g. from context menu "Move to another source…")
  useEffect(() => {
    if (autoOpenMoveDialog && writableConnectors.length > 0 && !showMoveDialog) {
      setShowMoveDialog(true);
    }
  }, [autoOpenMoveDialog, writableConnectors.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTitleCommit = async () => {
    if (titleValue.trim() && titleValue !== task?.title) {
      const saved = await saveField('title', titleValue.trim());
      if (!saved) return false;
      setTask((prev) => prev ? { ...prev, title: titleValue.trim() } : prev);
    }
    setEditingTitle(false);
    return true;
  };

  const handleDescBlur = async () => {
    if (descValue !== (task?.description || '')) {
      const saved = await saveField('description', descValue || null);
      if (!saved) return false;
      setTask((prev) => prev ? { ...prev, description: descValue || null } : prev);
    }
    setEditingDesc(false);
    return true;
  };

  const handleCheckboxToggle = useCallback(async (index: number, checked: boolean) => {
    if (!task?.description) return;
    const taskIdAtSave = task.id;
    const previousDesc = task.description;
    const newDesc = toggleMarkdownCheckbox(previousDesc, index, checked);
    const saved = await saveField('description', newDesc);
    if (!saved) {
      setTask((prev) => (
        prev?.id === taskIdAtSave ? { ...prev, description: previousDesc } : prev
      ));
      return;
    }
    setDescValue(newDesc);
    setTask((prev) => (
      prev?.id === taskIdAtSave ? { ...prev, description: newDesc } : prev
    ));
  }, [saveField, setTask, task?.description, task?.id]);

  const startDescriptionEdit = useCallback(() => {
    setEditingDesc(true);
    setTimeout(() => descRef.current?.focus(), 0);
  }, []);

  const parsedMetadata = parseTaskMetadata(task?.metadata);
  const currentRecurrence: string = task?.recurrence !== undefined
    ? task.recurrence ?? 'none'
    : parsedMetadata?.recurrence ?? 'none';
  const supportsRecurrence = task ? RECURRENCE_CONNECTORS.includes(task.connectorType) : false;

  // Pre-compute the next recurring date for the "Skip to current" action.
  // Only defined when the task is overdue and has a recurrence set.
  const taskDueDateOnly = task?.dueDate?.split('T')[0] ?? null;
  const todayForPanel = getLocalToday();
  const skipToCurrentDate =
    currentRecurrence !== 'none' && taskDueDateOnly && taskDueDateOnly < todayForPanel
      ? getNextRecurringDate(taskDueDateOnly, currentRecurrence, todayForPanel)
      : null;
  const isOverdue = Boolean(
    taskDueDateOnly
    && taskDueDateOnly < todayForPanel
    && task?.status !== 'done'
    && task?.status !== 'cancelled',
  );

  const taskTags = Array.from(new Map([...availableTags, ...extraTags].map((tag) => [tag.id, tag])).values())
    .filter((tag) => task?.tagIds?.includes(tag.id) && !isSyntheticTag(tag.name));
  const assignableProjects = hubProjects.filter((project) => !project.hidden);
  const iconSrc = task ? CONNECTOR_ICON_PATHS[task.connectorType] : null;
  const sameSourceLists = task?.connectorInstanceId
    ? sourceLists.filter((list) => list.connectorInstanceId === task.connectorInstanceId)
    : sourceLists;
  const supportsMoveToList = task
    ? task.editPolicy.sourceMoveSupported && sameSourceLists.length > 0 && !!onMoveToList
    : false;

  const handleSubtasksChange = useCallback((subtasks: { id: string; title: string; status: string }[]) => {
    setTask((prev) => prev ? { ...prev, subtasks } : prev);
    const done = subtasks.filter((subtask) => subtask.status === 'done').length;
    onSubtaskCountChange?.(done, subtasks.length);
  }, [onSubtaskCountChange, setTask]);

  const jumpToSubtasks = useCallback(() => {
    const panel = panelRef.current;
    const section = subtasksSectionRef.current;
    const heading = subtasksHeadingRef.current;
    if (!panel || !section || !heading) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const stickyHeaderHeight = panel.querySelector('header')?.offsetHeight ?? 0;
    panel.scrollTo({
      top: Math.max(0, section.offsetTop - stickyHeaderHeight),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    heading.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!task || !subtasksOpenRequest || mode !== 'panel') return;
    if (task.id !== subtasksOpenRequest.taskId) return;
    if (handledSubtasksRequestRef.current === subtasksOpenRequest.requestId) return;
    handledSubtasksRequestRef.current = subtasksOpenRequest.requestId;
    jumpToSubtasks();
  }, [jumpToSubtasks, mode, subtasksOpenRequest, task]);

  const jumpToRecurrence = useCallback(() => {
    const section = recurrenceSectionRef.current;
    const heading = recurrenceHeadingRef.current;
    if (!section || !heading) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const scrollHost = mode === 'panel' ? panelRef.current : contentScrollRef.current;
    if (scrollHost && mode !== 'mobile') {
      scrollHost.scrollTo({
        top: Math.max(0, section.offsetTop - 16),
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    } else {
      section.scrollIntoView({
        block: 'center',
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    }
    heading.focus({ preventScroll: true });
    setRecurrenceFocused(true);
    if (recurrenceFocusTimeoutRef.current) clearTimeout(recurrenceFocusTimeoutRef.current);
    recurrenceFocusTimeoutRef.current = setTimeout(() => setRecurrenceFocused(false), 1400);
  }, [mode]);

  const { handlePaste: handleImagePaste, pasteCount } = useImagePasteHandler(
    taskId,
    supportsAttachments,
  );

  // Content fade key — changes when loading a new task
  const contentKey = loading ? 'loading' : task?.id || 'empty';

  const moveDialog = (
    <AnimatePresence>
      {showMoveDialog && task ? (
        <TaskMoveDialog
          taskId={task.id}
          taskTitle={task.title}
          sourceConnectorType={task.connectorType}
          writableConnectors={writableConnectors}
          onClose={() => { setShowMoveDialog(false); onMoveDialogDismissed?.(); }}
          onSuccess={(_newTaskId, action) => {
            toast.success(action === 'move' ? 'Task moved successfully' : 'Task copied successfully');
            onClose();
            onUpdate?.();
          }}
        />
      ) : null}
    </AnimatePresence>
  );

  const confirmDialogElement = (
    <ConfirmDialog
      open={confirmDialog.open}
      title={confirmDialog.title}
      message={confirmDialog.message}
      confirmLabel={confirmDialog.confirmLabel}
      confirmVariant={confirmDialog.variant}
      onConfirm={confirmDialog.onConfirm}
      onCancel={() => setConfirmDialog((dialog) => ({ ...dialog, open: false }))}
    />
  );

  const panelContent = (
    <motion.div
      ref={contentScrollRef}
      data-task-detail-scroll
      key={contentKey}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={mode === 'dialog' || mode === 'workspace' ? 'overflow-y-auto flex-1 min-h-0' : ''}
    >
    {loading ? (
      <div className="relative flex h-32 items-center justify-center">
        <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
        {mode === 'mobile' && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
            aria-label="Close task detail"
          >
            <X size={18} />
          </button>
        )}
      </div>
    ) : !task ? (
      <div className="flex items-center justify-between gap-3 p-4 text-sm text-[var(--text-muted)]">
        <span>Task not found</span>
        {mode === 'mobile' && (
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-[var(--surface-2)]"
            aria-label="Close task detail"
          >
            <X size={18} />
          </button>
        )}
      </div>
    ) : (
      <div className={cn(
        'mx-auto w-full',
        mode === 'panel' && 'flex flex-col gap-4 p-5',
        mode === 'mobile' && 'flex flex-col gap-3 px-4 pb-28 [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11',
        mode === 'dialog' && 'grid max-w-4xl grid-cols-2 items-start gap-4 p-6',
        mode === 'workspace' && 'grid max-w-[1320px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(380px,1.35fr)] items-start gap-5 p-7',
      )}>
        <TaskDetailHeader
          mode={mode}
          iconSrc={iconSrc ?? null}
          connectorType={task.connectorType}
          sourceListName={task.sourceListName}
          title={task.title}
          titleValue={titleValue}
          editingTitle={editingTitle}
          canEditTitle={canEditTitle}
          titleBlockedReason={blockedReason('title')}
          titleRef={titleRef}
          onTitleValueChange={setTitleValue}
          onTitleCommit={() => { void handleTitleCommit(); }}
          onTitleCancel={() => { setTitleValue(task.title); setEditingTitle(false); }}
          onTitleEditStart={() => { setEditingTitle(true); setTimeout(() => titleRef.current?.focus(), 0); }}
          contextLabel={
            hubProjects.find((project) => task.projectIds?.includes(project.id))?.name
            || task.sourceListName
            || 'No list'
          }
          displayId={getTaskDisplayId(task.connectorType, task.metadata, task.sourceId)}
          updatedAtLabel={formatTaskDetailUpdatedAt(task.updatedAt)}
          onClose={onClose}
          onModeChange={onModeChange}
        />

        {mode === 'panel' && task.subtasks && task.subtasks.length > 0 && (() => {
          const completedSubtasks = task.subtasks.filter((subtask) => subtask.status === 'done').length;
          return (
            <button
              type="button"
              onClick={jumpToSubtasks}
              aria-label={`Jump to subtasks, ${completedSubtasks} of ${task.subtasks.length} complete`}
              className="order-0 -mt-1 flex w-fit items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-0)]/55 px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]"
            >
              <ListChecks size={12} aria-hidden="true" />
              Subtasks {completedSubtasks}/{task.subtasks.length}
            </button>
          );
        })()}

        {/* Mark Complete Button */}
        {mode !== 'mobile' && task.status !== 'done' && task.status !== 'cancelled' && (
          <button
            onClick={mutations.handleComplete}
            disabled={!canEditStatus}
            title={!canEditStatus ? blockedReason('status') : saveLabel('status')}
            className={cn(
              'flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg border border-[var(--success)]/20 bg-[var(--success)]/10 px-3 py-2 text-xs font-medium text-[var(--success)] transition-colors duration-150 hover:bg-[var(--success)]/20',
              mode === 'panel' && 'order-0',
              mode === 'dialog' && 'col-start-1 row-start-2',
              mode === 'workspace' && 'col-start-1 row-start-2',
            )}
          >
            <Circle size={14} className="text-[var(--success)]" />
            Mark Complete
          </button>
        )}

        <TaskPropertiesSection
          mode={mode}
          status={{
            status: task.status,
            statusReason: task.statusReason,
            microStatus: task.microStatus,
            connectorType: task.connectorType,
            canEditStatus,
            canEditMicroStatus,
            statusBlockedReason: blockedReason('status'),
            statusSaveLabel: saveLabel('status'),
            microStatusBlockedReason: blockedReason('microStatus'),
            microStatusSaveLabel: saveLabel('microStatus'),
            onStatusChange: (status) => { void mutations.handleStatusChange(status); },
            onComplete: mutations.handleComplete,
            showMicroStatusPicker: mutations.showMicroStatusPicker,
            onToggleMicroStatusPicker: mutations.toggleMicroStatusPicker,
            onMicroStatusChange: (microStatus) => { void mutations.handleMicroStatusChange(microStatus); },
            microStatusSuggestion: mutations.microStatusSuggestion,
            onRequestMicroStatusSuggestion: () => { void mutations.requestMicroStatusSuggestion(); },
            onDismissMicroStatusSuggestion: mutations.dismissMicroStatusSuggestion,
            showCloseReasonPicker: mutations.showCloseReasonPicker,
            onCloseWithReason: (reason) => { void mutations.handleCloseWithReason(reason); },
            onCancelCloseReason: mutations.cancelCloseReason,
          }}
          priority={{
            priority: task.priority,
            canEditPriority,
            priorityBlockedReason: blockedReason('priority'),
            prioritySaveLabel: saveLabel('priority'),
            onPriorityChange: (priority) => { void mutations.handlePriorityChange(priority); },
          }}
          dueDate={{
            dueDate: taskDueDateOnly,
            isOverdue,
            hasRecurrence: currentRecurrence !== 'none',
            canEditDueDate,
            dueDateBlockedReason: blockedReason('dueDate'),
            dueDateSaveLabel: saveLabel('dueDate'),
            onDueDateChange: (date) => { void mutations.handleDueDateChange(date); },
            onJumpToRecurrence: jumpToRecurrence,
            isInMyDay: effectiveIsInMyDay,
            updatingMyDay: mutations.updatingMyDay,
            onToggleMyDay: () => { void mutations.handleToggleMyDay(); },
          }}
          effort={{
            effort: task.effort,
            estimatedDuration: task.estimatedDuration,
            canEditEffortAndDuration,
            effortDurationBlockedReason,
            durationSaveLabel: saveLabel('estimatedDuration'),
            effortHighlight: mutations.effortHighlight,
            durationHighlight: mutations.durationHighlight,
            onEffortChange: (effort) => { void mutations.handleEffortChange(effort); },
            onDurationChange: (minutes) => { void mutations.handleDurationChange(minutes); },
          }}
        />

        <TaskNotesSection
          mode={mode}
          description={task.description}
          descValue={descValue}
          editingDesc={editingDesc}
          canEditDescription={canEditDescription}
          descriptionBlockedReason={blockedReason('description')}
          supportsAttachments={supportsAttachments}
          sourceUrl={task.sourceUrl}
          descRef={descRef}
          expandButtonRef={notesExpandButtonRef}
          onDescValueChange={setDescValue}
          onEditStart={startDescriptionEdit}
          onEditCancel={() => {
            setDescValue(task.description || '');
            setEditingDesc(false);
          }}
          onEditorBlur={handleDescBlur}
          onExpand={() => {
            setExpandedNotesEditing(editingDesc);
            setNotesExpanded(true);
          }}
          onPaste={handleImagePaste}
          onCheckboxToggle={canEditDescription ? handleCheckboxToggle : undefined}
        />

        <TaskTagsSection
          mode={mode}
          tags={taskTags}
          appliedTagIds={task.tagIds ?? []}
          canEditTags={canEditTags}
          tagsBlockedReason={blockedReason('tags')}
          showPicker={mutations.showTagPicker}
          pickerTags={mutations.pickerTags}
          pickerLoading={mutations.pickerLoading}
          tagInput={mutations.tagInput}
          connectorCaps={connectorCaps}
          onOpenPicker={() => { void mutations.openTagPicker(); }}
          onClosePicker={mutations.closeTagPicker}
          onTagInputChange={mutations.setTagInput}
          onAddTag={(tagName) => { void mutations.handleAddTag(tagName); }}
          onRemoveTag={(tagId) => { void mutations.handleRemoveTag(tagId); }}
        />

        <TaskProjectAssignmentSection
          mode={mode}
          taskId={task.id}
          projectIds={task.projectIds ?? []}
          hubProjects={hubProjects}
          assignableProjects={assignableProjects}
          projectHierarchies={projectHierarchies}
          updatingProjectPhaseIds={mutations.updatingProjectPhaseIds}
          canEditProjects={canEditProjects}
          canEditPhases={canEditPhases}
          projectsBlockedReason={blockedReason('projects')}
          projectsSaveLabel={saveLabel('projects')}
          onAddProject={(projectId) => { void mutations.handleAddProject(projectId); }}
          onRemoveProject={(projectId) => { void mutations.handleRemoveProject(projectId); }}
          onProjectPhaseChange={(projectId, phaseId) => { void mutations.handleProjectPhaseChange(projectId, phaseId); }}
        />

        <TaskPlanningSection
          mode={mode}
          sectionRef={recurrenceSectionRef}
          headingRef={recurrenceHeadingRef}
          highlighted={recurrenceFocused}
          reminderAt={task.reminderAt ?? null}
          canEditReminder={canEditReminder}
          reminderBlockedReason={blockedReason('reminderAt')}
          reminderSaveLabel={saveLabel('reminderAt')}
          onReminderChange={mutations.handleReminderChange}
          supportsRecurrence={supportsRecurrence}
          currentRecurrence={currentRecurrence}
          canEditRecurrence={canEditRecurrence}
          recurrenceBlockedReason={blockedReason('recurrence')}
          recurrenceSaveLabel={saveLabel('recurrence')}
          onRecurrenceChange={(recurrence) => { void mutations.handleRecurrenceChange(recurrence); }}
          skipToCurrentDate={skipToCurrentDate}
          skippingToCurrent={mutations.skippingToCurrent}
          canEditDueDate={canEditDueDate}
          dueDateBlockedReason={blockedReason('dueDate')}
          onSkipToCurrent={() => { void mutations.handleSkipToCurrent(skipToCurrentDate); }}
        />

        <section ref={mode === 'panel' ? subtasksSectionRef : undefined} className={cn(
          'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3',
          (mode === 'panel' || mode === 'mobile') && 'order-5',
          mode === 'dialog' && 'col-start-1 row-start-5',
          mode === 'workspace' && 'col-start-1 row-start-5',
        )}>
          <div className="flex items-center gap-2 mb-2">
            <ListChecks size={13} className="text-[var(--text-muted)]" />
            <h3
              ref={mode === 'panel' ? subtasksHeadingRef : undefined}
              tabIndex={mode === 'panel' ? -1 : undefined}
              className={cn(
                'text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide',
                mode === 'panel' && 'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]',
              )}
            >
              Subtasks
              {task.subtasks && task.subtasks.length > 0 && ` (${task.subtasks.filter((subtask) => subtask.status === 'done').length}/${task.subtasks.length})`}
            </h3>
          </div>
          <SubtaskSection
            key={task.id}
            taskId={task.id}
            subtasks={task.subtasks || []}
            onSubtasksChange={handleSubtasksChange}
            onUpdate={onUpdate}
            canEdit={canManageSubtasks}
            canCreateSubtasks={canManageSubtasks}
          />
        </section>

        {/* Relationships and cross-connector provenance */}
        <div className={cn(
          (mode === 'panel' || mode === 'mobile') && 'order-6',
          mode === 'dialog' && 'col-start-1 row-start-6',
          mode === 'workspace' && 'col-start-1 row-start-6',
        )} data-task-relationships-slot>
          <TaskRelationshipsSection
            key={`relationships-${task.id}`}
            taskId={task.id}
            canEdit={canEditDependencies}
            onUpdate={() => onUpdate?.()}
            touch={mode === 'mobile'}
          />
          <LinkedSourcesSection taskId={taskId} />
        </div>

        {task.status !== 'done' && task.status !== 'cancelled' && (
          <TaskDuplicatesSection
            mode={mode}
            duplicates={potentialDuplicates}
            canEditStatus={canEditStatus}
            onCloseAsDuplicate={() => { void mutations.handleCloseAsDuplicate(); }}
            onDismiss={() => setPotentialDuplicates([])}
          />
        )}

        <TaskSourceActionsSection
          mode={mode}
          dispositionOptions={dispositionOptions}
          updatingDisposition={mutations.updatingDisposition}
          onDispositionChange={(disposition) => { void mutations.handleLocalDispositionChange(disposition); }}
          sameSourceLists={sameSourceLists}
          currentSourceListId={task.sourceListId}
          onMoveToList={onMoveToList}
          supportsMoveToList={supportsMoveToList}
          hasWritableConnectors={writableConnectors.length > 0}
          onOpenMoveDialog={() => setShowMoveDialog(true)}
          deepLink={task.sourceId ? getDeepLinkInfo(task.connectorType, task.sourceId) : null}
          canDeleteTask={canDeleteTask}
          deleteLabel={taskRemovalLabel(task.editPolicy)}
          onDelete={mutations.handleDelete}
        />

        <TaskDocumentPreviewSection
          mode={mode}
          connectorType={task.connectorType}
          metadata={parsedMetadata}
        />

        <TaskAttachmentCard
          mode={mode}
          taskId={taskId}
          canEdit={canManageAttachments}
          supportsAttachments={supportsAttachments}
          connectorType={task.connectorType}
          sourceUrl={task.sourceUrl}
          refreshKey={pasteCount}
        />

        <TaskDetailFooter mode={mode} createdAt={task.createdAt} updatedAt={task.updatedAt} />

        {mode === 'mobile' && (
          <TaskMobileActionBar
            isClosed={task.status === 'done' || task.status === 'cancelled'}
            canEditStatus={canEditStatus}
            statusBlockedReason={blockedReason('status')}
            statusSaveLabel={saveLabel('status')}
            onComplete={mutations.handleComplete}
            isInMyDay={effectiveIsInMyDay}
            updatingMyDay={mutations.updatingMyDay}
            onToggleMyDay={() => { void mutations.handleToggleMyDay(); }}
            canDeleteTask={canDeleteTask}
            deleteLabel={taskRemovalLabel(task.editPolicy)}
            onDelete={mutations.handleDelete}
          />
        )}

        {portalRoot && createPortal(
          <AnimatePresence>
            {notesExpanded && (
              <TaskNotesDialog
                taskTitle={task.title}
                description={task.description}
                descValue={descValue}
                editing={expandedNotesEditing}
                canEditDescription={canEditDescription}
                sourceUrl={task.sourceUrl}
                dialogRef={notesDialogRef}
                editorRef={expandedDescRef}
                onDescValueChange={setDescValue}
                onEditingChange={setExpandedNotesEditing}
                onCancelEdit={() => { setDescValue(task.description || ''); setExpandedNotesEditing(false); }}
                onSave={handleDescBlur}
                onClose={closeExpandedNotes}
                onPaste={handleImagePaste}
                onCheckboxToggle={canEditDescription ? handleCheckboxToggle : undefined}
              />
            )}
          </AnimatePresence>,
          portalRoot,
        )}
      </div>
    )}
    </motion.div>
  );

  if (mode === 'mobile') {
    return (
      <>
        <div className="bg-[var(--surface-1)]">{panelContent}</div>
        {confirmDialogElement}
        {moveDialog}
      </>
    );
  }

  // Dialog and workspace modes render as modal overlays.
  if (mode === 'dialog' || mode === 'workspace') {
    const isWorkspace = mode === 'workspace';
    const dialog = (
      <>
      <AnimatePresence>
        <div className={cn('fixed inset-0 z-[90] flex justify-center', isWorkspace ? 'items-stretch p-4' : 'items-start pt-[6vh]')} role="presentation">
          <motion.div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            variants={modalOverlay}
            initial="hidden"
            animate="show"
            exit="exit"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={modalDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={isWorkspace ? `Task workspace: ${task?.title ?? 'Task'}` : `Task details: ${task?.title ?? 'Task'}`}
            tabIndex={-1}
            className={cn(
              'relative flex flex-col overflow-hidden border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl',
              isWorkspace
                ? 'h-full w-full max-w-[1320px] rounded-2xl'
                : 'max-h-[88vh] w-[min(920px,94vw)] rounded-2xl',
            )}
            variants={modalContent}
            initial="hidden"
            animate="show"
            exit="exit"
          >
            {panelContent}
          </motion.div>
        </div>
      </AnimatePresence>
      {confirmDialogElement}
      {portalDialog && portalRoot ? createPortal(moveDialog, portalRoot) : moveDialog}
      </>
    );

    if (!portalDialog) return dialog;
    return portalRoot ? createPortal(dialog, portalRoot) : null;
  }

  // Panel mode: render as side panel with resize handle
  return (
    <>
    <motion.aside
      ref={panelRef}
      tabIndex={focusPanelOnMount ? -1 : undefined}
      className="bg-[var(--surface-1)] border-l border-[var(--border)] shadow-[-12px_0_30px_-24px_rgba(0,0,0,0.45)] flex-shrink-0 overflow-y-auto relative"
      style={{ width: panelWidth, maxWidth: 'min(calc(100vw - 4rem), 100%)' }}
      variants={animatePanel ? panelSlideFromRight : undefined}
      initial={animatePanel ? 'hidden' : false}
      animate={animatePanel ? 'show' : undefined}
      exit={animatePanel ? 'exit' : undefined}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)]/30 active:bg-[var(--accent)]/50 transition-colors z-10"
        onMouseDown={handleResizeStart}
      />
      {panelContent}
    </motion.aside>
    {confirmDialogElement}
    {portalDialog && portalRoot ? createPortal(moveDialog, portalRoot) : moveDialog}
    </>
  );
}
