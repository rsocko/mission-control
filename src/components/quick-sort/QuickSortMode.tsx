'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Keyboard,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Zap,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import ModeSelector from './ModeSelector';
import OrderSelector from './OrderSelector';
import ScopeFilter from './ScopeFilter';
import QuickSortCard from './QuickSortCard';
import QuickSortActions, { type TagOption } from './QuickSortActions';
import ActivityBanner from './ActivityBanner';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import { TaskDetailPanel, type TaskFieldUpdate } from '@/components/task-detail/TaskDetailPanel';
import { MobileSheet } from '@/components/ui/MobileSheet';
import { useQuickSortData } from '@/lib/hooks/useQuickSortData';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import type {
  QuickSortOrder,
  QuickSortQueueMode,
  QuickSortQueueTask,
  QuickSortScopeFilter,
} from '@/lib/hooks/useQuickSortData';
import {
  canEditTaskField,
  canSetTaskLocalDisposition,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import type { LocalDisposition, TaskField } from '@/types';

const MODE_LABELS: Record<QuickSortQueueMode, string> = {
  no_priority: 'Set Priority',
  no_effort: 'Estimate Effort',
  no_tags: 'Add Tags',
  no_due_date: 'Plan / Schedule',
};

const EFFORT_LABELS: Record<number, string> = { 1: 'XS', 2: 'S', 3: 'M', 4: 'L', 5: 'XL' };
const SKIP_SNOOZE_MS = 30 * 60 * 1000;
const QUEUE_REVALIDATE_MS = 60 * 1000;

interface QuickSortHistoryEntry {
  operationId: string;
  task: QuickSortQueueTask;
  queueIndex: number;
  label: string;
  contextKey: string;
  counted: boolean;
  aiAccepted: boolean;
}

async function applyQuickSortOperation(input: {
  operationId: string;
  taskId: string;
  mode: QuickSortQueueMode;
  action: 'applied' | 'suggestion_accepted' | 'skipped';
  label: string;
  contextKey: string;
  queueIndex: number;
  patch: Record<string, unknown>;
  logModes?: QuickSortQueueMode[];
  aiAccepted?: boolean;
}) {
  const res = await fetch('/api/tasks/quick-sort/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? 'Failed to update task');
  }
  return res.json();
}

export default function QuickSortMode() {
  const [mode, setMode] = useState<QuickSortQueueMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [allTags, setAllTags] = useState<TagOption[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<QuickSortScopeFilter>({});
  const [order, setOrder] = useState<QuickSortOrder>('smart');
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  // Bump to force ActivityBanner to re-fetch after quick sort actions
  const [statsKey, setStatsKey] = useState(0);
  // Track items sorted in this session (F-52 progress indicator, F-57 session stats)
  const [sessionSorted, setSessionSorted] = useState(0);
  const [sessionStartTime] = useState(() => Date.now());
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [aiAccepted, setAiAccepted] = useState(0);
  const [history, setHistory] = useState<QuickSortHistoryEntry[]>([]);
  const [undoStatus, setUndoStatus] = useState('');
  const useCompactTaskDetails = useIsMobile(1279);
  const isSingleColumnLayout = useIsMobile(1023);
  const globalChordPendingRef = useRef(false);
  const globalChordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTaskIdsRef = useRef(new Set<string>());
  const undoInFlightRef = useRef(false);

  const {
    tasks,
    loading,
    counts,
    suggestions,
    recentTagIds,
    dismiss,
    restoreTask,
    updateTask,
    refreshQueue,
    reloadQueue,
    refreshCounts,
    recordRecentTag,
  } =
    useQuickSortData(mode, scopeFilter, order);
  const historyContextKey = JSON.stringify({ mode, scopeFilter, order });
  const historyTail = history.at(-1);
  const lastOperation = historyTail?.contextKey === historyContextKey ? historyTail : undefined;

  useEffect(() => {
    setHistory([]);
    setUndoStatus('');
  }, [historyContextKey]);

  const runOperation = useCallback(async ({
    task,
    patch,
    operationMode,
    action,
    label,
    logModes,
    acceptedAI = false,
  }: {
    task: QuickSortQueueTask;
    patch: Record<string, unknown>;
    operationMode: QuickSortQueueMode;
    action: 'applied' | 'suggestion_accepted' | 'skipped';
    label: string;
    logModes?: QuickSortQueueMode[];
    acceptedAI?: boolean;
  }) => {
    if (pendingTaskIdsRef.current.has(task.id)) {
      throw new Error('This Quick Sort action is already in progress');
    }
    const queueIndex = tasks.findIndex((candidate) => candidate.id === task.id);
    if (queueIndex < 0) throw new Error('Task is no longer in this queue');
    const operationId = crypto.randomUUID();
    pendingTaskIdsRef.current.add(task.id);
    try {
      await applyQuickSortOperation({
        operationId,
        taskId: task.id,
        mode: operationMode,
        action,
        label,
        contextKey: historyContextKey,
        queueIndex,
        patch,
        logModes,
        aiAccepted: acceptedAI,
      });
    } finally {
      pendingTaskIdsRef.current.delete(task.id);
    }
    setHistory((current) => [...current, {
      operationId,
      task,
      queueIndex,
      label,
      contextKey: historyContextKey,
      counted: action !== 'skipped',
      aiAccepted: acceptedAI,
    }].slice(-20));
    setUndoStatus(`${label} applied. Undo is available.`);
  }, [historyContextKey, tasks]);

  const handleUndo = useCallback(async () => {
    const operation = lastOperation;
    if (!operation || busy || undoInFlightRef.current) return;
    undoInFlightRef.current = true;
    setBusy(true);
    setUndoStatus(`Undoing ${operation.label}.`);
    try {
      const response = await fetch(
        `/api/tasks/quick-sort/operations/${operation.operationId}/undo`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? `Failed to undo ${operation.label}`);
      }
      restoreTask(operation.task, operation.queueIndex);
      setHistory((current) => current.filter(
        (entry) => entry.operationId !== operation.operationId,
      ));
      if (operation.counted) setSessionSorted((count) => Math.max(0, count - 1));
      if (operation.aiAccepted) setAiAccepted((count) => Math.max(0, count - 1));
      refreshCounts();
      setStatsKey((key) => key + 1);
      setUndoStatus(`${operation.label} undone. Task restored.`);
      toast.success(`${operation.label} undone`);
      requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>(
          `[data-quick-sort-card-task-id="${CSS.escape(operation.task.id)}"]`,
        );
        card?.focus();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to undo ${operation.label}`;
      setUndoStatus(message);
      toast.error(message);
    } finally {
      undoInFlightRef.current = false;
      setBusy(false);
    }
  }, [busy, lastOperation, refreshCounts, restoreTask]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (mode && tasks.length === 0) {
        void reloadQueue().catch(() => toast.error('Failed to refresh Quick Sort'));
      }
      refreshCounts();
    }, QUEUE_REVALIDATE_MS);
    return () => clearInterval(interval);
  }, [mode, refreshCounts, reloadQueue, tasks.length]);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedMinutes(Math.round((Date.now() - sessionStartTime) / 60000));
    }, 30 * 1000);
    return () => clearInterval(interval);
  }, [sessionStartTime]);

  const handleModeSelect = useCallback((nextMode: QuickSortQueueMode) => {
    if (busy) return;
    setOrder(nextMode === 'no_due_date' ? 'priority' : 'smart');
    setMode(nextMode);
    setSelectedTaskId(null);
  }, [busy]);

  // Fetch tags once when entering no_tags mode
  useEffect(() => {
    if (mode === 'no_tags' && allTags.length === 0) {
      setTagsLoading(true);
      fetch('/api/tags')
        .then((r) => r.json())
        .then((data) => setAllTags(data.tags ?? []))
        .catch(() => {})
        .finally(() => setTagsLoading(false));
    }
  }, [mode, allTags.length]);

  // The top 3 visible tasks (for stack display)
  const stackTasks = tasks.slice(0, 3);
  const topTask = stackTasks[0] ?? null;
  const remaining = tasks.length;
  const topSuggestion = topTask ? suggestions[topTask.id] : undefined;
  // Track initial total for progress (F-52) — reset when mode changes
  const [initialTotal, setInitialTotal] = useState(0);
  useEffect(() => {
    // Reset progress tracking when entering a new mode
    setInitialTotal(0);
    setSessionSorted(0);
    setAiAccepted(0);
  }, [mode]);
  useEffect(() => {
    if (tasks.length > 0 && initialTotal === 0) {
      setInitialTotal(tasks.length);
    }
  }, [tasks.length, initialTotal]);

  const handleSkip = useCallback(
    async (taskId: string) => {
      if (busy || !mode) return;
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!canEditTaskField(task?.editPolicy, 'snoozedUntil')) {
        toast.error(taskFieldBlockedReason(task?.editPolicy, 'snoozedUntil'));
        return;
      }
      setBusy(true);
      try {
        const snoozedUntil = new Date(Date.now() + SKIP_SNOOZE_MS).toISOString();
        await runOperation({
          task: task!,
          patch: { snoozedUntil },
          operationMode: mode,
          action: 'skipped',
          label: 'Skip',
        });
        dismiss(taskId);
        refreshCounts();
        setStatsKey((k) => k + 1);
        toast.info('Skipped for 30 minutes');
      } catch {
        toast.error('Failed to skip task');
      }
      setBusy(false);
    },
    [busy, dismiss, mode, refreshCounts, runOperation, tasks]
  );

  const handleSetLocalDisposition = useCallback(
    async (localDisposition: LocalDisposition) => {
      if (!topTask || !mode || busy) return;
      if (!canSetTaskLocalDisposition(
        topTask.editPolicy,
        topTask.localDisposition,
        localDisposition,
      )) {
        toast.error(taskDispositionBlockedReason(
          topTask.editPolicy,
          topTask.localDisposition,
          localDisposition,
        ));
        return;
      }
      setBusy(true);
      try {
        await runOperation({
          task: topTask,
          patch: { localDisposition },
          operationMode: mode,
          action: 'applied',
          label: localDisposition === 'handled' ? 'Mark handled' : 'Dismiss',
        });
        dismiss(topTask.id);
        refreshCounts();
        setSessionSorted((count) => count + 1);
        toast.success(localDisposition === 'handled'
          ? 'Marked handled in Mission Control'
          : 'Dismissed in Mission Control');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to update Mission Control state');
      } finally {
        setBusy(false);
      }
    },
    [busy, dismiss, mode, refreshCounts, runOperation, topTask],
  );

  const handleApplyPriority = useCallback(
    async (priority: string) => {
      if (!topTask || busy) return;
      if (!canEditTaskField(topTask.editPolicy, 'priority')) {
        toast.error(taskFieldBlockedReason(topTask.editPolicy, 'priority'));
        return;
      }
      setBusy(true);
      try {
        await runOperation({
          task: topTask,
          patch: { priority },
          operationMode: 'no_priority',
          action: 'applied',
          label: 'Set priority',
        });
        dismiss(topTask.id);
        refreshCounts();
        setStatsKey((k) => k + 1);
        setSessionSorted((n) => n + 1);
        toast.success(`Priority set to ${priority}`);
      } catch {
        toast.error('Failed to update priority');
      }
      setBusy(false);
    },
    [topTask, busy, dismiss, refreshCounts, runOperation]
  );

  const handleApplyEffort = useCallback(
    async (effort: number) => {
      if (!topTask || busy) return;
      if (!canEditTaskField(topTask.editPolicy, 'effort')) {
        toast.error(taskFieldBlockedReason(topTask.editPolicy, 'effort'));
        return;
      }
      setBusy(true);
      try {
        await runOperation({
          task: topTask,
          patch: { effort },
          operationMode: 'no_effort',
          action: 'applied',
          label: 'Set effort',
        });
        dismiss(topTask.id);
        refreshCounts();
        setStatsKey((k) => k + 1);
        setSessionSorted((n) => n + 1);
        toast.success(`Effort set to ${EFFORT_LABELS[effort] ?? effort}`);
      } catch {
        toast.error('Failed to update effort');
      }
      setBusy(false);
    },
    [topTask, busy, dismiss, refreshCounts, runOperation]
  );

  const handleApplyTag = useCallback(
    async (tagId: string, tagName: string) => {
      if (!topTask || busy) return;
      if (!canEditTaskField(topTask.editPolicy, 'tags')) {
        toast.error(taskFieldBlockedReason(topTask.editPolicy, 'tags'));
        return;
      }
      setBusy(true);
      try {
        const existingTagIds = topTask.tags.map((t) => t.id);
        await runOperation({
          task: topTask,
          patch: { tags: [...existingTagIds, tagId] },
          operationMode: 'no_tags',
          action: 'applied',
          label: 'Add tag',
        });
        recordRecentTag(tagId);
        dismiss(topTask.id);
        refreshCounts();
        setStatsKey((k) => k + 1);
        setSessionSorted((n) => n + 1);
        toast.success(`Tagged as "${tagName}"`);
      } catch {
        toast.error('Failed to add tag');
      }
      setBusy(false);
    },
    [topTask, busy, dismiss, refreshCounts, recordRecentTag, runOperation]
  );

  const handleApplyDueDate = useCallback(
    async (dueDate: string) => {
      if (!topTask || busy) return;
      if (!canEditTaskField(topTask.editPolicy, 'dueDate')) {
        toast.error(taskFieldBlockedReason(topTask.editPolicy, 'dueDate'));
        return;
      }
      setBusy(true);
      try {
        await runOperation({
          task: topTask,
          patch: { dueDate },
          operationMode: 'no_due_date',
          action: 'applied',
          label: 'Set due date',
        });
        dismiss(topTask.id);
        refreshCounts();
        setStatsKey((k) => k + 1);
        setSessionSorted((n) => n + 1);
        toast.success(`Due date set to ${dueDate}`);
      } catch {
        toast.error('Failed to set due date');
      }
      setBusy(false);
    },
    [topTask, busy, dismiss, refreshCounts, runOperation]
  );

  const handleMarkDone = useCallback(
    async () => {
      if (!topTask || !mode || busy) return;
      if (!canEditTaskField(topTask.editPolicy, 'status')) {
        toast.error(taskFieldBlockedReason(topTask.editPolicy, 'status'));
        return;
      }
      setBusy(true);
      try {
        await runOperation({
          task: topTask,
          patch: { status: 'done' },
          operationMode: mode,
          action: 'applied',
          label: 'Complete task',
        });
        dismiss(topTask.id);
        refreshCounts();
        setStatsKey((k) => k + 1);
        setSessionSorted((n) => n + 1);
        toast.success('Task marked done');
      } catch {
        toast.error('Failed to mark task done');
      }
      setBusy(false);
    },
    [topTask, busy, dismiss, mode, refreshCounts, runOperation]
  );

  const handleTaskDetailUpdate = useCallback((fields?: TaskFieldUpdate) => {
    refreshCounts();
    void refreshQueue().catch(() => toast.error('Failed to refresh Quick Sort'));
    if (!selectedTaskId || !fields) return;

    const resolvesCurrentQueue =
      fields.status === 'done'
      || fields.status === 'cancelled'
      || (mode === 'no_priority' && typeof fields.priority === 'string' && fields.priority !== 'none')
      || (mode === 'no_effort' && typeof fields.effort === 'number')
      || (mode === 'no_due_date' && (
        typeof fields.dueDate === 'string'
        || (typeof fields.priority === 'string' && !['critical', 'high'].includes(fields.priority))
      ));

    if (resolvesCurrentQueue) {
      dismiss(selectedTaskId);
      setSelectedTaskId(null);
      return;
    }

    const patch: Partial<QuickSortQueueTask> = {};
    if (typeof fields.priority === 'string') patch.priority = fields.priority;
    if (typeof fields.status === 'string') patch.status = fields.status;
    if (typeof fields.effort === 'number' || fields.effort === null) patch.effort = fields.effort;
    if (typeof fields.dueDate === 'string' || fields.dueDate === null) patch.dueDate = fields.dueDate;
    updateTask(selectedTaskId, patch);
  }, [dismiss, mode, refreshCounts, refreshQueue, selectedTaskId, updateTask]);

  /** Swipe-left: accept all AI suggestions for this task */
  const handleAcceptSuggestions = useCallback(
    async (taskId: string) => {
      const suggestion = suggestions[taskId];
      if (!suggestion || !mode || busy) return;

      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      setBusy(true);
      try {
        const patch: Record<string, unknown> = {};
        const applied: string[] = [];
        const requestedFields: TaskField[] = [];

        if (suggestion.priority && task.priority === 'none') {
          patch.priority = suggestion.priority.value;
          requestedFields.push('priority');
          applied.push(`priority → ${suggestion.priority.value}`);
        }
        if (suggestion.effort && task.effort === null) {
          patch.effort = suggestion.effort.value;
          requestedFields.push('effort');
          applied.push(`effort → ${EFFORT_LABELS[suggestion.effort.value] ?? suggestion.effort.value}`);
        }

        if (suggestion.tags.length > 0 && task.tags.length === 0) {
          const existingTagIds = task.tags.map((t) => t.id);
          const newTagIds = suggestion.tags.map((t) => t.id);
          patch.tags = [...existingTagIds, ...newTagIds];
          requestedFields.push('tags');
          applied.push(`tags → ${suggestion.tags.map((t) => t.name).join(', ')}`);
        }

        const blockedField = requestedFields.find(
          (field) => !canEditTaskField(task.editPolicy, field),
        );
        if (blockedField) {
          toast.error(taskFieldBlockedReason(task.editPolicy, blockedField));
          setBusy(false);
          return;
        }

        if (Object.keys(patch).length > 0) {
          const logModes: QuickSortQueueMode[] = [];
          if (suggestion.priority && task.priority === 'none') logModes.push('no_priority');
          if (suggestion.effort && task.effort === null) logModes.push('no_effort');
          if (suggestion.tags.length > 0 && task.tags.length === 0) {
            suggestion.tags.forEach((tag) => recordRecentTag(tag.id));
            logModes.push('no_tags');
          }
          await runOperation({
            task,
            patch,
            operationMode: mode,
            action: 'suggestion_accepted',
            label: 'Apply AI suggestions',
            logModes,
            acceptedAI: true,
          });
        }

        if (applied.length > 0) {
          dismiss(taskId);
          refreshCounts();
          setStatsKey((k) => k + 1);
          setSessionSorted((n) => n + 1);
          setAiAccepted((n) => n + 1);
        }

        if (applied.length > 0) {
          toast.success(`Applied: ${applied.join(' · ')}`);
        } else {
          toast.info('No suggestions to apply');
        }
      } catch {
        toast.error('Failed to apply suggestions');
      }
      setBusy(false);
    },
    [suggestions, tasks, busy, dismiss, mode, refreshCounts, recordRecentTag, runOperation]
  );

  /** Swipe-right: accept only the current mode's AI suggestion */
  const handleAcceptFocused = useCallback(
    async (taskId: string) => {
      const suggestion = suggestions[taskId];
      if (!suggestion || !mode || busy) return;

      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      const fieldByMode: Record<QuickSortQueueMode, TaskField> = {
        no_priority: 'priority',
        no_effort: 'effort',
        no_tags: 'tags',
        no_due_date: 'dueDate',
      };
      const modeField = fieldByMode[mode];
      if (!canEditTaskField(task.editPolicy, modeField)) {
        toast.error(taskFieldBlockedReason(task.editPolicy, modeField));
        return;
      }

      setBusy(true);
      try {
        let applied = false;
        if (mode === 'no_priority' && suggestion.priority) {
          await runOperation({
            task,
            patch: { priority: suggestion.priority.value },
            operationMode: mode,
            action: 'suggestion_accepted',
            label: 'Apply priority suggestion',
            acceptedAI: true,
          });
          toast.success(`Priority → ${suggestion.priority.value}`);
          applied = true;
        } else if (mode === 'no_effort' && suggestion.effort) {
          await runOperation({
            task,
            patch: { effort: suggestion.effort.value },
            operationMode: mode,
            action: 'suggestion_accepted',
            label: 'Apply effort suggestion',
            acceptedAI: true,
          });
          toast.success(`Effort → ${EFFORT_LABELS[suggestion.effort.value] ?? suggestion.effort.value}`);
          applied = true;
        } else if (mode === 'no_tags' && suggestion.tags.length > 0) {
          const existingTagIds = task.tags.map((t) => t.id);
          const newTagIds = suggestion.tags.map((t) => t.id);
          await runOperation({
            task,
            patch: { tags: [...existingTagIds, ...newTagIds] },
            operationMode: mode,
            action: 'suggestion_accepted',
            label: 'Apply tag suggestions',
            acceptedAI: true,
          });
          suggestion.tags.forEach((t) => recordRecentTag(t.id));
          toast.success(`Tags → ${suggestion.tags.map((t) => t.name).join(', ')}`);
          applied = true;
        }

        if (applied) {
          dismiss(taskId);
          refreshCounts();
          setStatsKey((k) => k + 1);
          setSessionSorted((n) => n + 1);
          setAiAccepted((n) => n + 1);
        } else {
          toast.info('No suggestion available for this mode');
        }
      } catch {
        toast.error('Failed to apply suggestion');
      }
      setBusy(false);
    },
    [suggestions, tasks, mode, busy, dismiss, refreshCounts, recordRecentTag, runOperation]
  );

  const hasAnySuggestion = !!(
    topSuggestion
    && (topSuggestion.priority || topSuggestion.effort || topSuggestion.tags.length > 0)
  );
  const hasFocusedSuggestion = !!(
    topSuggestion
    && (
      (mode === 'no_priority' && topSuggestion.priority)
      || (mode === 'no_effort' && topSuggestion.effort)
      || (mode === 'no_tags' && topSuggestion.tags.length > 0)
    )
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldBlockGlobalShortcut(event)) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
      ) {
        return;
      }
      if (
        event.key.toLowerCase() === 'z'
        && (event.metaKey || event.ctrlKey)
        && !event.altKey
      ) {
        if (lastOperation && !busy && !selectedTaskId) {
          event.preventDefault();
          event.stopPropagation();
          void handleUndo();
        }
        return;
      }
      if (!window.matchMedia('(min-width: 1024px)').matches) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === 'g') {
        if (globalChordPendingRef.current) {
          globalChordPendingRef.current = false;
          if (globalChordTimeoutRef.current) clearTimeout(globalChordTimeoutRef.current);
        } else {
          globalChordPendingRef.current = true;
          globalChordTimeoutRef.current = setTimeout(() => {
            globalChordPendingRef.current = false;
          }, 1000);
        }
        return;
      }
      if (globalChordPendingRef.current) {
        globalChordPendingRef.current = false;
        if (globalChordTimeoutRef.current) clearTimeout(globalChordTimeoutRef.current);
        return;
      }

      if (!mode || !topTask || busy || selectedTaskId) return;

      const isLocalShortcut = (
        (mode === 'no_priority' && ['1', '2', '3', '4'].includes(key))
        || (mode === 'no_effort' && ['1', '2', '3', '4', '5'].includes(key))
        || ['a', 'k', 'd', 'v'].includes(key)
      );
      if (event.repeat && isLocalShortcut) {
        event.preventDefault();
        return;
      }

      let handled = true;
      if (mode === 'no_priority' && ['1', '2', '3', '4'].includes(key)) {
        const priorities = ['critical', 'high', 'medium', 'low'];
        void handleApplyPriority(priorities[Number(key) - 1]);
      } else if (mode === 'no_effort' && ['1', '2', '3', '4', '5'].includes(key)) {
        void handleApplyEffort(Number(key));
      } else if (key === 'a' && event.shiftKey && hasAnySuggestion) {
        void handleAcceptSuggestions(topTask.id);
      } else if (key === 'a' && hasFocusedSuggestion) {
        void handleAcceptFocused(topTask.id);
      } else if (key === 'k') {
        void handleSkip(topTask.id);
      } else if (key === 'd') {
        void handleMarkDone();
      } else if (key === 'v') {
        setSelectedTaskId(topTask.id);
      } else {
        handled = false;
      }

      if (handled) event.preventDefault();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    busy,
    handleAcceptFocused,
    handleAcceptSuggestions,
    handleApplyEffort,
    handleApplyPriority,
    handleMarkDone,
    handleSkip,
    handleUndo,
    hasAnySuggestion,
    hasFocusedSuggestion,
    mode,
    lastOperation,
    selectedTaskId,
    topTask,
  ]);

  useEffect(() => (
    () => {
      if (globalChordTimeoutRef.current) clearTimeout(globalChordTimeoutRef.current);
    }
  ), []);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden bg-[var(--background)] lg:grid-cols-[18rem_minmax(0,1fr)]">
      {(!mode || !isSingleColumnLayout) && (
        <aside
          className="flex min-h-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--surface-1)]"
          aria-label="Quick Sort queues"
        >
          <div className="px-4 pb-2 pt-4 lg:px-5 lg:pt-5">
            <h1 className="text-xl font-bold text-[var(--text-primary)]">Quick Sort</h1>
          </div>
          <ScopeFilter filter={scopeFilter} onChange={setScopeFilter} />
          <div className="mt-1">
            <ActivityBanner key={statsKey} />
          </div>
          <ModeSelector
            counts={counts}
            onSelect={handleModeSelect}
            selectedMode={mode}
            disabled={busy}
          />
        </aside>
      )}

      {!mode ? (
        <section className="hidden min-h-0 items-center justify-center p-10 text-center lg:flex">
          <div className="max-w-md">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-400/20">
              <Zap size={26} />
            </div>
            <h2 className="mt-5 text-xl font-semibold text-[var(--text-primary)]">Choose a queue to begin</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--text-tertiary)]">
              Your queue, filters, and progress stay in place.
            </p>
          </div>
        </section>
      ) : (
        <div className="flex min-h-0 min-w-0">
          <section
            className="quick-sort-mode flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            data-testid="quick-sort-mode"
          >
            <div className="quick-sort-mode-header flex min-h-11 flex-shrink-0 items-center gap-2 border-b border-transparent px-4 py-2 lg:gap-3 lg:border-[var(--border-subtle)] lg:px-6 lg:py-3">
              <button
                onClick={() => setMode(null)}
                className="-ml-2 flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] lg:hidden"
                aria-label="Back"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="text-base font-semibold text-[var(--text-primary)] lg:text-lg">{MODE_LABELS[mode]}</h1>
                <p className="mt-0.5 hidden text-xs text-[var(--text-tertiary)] lg:block">
                  Choose an action below or use the keyboard shortcuts.
                </p>
              </div>
              <div className="quick-sort-landscape-order hidden min-w-0">
                <OrderSelector value={order} onChange={setOrder} />
              </div>
              <button
                type="button"
                onClick={() => void handleUndo()}
                disabled={!lastOperation || busy}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={lastOperation ? `Undo ${lastOperation.label}` : 'Nothing to undo'}
              >
                <RotateCcw size={15} />
                <span className="hidden sm:inline">Undo</span>
              </button>
              {remaining > 0 && (
                <span className="quick-sort-remaining rounded-full bg-[var(--surface-2)] px-2 py-1 text-xs font-medium text-[var(--text-secondary)]">
                  <AnimatedCounter value={remaining} className="tabular-nums" /> left
                </span>
              )}
            </div>

            <div className="quick-sort-order-row flex flex-shrink-0 items-center gap-3 px-4 pb-2 lg:px-6 lg:py-3">
              <div className="min-w-0 flex-1">
                <OrderSelector value={order} onChange={setOrder} />
              </div>
              <div className="hidden flex-wrap items-center justify-end gap-1.5 text-[11px] text-[var(--text-muted)] lg:flex">
                <Keyboard size={13} />
                <span>{mode === 'no_priority' ? '1–4 choose' : mode === 'no_effort' ? '1–5 choose' : 'Choose below'}</span>
                <span>·</span>
                <span>A apply AI</span>
                <span>·</span>
                <span>⇧A apply all</span>
                <span>·</span>
                <span>K skip</span>
                <span>·</span>
                <span>D done</span>
                <span>·</span>
                <span>V details</span>
                <span>·</span>
                <span>Ctrl+Z undo</span>
              </div>
            </div>

            {sessionSorted > 0 && (
              <div className="mx-4 mb-3 flex-shrink-0 rounded-[22px] bg-white/[0.03] px-4 py-3 ring-1 ring-inset ring-white/[0.06] lg:mx-6">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-slate-400">Session progress</span>
                  <span className="font-medium text-emerald-300">
                    <AnimatedCounter value={sessionSorted} className="tabular-nums" /> sorted
                  </span>
                </div>
                {initialTotal > 0 && (
                  <div className="mt-2 h-2 rounded-full bg-slate-800">
                    <div
                      className="h-2 rounded-full bg-gradient-to-r from-amber-400 to-amber-500 transition-all duration-300"
                      style={{ width: `${Math.min(100, Math.round((sessionSorted / initialTotal) * 100))}%` }}
                    />
                  </div>
                )}
                <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
                  <span>
                    <AnimatedCounter
                      value={elapsedMinutes}
                      className="tabular-nums"
                    />m elapsed
                  </span>
                  {sessionSorted > 0 && aiAccepted > 0 && (
                    <span>
                      AI used: <AnimatedCounter
                        value={Math.round((aiAccepted / sessionSorted) * 100)}
                        className="tabular-nums"
                      />%
                    </span>
                  )}
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
                <Loader2 size={28} className="animate-spin text-[var(--accent-400)]" />
                <p className="text-sm text-[var(--text-tertiary)]">Loading tasks…</p>
              </div>
            ) : (
              <>
                <div className="quick-sort-card-region relative flex min-h-0 flex-1 flex-col overflow-hidden px-4 lg:min-h-[19rem] lg:px-6">
                  {tasks.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 py-12">
                      <CheckCircle2 size={48} className="text-green-400" />
                      <div className="text-center">
                        <p className="text-lg font-semibold text-[var(--text-primary)]">All caught up!</p>
                        <p className="mt-1 text-sm text-[var(--text-tertiary)]">
                          No tasks need attention in this queue.
                        </p>
                      </div>

                      {sessionSorted > 0 && (
                        <div className="w-full max-w-lg rounded-[22px] bg-white/[0.03] px-5 py-4 ring-1 ring-inset ring-white/[0.06]">
                          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-emerald-300">Session Complete</p>
                          <div className="grid grid-cols-3 gap-3 text-center">
                            <div>
                              <p className="text-[20px] font-bold text-white">
                                <AnimatedCounter value={sessionSorted} className="tabular-nums" />
                              </p>
                              <p className="text-[11px] text-slate-400">Sorted</p>
                            </div>
                            <div>
                              <p className="text-[20px] font-bold text-white">
                                <AnimatedCounter
                                  value={elapsedMinutes}
                                  className="tabular-nums"
                                />m
                              </p>
                              <p className="text-[11px] text-slate-400">Time</p>
                            </div>
                            <div>
                              <p className="text-[20px] font-bold text-white">
                                <AnimatedCounter
                                  value={sessionSorted > 0 ? Math.round((aiAccepted / sessionSorted) * 100) : 0}
                                  className="tabular-nums"
                                />%
                              </p>
                              <p className="text-[11px] text-slate-400">AI Used</p>
                            </div>
                          </div>
                        </div>
                      )}

                      <button
                        onClick={() => setMode(null)}
                        className="mt-2 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors active:bg-[var(--surface-3)]"
                      >
                        <RefreshCw size={14} />
                        Choose another queue
                      </button>
                    </div>
                  ) : (
                    <div className="relative min-h-0 flex-1">
                      {stackTasks.slice(1, 3).map((task, i) => (
                        <QuickSortCard
                          key={task.id}
                          task={task}
                          mode={mode}
                          stackIndex={i + 1}
                          onAcceptSuggestions={handleAcceptSuggestions}
                          onAcceptFocused={handleAcceptFocused}
                          onSkip={handleSkip}
                          busy={busy}
                        />
                      ))}

                      <AnimatePresence mode="popLayout">
                        {topTask && (
                          <motion.div
                            key={topTask.id}
                            className="absolute inset-0"
                            style={{ zIndex: 20 }}
                            initial={{ scale: 0.92, opacity: 0, y: 30, rotateZ: -2 }}
                            animate={{ scale: 1, opacity: 1, y: 0, rotateZ: 0 }}
                            exit={{ opacity: 0, scale: 0.85, y: -80, rotateZ: 3, transition: { duration: 0.25, ease: 'easeIn' } }}
                            transition={{ type: 'spring', damping: 22, stiffness: 280 }}
                          >
                            <QuickSortCard
                              task={topTask}
                              mode={mode}
                              suggestion={topSuggestion}
                              stackIndex={0}
                              onAcceptSuggestions={handleAcceptSuggestions}
                              onAcceptFocused={handleAcceptFocused}
                              onSkip={handleSkip}
                              onUndo={lastOperation ? handleUndo : undefined}
                              undoLabel={lastOperation?.label}
                              busy={busy}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>

                {topTask && (
                  <>
                    {hasAnySuggestion && (
                      <div className="mx-6 mb-3 hidden items-center gap-3 rounded-xl border border-violet-400/20 bg-violet-500/10 px-4 py-3 lg:flex">
                        <Sparkles size={16} className="text-violet-300" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-violet-100">Houston has a suggestion for this task</p>
                          <p className="text-xs text-violet-200/60">Apply the current field or all available metadata suggestions.</p>
                        </div>
                        {hasFocusedSuggestion && (
                          <button
                            type="button"
                            onClick={() => void handleAcceptFocused(topTask.id)}
                            disabled={busy}
                            className="rounded-lg border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-100 transition-colors hover:bg-violet-500/25 disabled:opacity-50"
                          >
                            Apply suggestion <span className="ml-1 text-violet-300/70">A</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleAcceptSuggestions(topTask.id)}
                          disabled={busy}
                          className="rounded-lg bg-violet-500 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-violet-400 disabled:opacity-50"
                        >
                          Apply all <span className="ml-1 text-white/70">⇧A</span>
                        </button>
                      </div>
                    )}

                    <div
                      className="quick-sort-action-region min-h-0 flex-shrink-0 overflow-hidden border-t border-[var(--border-subtle)] pb-2 pt-2 lg:px-2 lg:pb-4 lg:pt-3"
                      data-testid="quick-sort-actions"
                    >
                      <QuickSortActions
                        task={topTask}
                        mode={mode}
                        suggestion={topSuggestion}
                        onViewTask={() => setSelectedTaskId(topTask.id)}
                        onSkip={() => handleSkip(topTask.id)}
                        onMarkDone={handleMarkDone}
                        onSetLocalDisposition={handleSetLocalDisposition}
                        onApplyPriority={handleApplyPriority}
                        onApplyEffort={handleApplyEffort}
                        onApplyTag={handleApplyTag}
                        onApplyDueDate={handleApplyDueDate}
                        allTags={allTags}
                        tagsLoading={tagsLoading}
                        recentTagIds={recentTagIds}
                        busy={busy}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </section>

          {!useCompactTaskDetails && selectedTaskId && (
            <TaskDetailPanel
              taskId={selectedTaskId}
              mode="panel"
              onClose={() => setSelectedTaskId(null)}
              onUpdate={handleTaskDetailUpdate}
              minPanelWidth={320}
              focusPanelOnMount
            />
          )}

          {useCompactTaskDetails && (
            <MobileSheet
              isOpen={selectedTaskId !== null}
              onClose={() => setSelectedTaskId(null)}
              ariaLabel="Task details"
              height="full"
            >
              {selectedTaskId && (
                <TaskDetailPanel
                  taskId={selectedTaskId}
                  mode="mobile"
                  onClose={() => setSelectedTaskId(null)}
                  onUpdate={handleTaskDetailUpdate}
                  focusPanelOnMount
                />
              )}
              <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {undoStatus}
              </p>
            </MobileSheet>
          )}
        </div>
      )}
    </div>
  );
}
