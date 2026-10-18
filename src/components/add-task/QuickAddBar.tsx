'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import Image from 'next/image';
import { Calendar, Check, CheckSquare, ClipboardList, Flame, AlertCircle, Clock, Repeat, Ellipsis, Maximize2, Sparkles, Sun, GitBranch, LoaderCircle, Mic, Square } from 'lucide-react';
import { CONNECTOR_ICON_PATHS, CONNECTOR_LABELS } from '@/lib/constants/colors';
import { cn } from '@/lib/utils';
import { PRIORITY_OPTIONS, getEffortOptions, DEFAULT_EFFORT_MEASURE, getTaskPriorityVisual } from '@/lib/constants/task-formatting';
import { dropdownVariants } from '@/lib/motion';
import { useListAnimate } from '@/lib/hooks/useListAnimate';
import {
  parseTaskInput,
  parseTaskInputForSubmission,
  ParsedTask,
  SUBTASK_QUICK_ADD_METADATA,
} from '@/lib/parse-task-input';
import { extractPendingTasks as extractPendingTasksFromPaste, normalizePendingTaskText as normalizePasteText, splitCompoundTask } from '@/lib/paste-parser';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { Tooltip } from '@/components/ui/Tooltip';
import { AddTaskModal, type TaskPrefill } from './AddTaskModal';
import dynamic from 'next/dynamic';
import type { TokenInputHandle } from './TokenInput';

const TokenInput = dynamic(() => import('./TokenInput').then(mod => mod.TokenInput), { ssr: false });
import { TemplatePicker } from './TemplatePicker';
import { WorkflowApplyModal } from './WorkflowApplyModal';
import type { QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import { parseNlpHints } from '@/lib/parse-nlp-hints';
import { FileText } from 'lucide-react';
import { taskLogger } from '@/lib/client-logger';
import { toast } from '@/lib/toast';
import { useVoiceCapture } from '@/lib/hooks/useVoiceCapture';
import type { TaskEditPolicy, TaskField, TaskTemplate } from '@/types';
import {
  canEditTaskField,
  canRemoveTask,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import {
  DEFAULT_QUICK_ADD_PREFERENCES,
  getQuickAddPreferences,
  QUICK_ADD_PREFERENCES_EVENT,
  type QuickAddPreferences,
} from '@/lib/quick-add-preferences';
import type { QuickAddProject } from '@/lib/parse-task-input';
import { DestinationPicker } from './DestinationPicker';
import {
  QuickAddSuggestionReview,
  type QuickAddReviewProject,
  type QuickAddSuggestionSelection,
} from './QuickAddSuggestionReview';
import type { QuickAddDestination, QuickAddPendingTask } from './quick-add-types';
import { useQuickAddDestinations } from '@/lib/hooks/useQuickAddDestinations';
import { useQuickAddTemplates } from '@/lib/hooks/useQuickAddTemplates';
import { getLocalToday } from '@/lib/utils/client-date';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import { recordTagRecommendationFeedback } from '@/lib/tags/recommendation-feedback';
import {
  fetchQuickAddSuggestion,
  getQuickAddProjectAffordance,
  getQuickAddSubmissionMessage,
  getVisibleQuickAddProject,
  mergeQuickAddSuggestions,
  planQuickAddSubmission,
  resolveQuickAddProjectId,
  submitQuickAdd,
  syncQuickAddProjectActive,
  undoQuickAddTasks,
  type QuickAddProjectAffordance,
  type VisibleQuickAddProject,
} from '@/lib/quick-add/submission';

export {
  getQuickAddProjectAffordance,
  getVisibleQuickAddProject,
  resolveQuickAddProjectId,
  syncQuickAddProjectActive,
};
export type { QuickAddProjectAffordance, VisibleQuickAddProject };

const LazyTaskDetailPanel = dynamic(
  () => import('@/components/task-detail/TaskDetailPanel').then(mod => ({ default: mod.TaskDetailPanel })),
  { ssr: false }
);

function ConnectorIconImg({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICON_PATHS[type];
  if (src) {
    return <Image src={src} alt={type} width={size} height={size} className="flex-shrink-0" />;
  }
  // Fallback: lucide icon for unknown connectors
  return <ClipboardList size={size} className="flex-shrink-0 text-[var(--text-muted)]" />;
}

interface QuickAddBarProps {
  onTaskAdded?: () => void;
}

function QuickAddSplitPreview({
  tasks,
  onKeepAsOneTask,
  className,
}: {
  tasks: string[];
  onKeepAsOneTask: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border border-teal-800/40 bg-teal-950/20 px-3 py-2 text-xs',
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <GitBranch size={13} className="shrink-0 text-teal-400" />
        <span className="font-medium text-teal-200" aria-live="polite">
          Split into {tasks.length} tasks
        </span>
        <span className="hidden text-[var(--text-muted)] sm:inline">
          Enter will add each item separately
        </span>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onKeepAsOneTask}
          className="ml-auto shrink-0 rounded-md px-2 py-1 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
        >
          Keep as one task
        </button>
      </div>
      <ol className="flex min-w-0 flex-wrap gap-1.5" aria-label="Tasks to be created">
        {tasks.map((task, index) => (
          <li
            key={`${index}-${task}`}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[var(--text-secondary)]"
          >
            <span className="tabular-nums text-teal-400">{index + 1}.</span>
            <span className="truncate">{task}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function QuickAddProjectControl({
  project,
  active,
  onActiveChange,
}: {
  project: VisibleQuickAddProject;
  active: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  const affordance = getQuickAddProjectAffordance(project.name, active);

  return (
    <Tooltip content={affordance.tooltip}>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onActiveChange(!active)}
        className={active
          ? 'inline-flex max-w-[104px] items-center gap-1 rounded-md border border-pink-700/40 bg-pink-900/30 px-1.5 py-1 text-xs font-medium text-pink-300 transition-colors hover:bg-pink-900/50 sm:max-w-[160px] sm:px-2 xl:max-w-[240px]'
          : 'inline-flex max-w-7 items-center gap-1 overflow-hidden rounded-md border border-transparent px-1.5 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-pink-700/30 hover:bg-pink-900/20 hover:text-pink-300 sm:max-w-[140px] sm:px-2 xl:max-w-[220px]'
        }
        aria-label={affordance.ariaLabel}
        aria-pressed={active}
      >
        <GitBranch size={12} className="shrink-0" />
        {active ? (
          <>
            <span className="hidden shrink-0 sm:inline xl:hidden">To:</span>
            <span className="hidden shrink-0 xl:inline">Adding to</span>
            <span className="truncate">{project.name}</span>
            <span className="ml-0.5 shrink-0 text-pink-400/60">×</span>
          </>
        ) : (
          <>
            <span className="hidden shrink-0 sm:inline xl:hidden">+</span>
            <span className="hidden shrink-0 xl:inline">Add to</span>
            <span className="hidden truncate sm:inline">{project.name}</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}

type PendingTask = QuickAddPendingTask;

export type QuickAddTypeaheadKind =
  | 'template'
  | 'list'
  | 'tag'
  | 'project'
  | 'priority'
  | 'effort';

export interface QuickAddTypeaheadDismissal {
  kind: QuickAddTypeaheadKind;
  triggerStart: number;
}

const QUICK_ADD_TYPEAHEAD_PATTERNS: Record<QuickAddTypeaheadKind, RegExp> = {
  template: /(?:^|\s)t\/\S*$/,
  list: /(?:^|\s)\/\S*$/,
  tag: /(?:^|\s)#[a-zA-Z0-9_:./-]*$/,
  project: /(?:^|\s)\+[^+#@!~^/]*$/,
  priority: /(?:^|\s)![a-zA-Z0-9]*$/,
  effort: /(?:^|\s)\^[a-zA-Z0-9]*$/,
};

export function getQuickAddTypeaheadTriggerStart(
  input: string,
  kind: QuickAddTypeaheadKind,
): number | null {
  const match = QUICK_ADD_TYPEAHEAD_PATTERNS[kind].exec(input);
  if (!match) return null;
  return match.index + (/^\s/.test(match[0]) ? 1 : 0);
}

export function isQuickAddTypeaheadDismissed(
  dismissal: QuickAddTypeaheadDismissal | null,
  input: string,
  kind: QuickAddTypeaheadKind,
): boolean {
  return dismissal?.kind === kind
    && dismissal.triggerStart === getQuickAddTypeaheadTriggerStart(input, kind);
}

export function scrollListTypeaheadSelectionIntoView(
  container: HTMLElement | null,
  index: number,
): void {
  container
    ?.querySelector<HTMLElement>(`[data-list-typeahead-index="${index}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

export function getQuickAddSlashDestinations(
  destinations: QuickAddDestination[],
  query: string,
): QuickAddDestination[] {
  const normalizedQuery = query.toLowerCase().trim();
  if (normalizedQuery.includes(':')) return [];

  return destinations
    .filter((destination) =>
      Boolean(destination.listId) || destination.listSelectionMode !== 'required'
    )
    .filter((destination) => {
      if (!normalizedQuery) return true;
      return [
        destination.listName,
        destination.shortLabel,
        destination.label,
        destination.groupName,
        destination.connectorType,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((a, b) => {
      if (normalizedQuery) {
        const aMatchesListName = Boolean(a.listName?.toLowerCase().includes(normalizedQuery));
        const bMatchesListName = Boolean(b.listName?.toLowerCase().includes(normalizedQuery));
        if (aMatchesListName !== bMatchesListName) return aMatchesListName ? -1 : 1;
      }
      if (Boolean(a.listId) !== Boolean(b.listId)) return a.listId ? -1 : 1;
      return (a.shortLabel ?? a.label).localeCompare(b.shortLabel ?? b.label);
    });
}

function isPendingSubtask(task: PendingTask): boolean {
  return task.parentIndex !== null || Boolean(task.parentTaskId);
}

function normalizePendingTaskText(text: string): string {
  return normalizePasteText(text);
}

function extractPendingTasks(text: string): { committed: PendingTask[]; remaining: string } {
  const result = extractPendingTasksFromPaste(text);
  const baseId = Date.now();
  return {
    committed: result.committed.map((task, i) => ({
      id: `pending-task-paste-${baseId}-${i}`,
      text: task.text,
      parentIndex: task.parentIndex,
      isComplete: task.isComplete,
    })),
    remaining: result.remaining,
  };
}

/**
 * Extract pending tasks for real-time typing — only handles explicit delimiters
 * (;; and multi-line paste), NOT NLP compound splitting ("verb and verb").
 * NLP compound splitting is deferred to submit time to avoid premature tokenization.
 */
function extractPendingTasksForTyping(text: string): { committed: PendingTask[]; remaining: string } {
  const normalized = text.replace(/\r\n?/g, '\n');

  // Only handle ;; delimiter during typing (not NLP compound detection)
  if (normalized.includes(';;')) {
    return extractPendingTasks(text);
  }

  // Multi-line paste (newlines present) — use full extraction
  if (normalized.includes('\n')) {
    return extractPendingTasks(text);
  }

  // Single-line typing: no auto-splitting
  return { committed: [], remaining: text };
}

interface InlineToast {
  message: string;
  taskIds: string[];
  editPolicies: Record<string, TaskEditPolicy>;
  /** Suffix shown after the destination label (e.g. account / My Day) */
  destSuffix?: string;
  /** Metadata shown for single-task additions */
  singleTaskMeta?: {
    title: string;
    listName: string | null;
    priority: string | null;
    dueDate: string | null;
    dueDateLabel: string | null;
  };
  /** AI-suggested metadata from quick sort suggestions API */
  suggestions?: QuickSortSuggestion | null;
  /** Current state of the async suggestion check for single-task additions */
  suggestionStatus?: 'loading' | 'ready' | 'empty' | 'error';
  /** Whether suggestion apply is in-flight */
  suggestionsApplying?: boolean;
  /** Whether suggestions were already applied */
  suggestionsApplied?: boolean;
}

export function QuickAddBar({ onTaskAdded }: QuickAddBarProps) {
  const [input, setInput] = useState('');
  const quickAddCtx = useQuickAddContext();
  const {
    destinations,
    destination,
    selectDestination,
    isPickerOpen: showDestPicker,
    setPickerOpen: setShowDestPicker,
    sourceLists,
  } = useQuickAddDestinations({
    sourceFilter: quickAddCtx.sourceFilter,
    listFilter: quickAddCtx.listFilter,
    listFilterName: quickAddCtx.listFilterName,
    listFilterConnectorType: quickAddCtx.listFilterConnectorType,
  });
  const {
    isPickerOpen: showTemplatePicker,
    setPickerOpen: setShowTemplatePicker,
    workflowTemplate,
    setWorkflowTemplate,
    selectedTemplateId,
    setSelectedTemplateId,
    typeahead: rawTemplateTypeahead,
    typeaheadIndex: templateTypeaheadIndex,
    setTypeaheadIndex: setTemplateTypeaheadIndex,
  } = useQuickAddTemplates(input);
  const [dismissedTypeahead, setDismissedTypeahead] =
    useState<QuickAddTypeaheadDismissal | null>(null);
  const templateTypeahead = isQuickAddTypeaheadDismissed(
    dismissedTypeahead,
    input,
    'template',
  ) ? null : rawTemplateTypeahead;
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const [currentInputParentTaskId, setCurrentInputParentTaskId] = useState<string>();
  const [pendingChipsRef] = useListAnimate({ duration: 150 });
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalPrefill, setModalPrefill] = useState<TaskPrefill | undefined>();
  const [mobileCaptureSemantics, setMobileCaptureSemantics] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inlineToast, setInlineToast] = useState<InlineToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [listTypeaheadIndex, setListTypeaheadIndex] = useState(0);
  const listTypeaheadScrollRef = useRef<HTMLDivElement>(null);
  // Animation state for the "flying token" when a list is selected
  const [pillFlash, setPillFlash] = useState(false);
  const [flyingToken, setFlyingToken] = useState<{ label: string; from: DOMRect; to: DOMRect } | null>(null);
  const [shouldRefocusInput, setShouldRefocusInput] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  // Task ID to show in the popover detail dialog (from "View" toast action)
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  // Compound split hint: shown when NLP detects "verb and verb" pattern during typing
  const [compoundSplitHint, setCompoundSplitHint] = useState<string[] | null>(null);
  const [dismissedCompoundSplitInput, setDismissedCompoundSplitInput] = useState<string | null>(null);
  // Tag / priority / effort typeahead state
  const [tagTypeaheadIndex, setTagTypeaheadIndex] = useState(0);
  const [priorityTypeaheadIndex, setPriorityTypeaheadIndex] = useState(0);
  const [effortTypeaheadIndex, setEffortTypeaheadIndex] = useState(0);
  const [projectTypeaheadIndex, setProjectTypeaheadIndex] = useState(0);
  const [cachedTags, setCachedTags] = useState<Array<{ id: string; name: string; slug: string; color?: string | null }>>([]);
  const [cachedProjects, setCachedProjects] = useState<QuickAddReviewProject[]>([]);
  const [projectsLoadState, setProjectsLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const tagsFetchedRef = useRef(false);
  const projectsFetchedRef = useRef(false);
  const [quickAddPreferences, setQuickAddPreferencesState] = useState<QuickAddPreferences>(DEFAULT_QUICK_ADD_PREFERENCES);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const inputHandleRef = useRef<TokenInputHandle | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const destPillRef = useRef<HTMLButtonElement>(null);
  const nextPendingTaskIdRef = useRef(0);
  // Local toggle for My Day — initialized from context, can be toggled by user
  const [myDayActive, setMyDayActive] = useState(false);
  const visibleContextProject = useMemo(
    () => getVisibleQuickAddProject(quickAddCtx.projectFilter, quickAddCtx.projectFilterName),
    [quickAddCtx.projectFilter, quickAddCtx.projectFilterName],
  );
  const [contextProjectActive, setContextProjectActive] = useState(false);
  const contextProjectIdRef = useRef<string | null>(null);
  // When true, submit the task after the next typeahead acceptance clears the dropdown
  const submitAfterTypeaheadRef = useRef(false);

  const dismissTypeahead = useCallback((kind: QuickAddTypeaheadKind) => {
    const triggerStart = getQuickAddTypeaheadTriggerStart(input, kind);
    if (triggerStart === null) return;
    setDismissedTypeahead({ kind, triggerStart });
  }, [input]);

  const moveViewedTaskToList = useCallback(async (targetListId: string) => {
    if (!viewTaskId) return;

    try {
      const response = await fetch(`/api/tasks/${viewTaskId}/move-to-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetListId }),
      });
      if (!response.ok) throw new Error('Failed to move task');

      const targetList = sourceLists.find((list) => list.id === targetListId);
      toast.success(`Moved to ${targetList?.name || 'list'}`);
      onTaskAdded?.();
      window.dispatchEvent(new CustomEvent('mission-control:task-added'));
    } catch (error) {
      taskLogger.error('Failed to move Quick Add task to list', { error, taskId: viewTaskId });
      toast.error('Failed to move task');
    }
  }, [onTaskAdded, sourceLists, viewTaskId]);

  // Voice capture for dictation into the quick-add input
  const handleVoiceTranscript = useCallback((text: string) => {
    setInput(prev => prev ? `${prev} ${text}` : text);
  }, []);
  const {
    state: voiceState,
    isSupported: voiceSupported,
    startListening: voiceStart,
    stopListening: voiceStop,
  } = useVoiceCapture({ onTranscript: handleVoiceTranscript, onError: (msg) => toast.error(msg) });
  const isVoiceListening = voiceState === 'listening';
  const isVoiceStarting = voiceState === 'starting';
  const isVoiceActive = isVoiceStarting || isVoiceListening;

  const activeInputMetadata = currentInputParentTaskId
    ? SUBTASK_QUICK_ADD_METADATA
    : undefined;
  const parseInput = useCallback((text: string) => parseTaskInput(text, {
    ...quickAddPreferences,
    projects: cachedProjects,
    metadata: activeInputMetadata,
  }), [activeInputMetadata, quickAddPreferences, cachedProjects]);
  const parseInputForSubmit = useCallback((text: string) => parseTaskInputForSubmission(text, {
    ...quickAddPreferences,
    projects: cachedProjects,
  }), [quickAddPreferences, cachedProjects]);
  const modalInput = input;
  const parsedInputForModal = useMemo(
    () => modalInput.trim() ? parseInputForSubmit(modalInput) : null,
    [modalInput, parseInputForSubmit],
  );
  const modalParsed = parsedInputForModal ?? parsed;

  useEffect(() => {
    const syncPreferences = () => setQuickAddPreferencesState(getQuickAddPreferences());
    syncPreferences();
    window.addEventListener(QUICK_ADD_PREFERENCES_EVENT, syncPreferences);
    window.addEventListener('storage', syncPreferences);
    return () => {
      window.removeEventListener(QUICK_ADD_PREFERENCES_EVENT, syncPreferences);
      window.removeEventListener('storage', syncPreferences);
    };
  }, []);

  // Sync myDayActive with context when it changes
  useEffect(() => {
    setMyDayActive(quickAddCtx.addToMyDay);
  }, [quickAddCtx.addToMyDay]);

  useEffect(() => {
    const nextProjectId = visibleContextProject?.id ?? null;
    setContextProjectActive(currentActive =>
      syncQuickAddProjectActive(contextProjectIdRef.current, nextProjectId, currentActive)
    );
    contextProjectIdRef.current = nextProjectId;
  }, [visibleContextProject?.id]);

  // Derive destination typeahead state from `/query`.
  const rawListTypeahead = (() => {
    const match = input.match(/(?:^|\s)\/(\S*)$/);
    if (!match) return null;
    const query = match[1].toLowerCase();
    const matches = getQuickAddSlashDestinations(destinations, query);
    return matches.length > 0 ? { query, matches } : null;
  })();
  const listTypeahead = isQuickAddTypeaheadDismissed(
    dismissedTypeahead,
    input,
    'list',
  ) ? null : rawListTypeahead;

  // Accept a template typeahead selection
  const acceptTemplateTypeahead = useCallback((template: TaskTemplate) => {
    setInput(template.name);
    setCurrentInputParentTaskId(undefined);
    setParsed(parseInput(template.name));
    setSelectedTemplateId(template.id);
    setShowModal(true);
    if (inputHandleRef.current) {
      inputHandleRef.current.setText(template.name);
    }
  }, [parseInput, setSelectedTemplateId]);

  // ── Tag typeahead: active when typing `#query` ───────────────────────────
  const rawTagTypeahead = useMemo(() => {
    const match = input.match(/(?:^|\s)#([a-zA-Z0-9_:./-]*)$/);
    if (!match) return null;
    const query = match[1].toLowerCase();
    if (cachedTags.length === 0 && query === '') return null; // nothing fetched yet, don't show empty

    const matches = query
      ? cachedTags.filter(t => t.name.toLowerCase().includes(query) || t.slug.includes(query))
      : cachedTags;
    return matches.length > 0 ? { query, matches } : null;
  }, [input, cachedTags]);
  const tagTypeahead = isQuickAddTypeaheadDismissed(
    dismissedTypeahead,
    input,
    'tag',
  ) ? null : rawTagTypeahead;

  // Fetch tags lazily when # typeahead activates
  useEffect(() => {
    if (!tagTypeahead && !input.match(/(?:^|\s)#$/)) return;
    if (tagsFetchedRef.current) return;
    tagsFetchedRef.current = true;
    fetch('/api/tags')
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load tags (${r.status})`);
        return r.json();
      })
      .then(data => setCachedTags(data.tags || []))
      .catch((error) => {
        tagsFetchedRef.current = false;
        taskLogger.error('Failed to fetch Quick Add tags', { error });
      });
  }, [input, tagTypeahead]);

  // Reset tag typeahead index when matches change
  useEffect(() => {
    setTagTypeaheadIndex(0);
  }, [tagTypeahead?.query]);

  // Accept a tag typeahead selection: replace `#partial` with `#fullname `
  const acceptTagTypeahead = useCallback((tag: { name: string; slug: string }) => {
    const cleaned = input.replace(/(?:^|\s)#[a-zA-Z0-9_:./-]*$/, (m) => {
      const prefix = m.startsWith(' ') ? ' ' : '';
      return `${prefix}#${tag.slug} `;
    });
    setInput(cleaned);
    if (inputHandleRef.current) {
      inputHandleRef.current.setText(cleaned);
    }
    inputHandleRef.current?.focus();
  }, [input]);

  const rawProjectTypeahead = useMemo(() => {
    const match = input.match(/(?:^|\s)\+([^+#@!~^/]*)$/);
    if (!match) return null;
    const rawQuery = match[1];
    const query = rawQuery.toLowerCase().trim();
    const isCompletedQuotedToken = /^".*"\s*$/.test(rawQuery);
    if (isCompletedQuotedToken) return null;
    const matches = query
      ? cachedProjects.filter(project => project.name.toLowerCase().includes(query))
      : cachedProjects;
    return matches.length > 0 ? { query, matches } : null;
  }, [input, cachedProjects]);
  const projectTypeahead = isQuickAddTypeaheadDismissed(
    dismissedTypeahead,
    input,
    'project',
  ) ? null : rawProjectTypeahead;

  useEffect(() => {
    if (projectsFetchedRef.current) return;
    projectsFetchedRef.current = true;
    fetch('/api/hub-projects?includePhases=true')
      .then(response => {
        if (!response.ok) throw new Error(`Failed to load projects (${response.status})`);
        return response.json();
      })
      .then(data => {
        setCachedProjects(data.projects || []);
        setProjectsLoadState('ready');
      })
      .catch((err) => {
        setProjectsLoadState('error');
        taskLogger.error('Failed to fetch hub projects for quick add', { err });
      });
  }, []);

  useEffect(() => {
    setProjectTypeaheadIndex(0);
  }, [projectTypeahead?.query]);

  const acceptProjectTypeahead = useCallback((project: QuickAddProject) => {
    const token = `+"${project.name}" `;
    const cleaned = input.replace(/(?:^|\s)\+[^+#@!~^/]*$/, (match) =>
      `${match.startsWith(' ') ? ' ' : ''}${token}`
    );
    setInput(cleaned);
    inputHandleRef.current?.setText(cleaned);
    inputHandleRef.current?.focus();
  }, [input]);

  // ── Priority typeahead: active when typing `!query` ──────────────────────
  const priorityTypeaheadOptions = useMemo(() => {
    // Filter out 'none' for typeahead — it's not useful
    return PRIORITY_OPTIONS.filter(o => o.value !== 'none');
  }, []);

  const rawPriorityTypeahead = useMemo(() => {
    const match = input.match(/(?:^|\s)!([a-zA-Z0-9]*)$/);
    if (!match) return null;
    const query = match[1].toLowerCase();

    const matches = query
      ? priorityTypeaheadOptions.filter(o =>
          o.value.startsWith(query) || o.label.toLowerCase().startsWith(query)
          || (o.value === 'critical' && '0'.startsWith(query))
          || (o.value === 'high' && '1'.startsWith(query))
          || (o.value === 'medium' && '2'.startsWith(query))
          || (o.value === 'low' && '3'.startsWith(query))
        )
      : priorityTypeaheadOptions;
    return matches.length > 0 ? { query, matches } : null;
  }, [input, priorityTypeaheadOptions]);
  const priorityTypeahead = isQuickAddTypeaheadDismissed(
    dismissedTypeahead,
    input,
    'priority',
  ) ? null : rawPriorityTypeahead;

  useEffect(() => {
    setPriorityTypeaheadIndex(0);
  }, [priorityTypeahead?.query]);

  // Accept a priority typeahead selection: replace `!partial` with `!value `
  const acceptPriorityTypeahead = useCallback((option: { value: string }) => {
    const cleaned = input.replace(/(?:^|\s)![a-zA-Z0-9]*$/, (m) => {
      const prefix = m.startsWith(' ') ? ' ' : '';
      return `${prefix}!${option.value} `;
    });
    setInput(cleaned);
    if (inputHandleRef.current) {
      inputHandleRef.current.setText(cleaned);
    }
    inputHandleRef.current?.focus();
  }, [input]);

  // ── Effort typeahead: active when typing `^query` ────────────────────────
  const effortTypeaheadOptions = useMemo(() => {
    return getEffortOptions(DEFAULT_EFFORT_MEASURE).filter(o => o.value !== 0);
  }, []);

  const rawEffortTypeahead = useMemo(() => {
    const match = input.match(/(?:^|\s)\^([a-zA-Z0-9]*)$/);
    if (!match) return null;
    const query = match[1].toLowerCase();

    const matches = query
      ? effortTypeaheadOptions.filter(o =>
          o.label.toLowerCase().startsWith(query) || String(o.value).startsWith(query)
        )
      : effortTypeaheadOptions;
    return matches.length > 0 ? { query, matches } : null;
  }, [input, effortTypeaheadOptions]);
  const effortTypeahead = isQuickAddTypeaheadDismissed(
    dismissedTypeahead,
    input,
    'effort',
  ) ? null : rawEffortTypeahead;

  useEffect(() => {
    setEffortTypeaheadIndex(0);
  }, [effortTypeahead?.query]);

  // Accept an effort typeahead selection: replace `^partial` with `^value `
  const acceptEffortTypeahead = useCallback((option: { value: number }) => {
    const cleaned = input.replace(/(?:^|\s)\^[a-zA-Z0-9]*$/, (m) => {
      const prefix = m.startsWith(' ') ? ' ' : '';
      return `${prefix}^${option.value} `;
    });
    setInput(cleaned);
    if (inputHandleRef.current) {
      inputHandleRef.current.setText(cleaned);
    }
    inputHandleRef.current?.focus();
  }, [input]);

  useEffect(() => {
    if (!shouldRefocusInput) return;
    inputHandleRef.current?.focus();
    setShouldRefocusInput(false);
  }, [shouldRefocusInput]);

  // Reset typeahead index when matches change
  useEffect(() => {
    setListTypeaheadIndex(0);
  }, [listTypeahead?.query]);

  useEffect(() => {
    scrollListTypeaheadSelectionIntoView(listTypeaheadScrollRef.current, listTypeaheadIndex);
  }, [listTypeaheadIndex, listTypeahead?.query]);

  // Accept a destination selection: set the pill and strip /query from the input.
  const acceptListTypeahead = useCallback((dest: (typeof destinations)[number]) => {
    // Animate the token "flying" from the input to the destination pill
    const editorEl = barRef.current?.querySelector('[data-lexical-editor]');
    const pillEl = destPillRef.current;
    if (editorEl && pillEl) {
      const from = editorEl.getBoundingClientRect();
      const to = pillEl.getBoundingClientRect();
      const label = dest.listName || dest.shortLabel || dest.label;
      setFlyingToken({ label, from, to });
      setTimeout(() => setFlyingToken(null), 400);
    }
    setPillFlash(true);
    setTimeout(() => setPillFlash(false), 600);
    // Strip the /slug portion from input, keep any text before it
    const cleaned = input.replace(/(?:^|\s)\/\S*$/, '').trim();
    setInput(cleaned);
    if (inputHandleRef.current) {
      inputHandleRef.current.setText(cleaned);
    }
    selectDestination(dest, { manual: true });
    inputHandleRef.current?.focus();
  }, [input, selectDestination]);

  // Parse input on change
  useEffect(() => {
    if (input.trim()) {
      const result = parseInput(input);
      setParsed(result);

      // Check for a finalized /destination token.
      const slashMatch = input.match(/(?:^|\s)\/(\S+)\s/);
      if (slashMatch) {
        const listQuery = slashMatch[1].toLowerCase();
        const slashDestination = getQuickAddSlashDestinations(destinations, listQuery)[0];
        if (slashDestination) {
          selectDestination(slashDestination, { manual: true });
          // Remove the /slug portion, keep text before and after it
          const cleaned = input.replace(/(?:^|\s)\/\S+\s/, ' ').trim();
          setInput(cleaned);
          if (inputHandleRef.current) {
            inputHandleRef.current.setText(cleaned);
          }
          setPillFlash(true);
          setTimeout(() => setPillFlash(false), 600);
          return;
        }
      }

    } else {
      setParsed(null);
    }
  }, [input, destinations, parseInput, selectDestination]);

  // Global keyboard shortcut: N to focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldBlockGlobalShortcut(e)) return;

      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
        inputHandleRef.current?.focus();
      }
      // Ctrl+Shift+T: open template picker
      if (e.key === 'T' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        setShowTemplatePicker(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setShowTemplatePicker]);

  // Listen for custom event to open quick-add (from mobile "Add task" button).
  // On mobile the bar is visually hidden, so we open the full AddTaskModal directly.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        defaultTags?: string[];
        prefill?: TaskPrefill;
      }>).detail;
      if (detail?.prefill?.title?.trim()) {
        setInput(detail.prefill.title.trim());
        setParsed(null);
        setModalPrefill(detail.prefill);
        setMobileCaptureSemantics(false);
        setShowModal(true);
        return;
      }

      // Check if we're on a narrow viewport (bar is hidden via `hidden sm:block`)
      const isMobile = window.innerWidth < 640;
      if (isMobile) {
        const defaultTagTokens = detail?.defaultTags
          ?.map(tag => `#${tag.trim().replace(/\s+/g, '-')}`)
          .filter(token => token.length > 1)
          .join(' ');
        if (defaultTagTokens) {
          setInput(current => [current.trim(), defaultTagTokens].filter(Boolean).join(' '));
        }
        setMobileCaptureSemantics(true);
        setShowModal(true);
      } else {
        setMobileCaptureSemantics(false);
        setIsFocused(true);
        setTimeout(() => {
          inputHandleRef.current?.focus();
        }, 50);
      }
    };
    window.addEventListener('mission-control:open-quick-add', handler);
    return () => window.removeEventListener('mission-control:open-quick-add', handler);
  }, []);

  // Listen for custom event to open template picker (from KeyboardShortcuts)
  useEffect(() => {
    const handler = () => setShowTemplatePicker(true);
    window.addEventListener('mission-control:open-template-picker', handler);
    return () => window.removeEventListener('mission-control:open-template-picker', handler);
  }, [setShowTemplatePicker]);

  // Template selection handlers
  const handleSelectSingleTemplate = useCallback((template: TaskTemplate) => {
    // Pre-fill the input with template name and open AddTaskModal with template ID
    setInput(template.name);
    setCurrentInputParentTaskId(undefined);
    setParsed(parseInput(template.name));
    setSelectedTemplateId(template.id);
    setShowModal(true);
    setShowTemplatePicker(false);
  }, [parseInput, setSelectedTemplateId, setShowTemplatePicker]);

  const handleSelectWorkflowTemplate = useCallback((template: TaskTemplate) => {
    setWorkflowTemplate(template);
    setShowTemplatePicker(false);
  }, [setShowTemplatePicker, setWorkflowTemplate]);

  // Close destination picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setShowDestPicker(false);
      }
    };
    if (showDestPicker) {
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [setShowDestPicker, showDestPicker]);

  // Close plus menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    if (showPlusMenu) {
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [showPlusMenu]);

  const scheduleInlineToastDismiss = useCallback((delay: number) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setInlineToast(null), delay);
  }, []);

  const loadQuickAddSuggestions = useCallback(async (
    taskId: string,
    baseSuggestions: QuickSortSuggestion | null = null,
  ) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setInlineToast((previous) => {
      if (!previous || previous.taskIds[0] !== taskId) return previous;
      return { ...previous, suggestionStatus: 'loading' };
    });

    try {
      const fetched = await fetchQuickAddSuggestion({}, taskId);
      const merged = mergeQuickAddSuggestions(baseSuggestions, fetched);
      setInlineToast((previous) => {
        if (!previous || previous.taskIds[0] !== taskId) return previous;
        return {
          ...previous,
          suggestions: merged,
          suggestionStatus: merged ? 'ready' : 'empty',
        };
      });
      if (merged?.tags.length) {
        recordTagRecommendationFeedback({
          surface: 'quick-add',
          action: 'shown',
          taskId,
          suggestedTagIds: merged.tags.map((tag) => tag.id),
          acceptedTagIds: [],
          removedTagIds: [],
        });
      }
      scheduleInlineToastDismiss(merged ? 30000 : 5000);
    } catch (error) {
      taskLogger.error('Failed to fetch Quick Add suggestions', { error, taskId });
      setInlineToast((previous) => {
        if (!previous || previous.taskIds[0] !== taskId) return previous;
        return {
          ...previous,
          suggestions: baseSuggestions,
          suggestionStatus: baseSuggestions ? 'ready' : 'error',
        };
      });
      scheduleInlineToastDismiss(baseSuggestions ? 30000 : 15000);
    }
  }, [scheduleInlineToastDismiss]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;

    const parseOptions = {
      ...quickAddPreferences,
      projects: cachedProjects,
    };
    const plan = planQuickAddSubmission({
      input,
      pendingTasks,
      destination,
      contextListId: quickAddCtx.listFilter,
      contextListName: quickAddCtx.listFilterName,
      parseOptions,
      projectsLoadState,
      currentInputParentTaskId,
      splitCompoundTasks: normalizePendingTaskText(input) !== dismissedCompoundSplitInput,
    });
    if (plan.block) {
      if (plan.block.reason === 'empty') return;
      if (plan.block.reason === 'project-loading') {
        toast.info('Projects are still loading. Try again in a moment.');
      } else if (plan.block.reason === 'project-load-error') {
        toast.error('Projects could not be loaded. Remove the +Project token or reload and try again.');
      } else if (plan.block.reason === 'project-not-found') {
        toast.error(`Project “${plan.block.projectName}” was not found. Select it from the +Project suggestions.`);
      } else if (plan.block.reason === 'destination-required') {
        setShowModal(true);
      }
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await submitQuickAdd({
        getToday: getLocalToday,
        onMyDayItemAdded: (item) => {
          window.dispatchEvent(new CustomEvent('mission-control:my-day-item-added', {
            detail: item,
          }));
        },
        onMyDayAddFailed: (taskId, status) => {
          taskLogger.error('Failed to add task to My Day', { taskId, status });
          toast.error('Task created, but it could not be added to My Day.');
        },
      }, {
        plan,
        destination,
        defaultTags: quickAddCtx.defaultTags,
        addToMyDay: myDayActive,
        contextProject: visibleContextProject,
        contextProjectActive,
        parseOptions,
      });
      const createdTaskIds = result.createdTasks.map((task) => task.id);
      const createdTaskPolicies = Object.fromEntries(
        result.createdTasks.map((task) => [task.id, task.editPolicy]),
      );

      if (result.status === 'success') {
        setInput('');
        setCurrentInputParentTaskId(undefined);
        setPendingTasks([]);
        setParsed(null);
        setDismissedCompoundSplitInput(null);
        setCompoundSplitHint(null);
        const myDaySuffix = myDayActive || result.singleTaskMeta?.addToMyDay ? ' · My Day' : '';
        const toastDestSuffix = `${destination.account ? ` · ${destination.account}` : ''}${myDaySuffix}`;
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setInlineToast({
          message: getQuickAddSubmissionMessage(result),
          taskIds: createdTaskIds,
          editPolicies: createdTaskPolicies,
          destSuffix: toastDestSuffix,
          singleTaskMeta: result.singleTaskMeta,
          suggestionStatus: createdTaskIds.length === 1 ? 'loading' : undefined,
        });
        if (createdTaskIds.length !== 1) {
          scheduleInlineToastDismiss(6000);
        }
        onTaskAdded?.();
        window.dispatchEvent(new CustomEvent('mission-control:task-added'));

        if (createdTaskIds.length === 1) {
          const cleanTitle = result.singleTaskMeta?.title ?? plan.tasks[0].text;
          const nlpHints = parseNlpHints(cleanTitle, cachedTags);
          if (nlpHints) {
            setInlineToast(prev => prev && prev.taskIds[0] === createdTaskIds[0]
              ? { ...prev, suggestions: nlpHints, suggestionStatus: 'loading' }
              : prev
            );
          }

          void loadQuickAddSuggestions(createdTaskIds[0], nlpHints);
        }
      } else {
        if (result.retryTasks.length > 0) {
          const retryTasks = result.retryTasks.map((task) => ({
            ...task,
            id: `pending-task-${nextPendingTaskIdRef.current++}`,
          }));
          const lastRetryTask = retryTasks[retryTasks.length - 1];
          const canMoveLastTaskToInput = lastRetryTask.parentIndex === null
            && !lastRetryTask.parentTaskId
            && !retryTasks.some((task) => task.parentIndex === retryTasks.length - 1);
          setPendingTasks(canMoveLastTaskToInput ? retryTasks.slice(0, -1) : retryTasks);
          setInput(canMoveLastTaskToInput ? lastRetryTask.text : '');
          setCurrentInputParentTaskId(
            canMoveLastTaskToInput ? lastRetryTask.parentTaskId : undefined,
          );
        } else {
          setInput('');
          setCurrentInputParentTaskId(undefined);
          setPendingTasks([]);
        }
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setInlineToast({
          message: getQuickAddSubmissionMessage(result),
          taskIds: [],
          editPolicies: {},
        });
        toastTimerRef.current = setTimeout(() => setInlineToast(null), 5000);
        if (result.createdTasks.length > 0) {
          onTaskAdded?.();
          window.dispatchEvent(new CustomEvent('mission-control:task-added'));
        }
      }
    } catch (err) {
      taskLogger.error('Failed to add task', { err });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    cachedProjects,
    cachedTags,
    contextProjectActive,
    currentInputParentTaskId,
    dismissedCompoundSplitInput,
    destination,
    input,
    isSubmitting,
    loadQuickAddSuggestions,
    myDayActive,
    onTaskAdded,
    pendingTasks,
    projectsLoadState,
    quickAddCtx.defaultTags,
    quickAddCtx.listFilter,
    quickAddCtx.listFilterName,
    quickAddPreferences,
    scheduleInlineToastDismiss,
    visibleContextProject,
  ]);

  // After typeahead acceptance clears the dropdown, auto-submit if flagged
  useEffect(() => {
    if (submitAfterTypeaheadRef.current && !listTypeahead) {
      submitAfterTypeaheadRef.current = false;
      handleSubmit();
    }
  }, [listTypeahead, handleSubmit]);

  const commitCurrentInputToPending = useCallback(() => {
    const normalized = normalizePendingTaskText(input);
    if (!normalized) return false;
    setPendingTasks(prev => [...prev, {
      id: `pending-task-${nextPendingTaskIdRef.current++}`,
      text: normalized,
      parentIndex: null,
      parentTaskId: currentInputParentTaskId,
      isComplete: false,
    }]);
    setInput('');
    setCurrentInputParentTaskId(undefined);
    setParsed(null);
    return true;
  }, [currentInputParentTaskId, input]);

  const handlePendingTaskEdit = useCallback((taskId: string) => {
    const selectedTask = pendingTasks.find(task => task.id === taskId);
    if (!selectedTask) return;

    const currentInput = normalizePendingTaskText(input);
    setPendingTasks(prev => {
      const removedIndex = prev.findIndex(task => task.id === taskId);
      let updated = prev.filter(task => task.id !== taskId);
      // Promote orphaned subtasks whose parent was the removed task
      updated = updated.map(task => {
        if (task.parentIndex === removedIndex) {
          return { ...task, parentIndex: null };
        }
        // Shift indices for items after the removed one
        if (task.parentIndex !== null && task.parentIndex > removedIndex) {
          return { ...task, parentIndex: task.parentIndex - 1 };
        }
        return task;
      });
      if (currentInput) {
        updated.push({
          id: `pending-task-${nextPendingTaskIdRef.current++}`,
          text: currentInput,
          parentIndex: null,
          parentTaskId: currentInputParentTaskId,
          isComplete: false,
        });
      }
      return updated;
    });
    setInput(selectedTask.text);
    setCurrentInputParentTaskId(selectedTask.parentTaskId);
    setShouldRefocusInput(true);
  }, [currentInputParentTaskId, input, pendingTasks]);

  const handlePendingTaskDelete = useCallback((taskId: string) => {
    setPendingTasks(prev => {
      const removedIndex = prev.findIndex(task => task.id === taskId);
      // Remove the task and any subtasks that reference it as parent
      let updated = prev.filter(task => task.id !== taskId && task.parentIndex !== removedIndex);
      // Shift parentIndex for remaining items after the removed index
      updated = updated.map(task => {
        if (task.parentIndex !== null && task.parentIndex > removedIndex) {
          return { ...task, parentIndex: task.parentIndex - 1 };
        }
        return task;
      });
      return updated;
    });
  }, []);

  const handleInputChange = useCallback((nextInput: string) => {
    const { committed, remaining } = extractPendingTasksForTyping(nextInput);
    setDismissedTypeahead((current) => {
      if (!current) return null;
      const previousTriggerStart = getQuickAddTypeaheadTriggerStart(input, current.kind);
      const nextTriggerStart = getQuickAddTypeaheadTriggerStart(remaining, current.kind);
      return previousTriggerStart === current.triggerStart
        && nextTriggerStart === current.triggerStart
        ? current
        : null;
    });
    if (committed.length > 0) {
      setPendingTasks(prev => {
        const baseOffset = prev.length;
        return [
          ...prev,
          ...committed.map((task) => ({
            id: `pending-task-${nextPendingTaskIdRef.current++}`,
            text: task.text,
            parentIndex: task.parentIndex !== null ? task.parentIndex + baseOffset : null,
            isComplete: task.isComplete,
          })),
        ];
      });
    }
    setInput(remaining);

    // Detect compound task pattern for hint (but don't auto-split)
    if (!remaining.includes('\n') && !remaining.includes(';;')) {
      const normalizedRemaining = normalizePendingTaskText(remaining);
      if (normalizedRemaining === dismissedCompoundSplitInput) {
        setCompoundSplitHint(null);
      } else {
        setDismissedCompoundSplitInput(null);
        setCompoundSplitHint(splitCompoundTask(remaining));
      }
    } else {
      setDismissedCompoundSplitInput(null);
      setCompoundSplitHint(null);
    }
  }, [dismissedCompoundSplitInput, input]);

  const keepCompoundInputAsOneTask = useCallback(() => {
    setDismissedCompoundSplitInput(normalizePendingTaskText(input));
    setCompoundSplitHint(null);
    inputHandleRef.current?.focus();
  }, [input]);

  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    // When template typeahead is open, arrow keys navigate and Enter/Tab select
    if (templateTypeahead) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setTemplateTypeaheadIndex(i => Math.min(i + 1, templateTypeahead.matches.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setTemplateTypeaheadIndex(i => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptTemplateTypeahead(templateTypeahead.matches[templateTypeaheadIndex]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissTypeahead('template');
        return true;
      }
      return false;
    }

    // When list typeahead is open, arrow keys navigate and Enter/Tab select
    if (listTypeahead) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setListTypeaheadIndex(i => Math.min(i + 1, listTypeahead.matches.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setListTypeaheadIndex(i => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // On Enter (not Tab), also submit if there's task text beyond the /command
        if (e.key === 'Enter') {
          const textWithoutSlash = input.replace(/(?:^|\s)\/\S*$/, '').trim();
          if (textWithoutSlash || pendingTasks.length > 0) {
            submitAfterTypeaheadRef.current = true;
          }
        }
        acceptListTypeahead(listTypeahead.matches[listTypeaheadIndex]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissTypeahead('list');
        return true;
      }
      return false;
    }

    // When tag typeahead is open, arrow keys navigate and Enter/Tab select
    if (tagTypeahead) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setTagTypeaheadIndex(i => Math.min(i + 1, tagTypeahead.matches.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setTagTypeaheadIndex(i => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptTagTypeahead(tagTypeahead.matches[tagTypeaheadIndex]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissTypeahead('tag');
        return true;
      }
      return false;
    }

    if (projectTypeahead) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setProjectTypeaheadIndex(i => Math.min(i + 1, projectTypeahead.matches.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setProjectTypeaheadIndex(i => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptProjectTypeahead(projectTypeahead.matches[projectTypeaheadIndex]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissTypeahead('project');
        return true;
      }
      return false;
    }

    // When priority typeahead is open, arrow keys navigate and Enter/Tab select
    if (priorityTypeahead) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPriorityTypeaheadIndex(i => Math.min(i + 1, priorityTypeahead.matches.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPriorityTypeaheadIndex(i => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptPriorityTypeahead(priorityTypeahead.matches[priorityTypeaheadIndex]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissTypeahead('priority');
        return true;
      }
      return false;
    }

    // When effort typeahead is open, arrow keys navigate and Enter/Tab select
    if (effortTypeahead) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setEffortTypeaheadIndex(i => Math.min(i + 1, effortTypeahead.matches.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setEffortTypeaheadIndex(i => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptEffortTypeahead(effortTypeahead.matches[effortTypeaheadIndex]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissTypeahead('effort');
        return true;
      }
      return false;
    }

    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      return commitCurrentInputToPending();
    }

    // Backspace on empty input: pop last pending chip back into the input for editing
    if (e.key === 'Backspace' && !input && pendingTasks.length > 0) {
      e.preventDefault();
      const lastTask = pendingTasks[pendingTasks.length - 1];
      setPendingTasks(prev => prev.slice(0, -1));
      setInput(lastTask.text);
      setCurrentInputParentTaskId(lastTask.parentTaskId);
      setDismissedCompoundSplitInput(null);
      setCompoundSplitHint(null);
      return true;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
      return true;
    } else if (e.key === 'N' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      setShowModal(true);
      return true;
    } else if (e.key === 'Escape') {
      setInput('');
      setCurrentInputParentTaskId(undefined);
      setDismissedCompoundSplitInput(null);
      setCompoundSplitHint(null);
      inputHandleRef.current?.blur();
      return true;
    }
    return false;
  }, [templateTypeahead, templateTypeaheadIndex, setTemplateTypeaheadIndex, acceptTemplateTypeahead, listTypeahead, listTypeaheadIndex, acceptListTypeahead, tagTypeahead, tagTypeaheadIndex, acceptTagTypeahead, projectTypeahead, projectTypeaheadIndex, acceptProjectTypeahead, priorityTypeahead, priorityTypeaheadIndex, acceptPriorityTypeahead, effortTypeahead, effortTypeaheadIndex, acceptEffortTypeahead, dismissTypeahead, input, pendingTasks, commitCurrentInputToPending, handleSubmit]);

  const inlineToastPolicies = inlineToast?.taskIds
    .map((taskId) => inlineToast.editPolicies[taskId])
    .filter((policy): policy is TaskEditPolicy => Boolean(policy)) ?? [];
  const undoBlockedPolicy = inlineToastPolicies.find((policy) => !canRemoveTask(policy));
  const undoBlockedReason = undoBlockedPolicy?.removalReason
    ?? (inlineToast && inlineToastPolicies.length !== inlineToast.taskIds.length
      ? 'Removal policy is unavailable for one or more created tasks'
      : undefined);
  const suggestionBlockedReasons = (() => {
    const reasons: Partial<Record<'priority' | 'effort' | 'tags' | 'projects' | 'phases', string>> = {};
    if (!inlineToast?.suggestions || inlineToast.taskIds.length !== 1) return reasons;
    const policy = inlineToast.editPolicies[inlineToast.taskIds[0]];
    const fields: Array<'priority' | 'effort' | 'tags' | 'projects' | 'phases'> = [];
    if (inlineToast.suggestions.priority) fields.push('priority');
    if (inlineToast.suggestions.effort) fields.push('effort');
    if (inlineToast.suggestions.tags.length > 0) fields.push('tags');
    if (inlineToast.suggestions.projects.length > 0) fields.push('projects', 'phases');
    fields.forEach((field) => {
      if (!canEditTaskField(policy, field)) {
        reasons[field] = taskFieldBlockedReason(policy, field);
      }
    });
    return reasons;
  })();

  useEffect(() => {
    if (!inlineToast?.suggestions || tagsFetchedRef.current) return;
    tagsFetchedRef.current = true;
    fetch('/api/tags')
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load tags (${response.status})`);
        return response.json();
      })
      .then((data) => setCachedTags(data.tags || []))
      .catch((error) => {
        tagsFetchedRef.current = false;
        taskLogger.error('Failed to load tags for Quick Add suggestions', { error });
      });
  }, [inlineToast?.suggestions]);

  const closeSuggestionReview = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setInlineToast(null);
    setTimeout(() => inputHandleRef.current?.focus(), 0);
  }, []);

  const skipSuggestionReview = useCallback(() => {
    const taskId = inlineToast?.taskIds[0];
    const tags = inlineToast?.suggestions?.tags ?? [];
    if (taskId && tags.length > 0) {
      recordTagRecommendationFeedback({
        surface: 'quick-add',
        action: 'dismissed',
        taskId,
        suggestedTagIds: tags.map((tag) => tag.id),
        acceptedTagIds: [],
        removedTagIds: tags.map((tag) => tag.id),
      });
    }
    closeSuggestionReview();
  }, [closeSuggestionReview, inlineToast]);

  const applySuggestionSelection = useCallback(async (
    selection: QuickAddSuggestionSelection,
  ) => {
    const currentToast = inlineToast;
    const taskId = currentToast?.taskIds[0];
    if (!taskId || !currentToast) return;

    const policy = currentToast.editPolicies[taskId];
    const selectedFields: TaskField[] = [];
    if (selection.priority) selectedFields.push('priority');
    if (selection.effort) selectedFields.push('effort');
    if (selection.tagNames.length > 0) selectedFields.push('tags');
    if (selection.projectId) selectedFields.push('projects');
    if (selection.phaseId) selectedFields.push('phases');
    const blockedField = selectedFields.find((field) => !canEditTaskField(policy, field));
    if (blockedField) {
      throw new Error(taskFieldBlockedReason(policy, blockedField));
    }

    setInlineToast((previous) => previous
      ? { ...previous, suggestionsApplying: true }
      : previous);
    try {
      const requests: Promise<Response>[] = [];
      const patch: Record<string, unknown> = {};
      if (selection.priority) patch.priority = selection.priority;
      if (selection.effort) patch.effort = selection.effort;
      if (Object.keys(patch).length > 0) {
        requests.push(fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }));
      }
      if (selection.tagNames.length > 0) {
        requests.push(fetch(`/api/tasks/${taskId}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: selection.tagNames }),
        }));
      }
      if (selection.projectId) {
        requests.push(fetch(`/api/hub-projects/${selection.projectId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            phaseId: selection.phaseId ?? null,
          }),
        }));
      }

      const responses = await Promise.all(requests);
      const failed = responses.find((response) => !response.ok);
      if (failed) {
        const payload = await failed.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? 'Failed to apply suggestions');
      }
      const suggestedTags = currentToast.suggestions?.tags ?? [];
      if (suggestedTags.length > 0) {
        const acceptedNames = new Set(selection.tagNames.map((name) => name.toLowerCase()));
        const acceptedTagIds = suggestedTags
          .filter((tag) => acceptedNames.has(tag.name.toLowerCase()))
          .map((tag) => tag.id);
        recordTagRecommendationFeedback({
          surface: 'quick-add',
          action: 'applied',
          taskId,
          suggestedTagIds: suggestedTags.map((tag) => tag.id),
          acceptedTagIds,
          removedTagIds: suggestedTags
            .filter((tag) => !acceptedTagIds.includes(tag.id))
            .map((tag) => tag.id),
        });
      }

      setInlineToast((previous) => previous
        ? { ...previous, suggestionsApplied: true, suggestionsApplying: false }
        : previous);
      onTaskAdded?.();
      window.dispatchEvent(new CustomEvent('mission-control:task-added'));
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(closeSuggestionReview, 1500);
    } catch (error) {
      setInlineToast((previous) => previous
        ? { ...previous, suggestionsApplying: false }
        : previous);
      const message = error instanceof Error ? error.message : 'Failed to apply suggestions';
      toast.error(message);
    }
  }, [closeSuggestionReview, inlineToast, onTaskAdded]);

  return (
    <>
      <div ref={barRef} className="quick-add-bar relative z-10">
        <div
          className={`relative flex flex-wrap items-center gap-2 rounded-xl border bg-[var(--surface-1)] px-1 py-1 transition-[background-color,border-color,box-shadow] duration-150 ${
            isFocused
              ? 'border-[var(--border-focus)] shadow-[var(--shadow-focus-glow)]'
              : 'border-[var(--border)] shadow-[var(--shadow-sm)]'
          }`}
          style={inlineToast ? {
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
          } : undefined}
        >
          <div className="flex w-full min-w-0 items-center gap-2">
          {/* Overflow actions menu */}
          <div ref={plusMenuRef} className="relative shrink-0">
            <Tooltip content="More actions">
              <button
                type="button"
                onClick={() => {
                  setShowPlusMenu(!showPlusMenu);
                }}
                className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
                  showPlusMenu
                    ? 'bg-[var(--accent-900)] text-[var(--accent-400)]'
                    : 'text-blue-400 hover:text-blue-300 hover:bg-[var(--surface-2)]'
                }`}
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={showPlusMenu}
              >
                <Ellipsis size={17} />
              </button>
            </Tooltip>
            <AnimatePresence>
              {showPlusMenu && (
                <motion.div
                  variants={dropdownVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  role="menu"
                  className="absolute left-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--surface-1)] shadow-lg py-1"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowPlusMenu(false);
                      setShowTemplatePicker(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <FileText size={13} className="text-[var(--text-muted)]" />
                    <span>Template</span>
                    <span className="ml-auto text-xs text-[var(--text-muted)]">Ctrl+Shift+T</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowPlusMenu(false);
                      setShowModal(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <Maximize2 size={13} className="text-[var(--text-muted)]" />
                    <span>Expanded form</span>
                    <span className="ml-auto text-xs text-[var(--text-muted)]">Ctrl+Shift+N</span>
                  </button>
                  <div className="my-1 h-px bg-[var(--border-subtle)]" />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    onClick={() => {
                      setMyDayActive(active => !active);
                      setShowPlusMenu(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
                    aria-checked={myDayActive}
                  >
                    <Sun size={13} className={myDayActive ? 'text-amber-300' : 'text-[var(--text-muted)]'} />
                    <span>{myDayActive ? 'Remove from My Day' : 'Add to My Day'}</span>
                    {myDayActive && <Check size={13} className="ml-auto text-amber-300" />}
                  </button>
                  {visibleContextProject && (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      onClick={() => {
                        setContextProjectActive(active => !active);
                        setShowPlusMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
                      aria-checked={contextProjectActive}
                    >
                      <GitBranch size={13} className={contextProjectActive ? 'text-pink-300' : 'text-[var(--text-muted)]'} />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {contextProjectActive ? 'Remove from' : 'Add to'} {visibleContextProject.name}
                      </span>
                      {contextProjectActive && <Check size={13} className="shrink-0 text-pink-300" />}
                    </button>
                  )}
                  {voiceSupported && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (isVoiceActive) {
                          voiceStop();
                        } else {
                          voiceStart();
                        }
                        setShowPlusMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
                    >
                      {isVoiceActive
                        ? <Square size={13} className="fill-current text-red-400" />
                        : <Mic size={13} className="text-[var(--text-muted)]" />}
                      <span>{isVoiceActive ? 'Stop dictation' : 'Dictate task'}</span>
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
            <TemplatePicker
              open={showTemplatePicker}
              onClose={() => setShowTemplatePicker(false)}
              onSelectSingle={handleSelectSingleTemplate}
              onSelectWorkflow={handleSelectWorkflowTemplate}
              anchor="left"
            />
          </div>

          <div ref={pendingChipsRef} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {pendingTasks.map((task) => (
              <div
                key={task.id}
                className={`inline-flex max-w-full items-center gap-1 rounded-lg border px-2.5 py-1 text-xs ${
                  isPendingSubtask(task)
                    ? 'ml-3 border-purple-800/30 bg-purple-900/20 text-purple-200'
                    : task.isComplete
                      ? 'border-green-800/30 bg-green-900/20 text-green-200 line-through opacity-70'
                      : 'border-blue-800/30 bg-blue-900/20 text-blue-200'
                }`}
              >
                <Tooltip content={isPendingSubtask(task) ? 'Edit pending subtask' : 'Edit pending task'}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handlePendingTaskEdit(task.id);
                    }}
                    className="max-w-[240px] truncate text-left hover:text-white"
                  >
                    <span className="mr-1">{isPendingSubtask(task) ? '↳' : task.isComplete ? <CheckSquare size={12} className="inline" /> : <Check size={12} className="inline" />}</span>
                    {task.text}
                  </button>
                </Tooltip>
                <Tooltip content={isPendingSubtask(task) ? 'Remove pending subtask' : 'Remove pending task'}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handlePendingTaskDelete(task.id);
                    }}
                    className={`transition-colors hover:text-white ${
                      isPendingSubtask(task)
                        ? 'text-purple-300'
                        : task.isComplete
                          ? 'text-green-300'
                          : 'text-blue-300'
                    }`}
                    aria-label={`Remove pending ${isPendingSubtask(task) ? 'subtask' : 'task'} ${task.text}`}
                  >
                    ×
                  </button>
                </Tooltip>
              </div>
            ))}

            <TokenInput
              handleRef={inputHandleRef}
              value={input}
              onChange={handleInputChange}
              naturalLanguageDates={quickAddPreferences.naturalLanguageDates}
              projects={cachedProjects}
              metadata={activeInputMetadata}
              onFocus={() => {
                setIsFocused(true);
                // When a list filter is active, pre-select that list as destination (no text prefix needed)
                if (!input && quickAddCtx.listFilterName && quickAddCtx.listFilter) {
                  const listDest = destinations.find(d =>
                    d.listName && d.listName === quickAddCtx.listFilterName
                  );
                  if (listDest) {
                    selectDestination(listDest, { manual: true });
                  }
                }
              }}
              onBlur={() => setIsFocused(false)}
              onKeyDown={handleKeyDown}
              disableEscapeToken={Boolean(
                templateTypeahead
                || listTypeahead
                || tagTypeahead
                || projectTypeahead
                || priorityTypeahead
                || effortTypeahead
              )}
              placeholder={
                quickAddCtx.placeholderOverride
                  ? quickAddCtx.placeholderOverride
                  : visibleContextProject && contextProjectActive
                    ? `Add task to ${visibleContextProject.name}...`
                  : destination.listName
                    ? `Add task to ${destination.listName}...`
                    : destination.listSelectionMode === 'required' && !destination.listId
                      ? `Add task to ${destination.shortLabel ?? destination.label} (pick a ${destination.connectorType === 'github-issues' ? 'repo' : 'list'} with /name)...`
                      : quickAddCtx.sourceFilter
                        ? `Add task to ${destination.shortLabel ?? destination.label}...`
                        : 'Add a task... (t/ for templates)'
              }
              className="quick-add-input min-w-0"
            />
          </div>

          {/* Actions */}
          <div className="quick-add-actions flex shrink-0 items-center gap-1 pr-1">
            {/* Voice input toggle */}
            {voiceSupported && (
              <div className="quick-add-secondary-voice">
                <Tooltip content={isVoiceActive ? 'Stop dictation' : 'Dictate task'}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (isVoiceActive) {
                        voiceStop();
                      } else {
                        voiceStart();
                      }
                    }}
                    aria-label={
                      isVoiceListening
                        ? 'Stop voice input'
                        : isVoiceStarting
                          ? 'Cancel voice input'
                          : 'Start voice input'
                    }
                    className={cn(
                      'inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors',
                      isVoiceActive
                        ? 'text-red-400 bg-red-500/10 border border-red-500/30 animate-pulse'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                    )}
                  >
                    {isVoiceActive ? <Square size={13} className="fill-current" /> : <Mic size={13} />}
                  </button>
                </Tooltip>
              </div>
            )}

            {/* My Day pill — shown when addToMyDay is active, toggleable */}
            <div className="quick-add-secondary-my-day">
              {myDayActive && (
                <Tooltip content="Remove from My Day">
                  <button
                    type="button"
                    onClick={() => setMyDayActive(false)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-amber-900/30 text-amber-300 border border-amber-700/40 hover:bg-amber-900/50 transition-colors"
                  >
                    <Sun size={12} />
                    <span>My Day</span>
                    <span className="text-amber-400/60 ml-0.5">×</span>
                  </button>
                </Tooltip>
              )}
              {!myDayActive && isFocused && (
                <Tooltip content="Add to My Day">
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setMyDayActive(true);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-[var(--text-muted)] hover:text-amber-300 hover:bg-amber-900/20 border border-transparent hover:border-amber-700/30 transition-colors"
                  >
                    <Sun size={12} />
                    <span>My Day</span>
                  </button>
                </Tooltip>
              )}
            </div>

            {visibleContextProject && (
              <div className="quick-add-secondary-project">
                <QuickAddProjectControl
                  project={visibleContextProject}
                  active={contextProjectActive}
                  onActiveChange={setContextProjectActive}
                />
              </div>
            )}

            {/* Expand to full form — shown when focused with text */}
            {isFocused && input.trim() && !listTypeahead && !templateTypeahead && !tagTypeahead && !priorityTypeahead && !effortTypeahead && (
              <div className="quick-add-secondary-expand">
                <Tooltip content="Expanded form (Ctrl+Shift+N)">
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setShowModal(true);
                    }}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                    aria-label="Open expanded form"
                  >
                    <Maximize2 size={13} />
                  </button>
                </Tooltip>
              </div>
            )}

            {/* Destination pill */}
            <motion.button
              ref={destPillRef}
              onClick={() => setShowDestPicker(!showDestPicker)}
              className="quick-add-destination inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-3)] transition-colors"
              animate={pillFlash ? { scale: [1, 1.08, 1], borderColor: ['var(--border)', 'var(--accent)', 'var(--border)'] } : {}}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              title={destination.label}
            >
              <ConnectorIconImg type={destination.connectorType} size={14} />
              <span className="quick-add-destination-label truncate">{destination.shortLabel ?? destination.label}</span>
              <span className="text-[var(--text-muted)]">▾</span>
            </motion.button>

            {/* Submit button (only when there's input) */}
            {(input.trim() || pendingTasks.length > 0) && (
              <button
                onClick={handleSubmit}
                aria-label="Add task"
                disabled={isSubmitting}
                className="flex items-center gap-1 px-3 py-1.5 bg-[var(--accent)] text-white text-xs font-semibold rounded-lg hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
              >
                {isSubmitting ? '...' : '↵ Add'}
              </button>
            )}
          </div>
          </div>

          {/* Compound task split preview — inside bar as a full-width second row */}
          {compoundSplitHint && compoundSplitHint.length >= 2 && !listTypeahead && !templateTypeahead && !tagTypeahead && !projectTypeahead && !priorityTypeahead && !effortTypeahead && (
            <QuickAddSplitPreview
              tasks={compoundSplitHint}
              onKeepAsOneTask={keepCompoundInputAsOneTask}
              className="mx-1 mb-1 basis-full"
            />
          )}
        </div>

        {/* Flying token animation — shows token text moving from input to destination pill */}
        <AnimatePresence>
          {flyingToken && (
            <motion.span
              className="fixed z-[9999] pointer-events-none px-2 py-0.5 rounded text-xs font-medium bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30 whitespace-nowrap"
              initial={{
                left: flyingToken.from.left,
                top: flyingToken.from.top + flyingToken.from.height / 2 - 10,
                opacity: 1,
                scale: 1,
              }}
              animate={{
                left: flyingToken.to.left,
                top: flyingToken.to.top,
                opacity: 0,
                scale: 0.6,
              }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
            >
              /{flyingToken.label}
            </motion.span>
          )}
        </AnimatePresence>

        {/* Parse preview chips (hidden during list/template typeahead) */}
        {isFocused && !listTypeahead && !templateTypeahead && !tagTypeahead && !projectTypeahead && !priorityTypeahead && !effortTypeahead && parsed && (parsed.dueDate || parsed.dateSuggestion || parsed.priority || parsed.tags.length > 0 || parsed.project || parsed.addToMyDay || parsed.estimatedDuration || parsed.effort || parsed.planningHorizon || parsed.recurrence) && (
          <div className="flex items-center gap-2 mt-1.5 px-3 text-xs">
            <Sparkles size={12} className="text-blue-400" />
            {parsed.dueDateLabel && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-900/30 text-green-300 border border-green-800/30">
                <Calendar size={12} className="inline" /> {parsed.dueDateLabel}
              </span>
            )}
            {parsed.dateSuggestion && (
              <span className="inline-flex items-center gap-1 rounded border border-green-800/30 bg-green-900/20 px-2 py-0.5 text-green-300">
                <Calendar size={12} /> {parsed.dateSuggestion.label}
              </span>
            )}
            {parsed.priority && (
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${getTaskPriorityVisual(parsed.priority).badgeClass}`}>
                {parsed.priority === 'critical' ? <Flame size={11} /> : parsed.priority === 'high' ? <AlertCircle size={11} /> : <AlertCircle size={11} />} {parsed.priority}
              </span>
            )}
            {parsed.estimatedDuration && (
              <span className="inline-flex items-center gap-1 rounded border border-blue-800/30 bg-blue-900/30 px-2 py-0.5 text-blue-300 tabular-nums">
                <Clock size={11} /> {parsed.estimatedDuration >= 60 ? `${parsed.estimatedDuration / 60}h` : `${parsed.estimatedDuration}m`}
              </span>
            )}
            {parsed.effort && (
              <span className="inline-flex items-center gap-1 rounded border border-violet-800/30 bg-violet-900/30 px-2 py-0.5 text-violet-300 tabular-nums">
                ^{parsed.effort}
              </span>
            )}
            {parsed.planningHorizon && (
              <span className="inline-flex items-center gap-1 rounded border border-emerald-800/30 bg-emerald-900/30 px-2 py-0.5 text-emerald-300">
                ~{parsed.planningHorizon}
              </span>
            )}
            {parsed.recurrenceLabel && (
              <span className="inline-flex items-center gap-1 rounded border border-cyan-800/30 bg-cyan-900/30 px-2 py-0.5 text-cyan-300">
                <Repeat size={11} /> {parsed.recurrenceLabel}
              </span>
            )}
            {parsed.tags.map(tag => (
              <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-900/30 text-purple-300 border border-purple-800/30">
                #{tag}
              </span>
            ))}
            {parsed.project && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-pink-900/30 text-pink-300 border border-pink-800/30">
                +{parsed.project}
              </span>
            )}
            {parsed.addToMyDay && (
              <span className="inline-flex items-center gap-1 rounded border border-amber-800/30 bg-amber-900/30 px-2 py-0.5 text-amber-300">
                <Sun size={11} /> My Day
              </span>
            )}
          </div>
        )}

        {/* Compound task split preview — shown when NLP detects "verb and verb" during typing */}
        {isFocused && compoundSplitHint && compoundSplitHint.length >= 2 && !listTypeahead && !templateTypeahead && !tagTypeahead && !projectTypeahead && !priorityTypeahead && !effortTypeahead && (
          <QuickAddSplitPreview
            tasks={compoundSplitHint}
            onKeepAsOneTask={keepCompoundInputAsOneTask}
            className="mt-1.5"
          />
        )}

        {/* List typeahead dropdown */}
        <AnimatePresence>
          {isFocused && listTypeahead && (
            <motion.div
              className="absolute left-0 right-0 top-full mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] z-50 overflow-hidden"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <div className="px-3 pt-2 pb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center justify-between">
                <span>Select a destination</span>
                <span className="normal-case tracking-normal font-normal">↑↓ navigate · ↵ select</span>
              </div>
              <div ref={listTypeaheadScrollRef} className="max-h-48 overflow-y-auto">
                {listTypeahead.matches.map((dest, i) => {
                  const isActive = i === listTypeaheadIndex;
                  const name = dest.listName || dest.shortLabel || dest.label;
                  // Highlight the matching substring
                  const matchIdx = name.toLowerCase().indexOf(listTypeahead.query);
                  return (
                    <button
                      key={`${dest.id}-${dest.listId}`}
                      data-list-typeahead-index={i}
                      onMouseDown={(e) => {
                        e.preventDefault(); // prevent blur
                        acceptListTypeahead(dest);
                      }}
                      onMouseEnter={() => setListTypeaheadIndex(i)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                        isActive ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                      }`}
                    >
                      <ConnectorIconImg type={dest.connectorType} size={14} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs truncate">
                          {matchIdx >= 0 && listTypeahead.query ? (
                            <>
                              {name.slice(0, matchIdx)}
                              <span className="text-[var(--accent)] font-semibold">{name.slice(matchIdx, matchIdx + listTypeahead.query.length)}</span>
                              {name.slice(matchIdx + listTypeahead.query.length)}
                            </>
                          ) : name}
                        </span>
                        <span className="block text-xs text-[var(--text-muted)] truncate">
                          {dest.listId
                            ? dest.groupName
                              ? `${dest.label} › ${dest.groupName}`
                              : dest.label
                            : 'Use source default'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Template typeahead dropdown */}
        <AnimatePresence>
          {isFocused && templateTypeahead && (
            <motion.div
              className="absolute left-0 right-0 top-full mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] z-50 overflow-hidden"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <div className="px-3 pt-2 pb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center justify-between">
                <span>Select a template</span>
                <span className="normal-case tracking-normal font-normal">↑↓ navigate · ↵ select</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {templateTypeahead.matches.map((template, i) => {
                  const isActive = i === templateTypeaheadIndex;
                  const name = template.name;
                  const matchIdx = name.toLowerCase().indexOf(templateTypeahead.query);
                  return (
                    <button
                      key={template.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptTemplateTypeahead(template);
                      }}
                      onMouseEnter={() => setTemplateTypeaheadIndex(i)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                        isActive ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                      }`}
                    >
                      <FileText size={14} className="flex-shrink-0 text-[var(--text-muted)]" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs truncate">
                          {matchIdx >= 0 && templateTypeahead.query ? (
                            <>
                              {name.slice(0, matchIdx)}
                              <span className="text-[var(--accent)] font-semibold">{name.slice(matchIdx, matchIdx + templateTypeahead.query.length)}</span>
                              {name.slice(matchIdx + templateTypeahead.query.length)}
                            </>
                          ) : name}
                        </span>
                        {template.category && (
                          <span className="block text-xs text-[var(--text-muted)] truncate">{template.category}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Project typeahead dropdown */}
        <AnimatePresence>
          {isFocused && projectTypeahead && (
            <motion.div
              className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--shadow-lg)]"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <div className="flex items-center justify-between px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <span>Assign project</span>
                <span className="font-normal normal-case tracking-normal">↑↓ navigate · ↵ select</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {projectTypeahead.matches.map((project, index) => {
                  const isActive = index === projectTypeaheadIndex;
                  const matchIndex = project.name.toLowerCase().indexOf(projectTypeahead.query);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        acceptProjectTypeahead(project);
                      }}
                      onMouseEnter={() => setProjectTypeaheadIndex(index)}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                        isActive ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                      }`}
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded bg-pink-500/15 text-pink-300">
                        <GitBranch size={12} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {matchIndex >= 0 && projectTypeahead.query ? (
                          <>
                            {project.name.slice(0, matchIndex)}
                            <span className="font-semibold text-[var(--accent)]">
                              {project.name.slice(matchIndex, matchIndex + projectTypeahead.query.length)}
                            </span>
                            {project.name.slice(matchIndex + projectTypeahead.query.length)}
                          </>
                        ) : project.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tag typeahead dropdown */}
        <AnimatePresence>
          {isFocused && tagTypeahead && (
            <motion.div
              className="absolute left-0 right-0 top-full mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] z-50 overflow-hidden"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <div className="px-3 pt-2 pb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center justify-between">
                <span>Select a tag</span>
                <span className="normal-case tracking-normal font-normal">↑↓ navigate · ↵ select</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {tagTypeahead.matches.map((tag, i) => {
                  const isActive = i === tagTypeaheadIndex;
                  const name = tag.name;
                  const matchIdx = name.toLowerCase().indexOf(tagTypeahead.query);
                  return (
                    <button
                      key={tag.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptTagTypeahead(tag);
                      }}
                      onMouseEnter={() => setTagTypeaheadIndex(i)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                        isActive ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                      }`}
                    >
                      <span
                        className="flex-shrink-0 w-3 h-3 rounded-full"
                        style={{ backgroundColor: tag.color || '#c084fc' }}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs truncate">
                          {matchIdx >= 0 && tagTypeahead.query ? (
                            <>
                              {name.slice(0, matchIdx)}
                              <span className="text-[var(--accent)] font-semibold">{name.slice(matchIdx, matchIdx + tagTypeahead.query.length)}</span>
                              {name.slice(matchIdx + tagTypeahead.query.length)}
                            </>
                          ) : name}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Priority typeahead dropdown */}
        <AnimatePresence>
          {isFocused && priorityTypeahead && (
            <motion.div
              className="absolute left-0 right-0 top-full mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] z-50 overflow-hidden"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <div className="px-3 pt-2 pb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center justify-between">
                <span>Set priority</span>
                <span className="normal-case tracking-normal font-normal">↑↓ navigate · ↵ select</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {priorityTypeahead.matches.map((option, i) => {
                  const isActive = i === priorityTypeaheadIndex;
                  return (
                    <button
                      key={option.value}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptPriorityTypeahead(option);
                      }}
                      onMouseEnter={() => setPriorityTypeaheadIndex(i)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                        isActive ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                      }`}
                    >
                      <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${option.dot}`} />
                      <span className="text-xs">{option.label}</span>
                      <span className="ml-auto text-xs text-[var(--text-muted)]">!{option.value}</span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Effort typeahead dropdown */}
        <AnimatePresence>
          {isFocused && effortTypeahead && (
            <motion.div
              className="absolute left-0 right-0 top-full mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-[var(--shadow-lg)] z-50 overflow-hidden"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <div className="px-3 pt-2 pb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center justify-between">
                <span>Set effort</span>
                <span className="normal-case tracking-normal font-normal">↑↓ navigate · ↵ select</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {effortTypeahead.matches.map((option, i) => {
                  const isActive = i === effortTypeaheadIndex;
                  return (
                    <button
                      key={option.value}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptEffortTypeahead(option);
                      }}
                      onMouseEnter={() => setEffortTypeaheadIndex(i)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                        isActive ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                      }`}
                    >
                      <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${option.dot}`} />
                      <span className="text-xs">{option.label}</span>
                      <span className="ml-auto text-xs text-[var(--text-muted)]">^{option.value}</span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <DestinationPicker
          open={showDestPicker}
          destinations={destinations}
          selectedDestination={destination}
          onSelect={(nextDestination) => {
            selectDestination(nextDestination, { manual: true });
            setShowDestPicker(false);
            setInput((current) => current.replace(/^\/\S+\s/, ''));
          }}
          onClose={() => setShowDestPicker(false)}
        />

        {/* Inline toast notification */}
        <AnimatePresence>
          {inlineToast && (
            <motion.div
              className="absolute left-0 right-0 top-full z-50 overflow-hidden rounded-b-[var(--radius-lg)] border border-t-0 border-[var(--border)] bg-[var(--surface-1)] text-sm shadow-[var(--shadow-lg)]"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
            >
              {/* Row 1: task confirmation */}
              <div className="flex items-center gap-3 border-b border-green-500/20 bg-green-950/45 px-3 py-2 text-green-200">
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-green-400">
                  Added
                </span>
                <span className="flex-1 min-w-0">
                  {inlineToast.singleTaskMeta ? (
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="truncate font-semibold">{inlineToast.singleTaskMeta.title}</span>
                      <span className="shrink-0 text-green-300/70 inline-flex items-center gap-1">→ <ConnectorIconImg type={destination.connectorType} size={12} /> {destination.label}</span>
                      {inlineToast.singleTaskMeta.priority && inlineToast.singleTaskMeta.priority !== 'none' && (
                        <span className="shrink-0 text-green-300/70 border border-green-500/30 rounded px-1.5 py-0.5 text-xs">
                          {inlineToast.singleTaskMeta.priority}
                        </span>
                      )}
                      {inlineToast.singleTaskMeta.dueDateLabel && (
                        <span className="shrink-0 text-green-300/70 text-xs">
                          <Calendar size={12} className="inline" /> {inlineToast.singleTaskMeta.dueDateLabel}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <span>{inlineToast.message}</span>
                      <span className="shrink-0 text-green-300/70 inline-flex items-center gap-1">→ <ConnectorIconImg type={destination.connectorType} size={12} /> {destination.label}{inlineToast.destSuffix}</span>
                    </span>
                  )}
                </span>
                {inlineToast.taskIds.length === 1 && (
                  <button
                    className="shrink-0 text-green-300 hover:text-green-100 font-semibold transition-colors"
                    onClick={() => {
                      setViewTaskId(inlineToast.taskIds[0]);
                      setInlineToast(null);
                    }}
                  >
                    View
                  </button>
                )}
                {inlineToast.taskIds.length > 0 && (
                  <button
                    className="shrink-0 text-green-300 hover:text-green-100 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={Boolean(undoBlockedReason)}
                    title={undoBlockedReason}
                    onClick={async () => {
                      try {
                        const result = await undoQuickAddTasks({}, inlineToast.taskIds);
                        if (result.closedConnectorType) {
                          const label = CONNECTOR_LABELS[result.closedConnectorType]
                            || result.closedConnectorType;
                          toast.info(`Undone · closed as not planned on ${label}`, { duration: 4000 });
                        }
                        setInlineToast(null);
                        onTaskAdded?.();
                        window.dispatchEvent(new CustomEvent('mission-control:task-added'));
                      } catch (error) {
                        taskLogger.error('Failed to undo Quick Add submission', { error });
                        toast.error(error instanceof Error
                          ? error.message
                          : 'Undo failed — task could not be removed');
                        setInlineToast(null);
                      }
                    }}
                  >
                    Undo
                  </button>
                )}
              </div>

              {/* Row 2: independently editable suggestion review */}
              <AnimatePresence>
                {inlineToast.suggestionStatus === 'loading' && !inlineToast.suggestions && (
                  <motion.div
                    key="suggestions-loading"
                    className="flex items-center gap-2 bg-[var(--surface-1)] px-3 py-2.5 text-xs text-[var(--text-secondary)]"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <LoaderCircle size={13} className="animate-spin text-amber-300" />
                    <span className="font-medium">Checking for suggestions…</span>
                  </motion.div>
                )}
                {inlineToast.suggestionStatus === 'empty' && (
                  <motion.div
                    key="suggestions-empty"
                    className="flex items-center gap-2 bg-[var(--surface-1)] px-3 py-2.5 text-xs text-[var(--text-muted)]"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Sparkles size={13} className="text-[var(--text-muted)]" />
                    <span>No suggestions for this task</span>
                  </motion.div>
                )}
                {inlineToast.suggestionStatus === 'error' && (
                  <motion.div
                    key="suggestions-error"
                    className="flex items-center gap-2 bg-[var(--surface-1)] px-3 py-2.5 text-xs text-red-300"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <AlertCircle size={13} />
                    <span>Couldn&apos;t check suggestions</span>
                    <button
                      type="button"
                      onClick={() => {
                        const taskId = inlineToast.taskIds[0];
                        if (taskId) {
                          void loadQuickAddSuggestions(taskId, inlineToast.suggestions ?? null);
                        }
                      }}
                      className="ml-auto font-semibold text-amber-300 transition-colors hover:text-amber-100"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={closeSuggestionReview}
                      className="font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    >
                      Dismiss
                    </button>
                  </motion.div>
                )}
                {inlineToast.suggestions && !inlineToast.suggestionsApplied && (
                  <motion.div
                    key="suggestions-review"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <QuickAddSuggestionReview
                      key={[
                        inlineToast.taskIds[0],
                        inlineToast.suggestions.priority?.value,
                        inlineToast.suggestions.effort?.value,
                        inlineToast.suggestions.tags.map((tag) => tag.id).join(','),
                        inlineToast.suggestions.projects.map((project) => project.id).join(','),
                        cachedProjects.length,
                      ].join(':')}
                      suggestion={inlineToast.suggestions}
                      taskTitle={inlineToast.singleTaskMeta?.title ?? ''}
                      projects={cachedProjects}
                      availableTags={cachedTags}
                      blockedReasons={suggestionBlockedReasons}
                      applying={Boolean(inlineToast.suggestionsApplying)}
                      onAvailableTagsChange={setCachedTags}
                      onApply={applySuggestionSelection}
                      onSkip={skipSuggestionReview}
                    />
                  </motion.div>
                )}
                {inlineToast.suggestionsApplied && (
                  <motion.div
                    className="flex items-center gap-2 bg-[var(--surface-1)] px-3 py-2 text-xs text-green-400"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                  >
                    <span><Check size={12} className="inline" /> Applied</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Full modal (Tier 2) — portalled to body so it renders even when parent bar is hidden on mobile */}
      {showModal && createPortal(
        <AnimatePresence>
          <AddTaskModal
            initialInput={modalInput}
            initialParsed={modalParsed}
            initialDestination={destination}
            destinations={destinations}
            initialProjectId={resolveQuickAddProjectId(
              parsed?.projectId ?? null,
              visibleContextProject,
              contextProjectActive,
            )}
            initialListId={quickAddCtx.listFilter || undefined}
            initialTemplateId={selectedTemplateId || undefined}
            initialAddToMyDay={myDayActive}
            prefill={modalPrefill}
            enableQuickAddSemantics={mobileCaptureSemantics}
            onClose={() => {
              if (modalPrefill) {
                setInput('');
                setParsed(null);
              }
              setShowModal(false);
              setModalPrefill(undefined);
              setMobileCaptureSemantics(false);
              setSelectedTemplateId(null);
            }}
            onSubmit={() => {
              setInput('');
              setCurrentInputParentTaskId(undefined);
              setParsed(null);
              setShowModal(false);
              setModalPrefill(undefined);
              setMobileCaptureSemantics(false);
              setSelectedTemplateId(null);
              onTaskAdded?.();
              window.dispatchEvent(new CustomEvent('mission-control:task-added'));
            }}
          />
        </AnimatePresence>,
        document.body
      )}

      {/* Workflow template apply modal */}
      <AnimatePresence>
        {workflowTemplate && (
          <WorkflowApplyModal
            template={workflowTemplate}
            destinations={destinations}
            initialDestination={destination}
            onClose={() => setWorkflowTemplate(null)}
            onApplied={() => {
              setWorkflowTemplate(null);
              onTaskAdded?.();
            }}
          />
        )}
      </AnimatePresence>

      {/* Task detail popover dialog (from toast "View" action) */}
      <AnimatePresence>
        {viewTaskId && (
          <LazyTaskDetailPanel
            taskId={viewTaskId}
            mode="dialog"
            sourceLists={sourceLists}
            onMoveToList={moveViewedTaskToList}
            onClose={() => setViewTaskId(null)}
            onUpdate={() => {
              onTaskAdded?.();
              window.dispatchEvent(new CustomEvent('mission-control:task-added'));
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}