'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import Image from 'next/image';
import { Calendar, Check, CheckSquare, ClipboardList, Flame, AlertCircle, Clock, Search, Repeat, Plus, Maximize2, Sparkles, Sun, GitBranch, Mic, Square } from 'lucide-react';
import { CONNECTOR_COLORS, CONNECTOR_ICON_PATHS, CONNECTOR_LABELS } from '@/lib/constants/colors';
import { cn } from '@/lib/utils';
import { PRIORITY_OPTIONS, PRIORITY_DOT_COLORS, getEffortOptions, DEFAULT_EFFORT_MEASURE } from '@/lib/constants/task-formatting';
import { dropdownVariants } from '@/lib/motion';
import { useListAnimate } from '@/lib/hooks/useListAnimate';
import { parseTaskInput, parseTaskInputForSubmission, ParsedTask } from '@/lib/parse-task-input';
import { extractPendingTasks as extractPendingTasksFromPaste, normalizePendingTaskText as normalizePasteText, splitCompoundTask } from '@/lib/paste-parser';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { Tooltip } from '@/components/ui/Tooltip';
import { AddTaskModal } from './AddTaskModal';
import dynamic from 'next/dynamic';
import type { TokenInputHandle } from './TokenInput';

const TokenInput = dynamic(() => import('./TokenInput').then(mod => mod.TokenInput), { ssr: false });
import { TemplatePicker } from './TemplatePicker';
import { WorkflowApplyModal } from './WorkflowApplyModal';
import type { QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import { parseNlpHints } from '@/lib/parse-nlp-hints';
import { FileText } from 'lucide-react';
import { taskLogger } from '@/lib/client-logger';
import { toast } from 'sonner';
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

const LazyTaskDetailPanel = dynamic(
  () => import('@/components/task-detail/TaskDetailPanel').then(mod => ({ default: mod.TaskDetailPanel })),
  { ssr: false }
);

interface Destination {
  id: string;
  label: string;
  shortLabel: string;
  connectorType: string;
  account: 'personal' | 'work' | null;
  color: string;
  listId?: string;
  listName?: string;
  listSelectionMode?: 'required' | 'optional' | 'not-applicable';
  groupName?: string;
  groupSortOrder?: number;
}

// Fallback destination when no connectors are configured (local-only)
const LOCAL_DESTINATION: Destination = {
  id: 'local',
  label: 'Local',
  shortLabel: 'Local',
  connectorType: 'local',
  account: null,
  color: CONNECTOR_COLORS.local,
};

function ConnectorIconImg({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICON_PATHS[type];
  if (src) {
    return <Image src={src} alt={type} width={size} height={size} className="flex-shrink-0" />;
  }
  // Fallback: lucide icon for unknown connectors
  return <ClipboardList size={size} className="flex-shrink-0 text-[var(--text-muted)]" />;
}

interface DestGroup {
  label: string;
  connectorType?: string;
  destinations: Destination[];
}

interface QuickAddBarProps {
  onTaskAdded?: () => void;
}

export interface VisibleQuickAddProject {
  id: string;
  name: string;
}

export interface QuickAddProjectAffordance {
  ariaLabel: string;
  tooltip: string;
}

export function getVisibleQuickAddProject(
  projectId: string | null,
  projectName: string | null,
): VisibleQuickAddProject | null {
  const name = projectName?.trim();
  return projectId && name ? { id: projectId, name } : null;
}

export function resolveQuickAddProjectId(
  explicitProjectId: string | null,
  contextProject: VisibleQuickAddProject | null,
  contextProjectActive: boolean,
): string | undefined {
  return explicitProjectId || (contextProjectActive ? contextProject?.id : undefined);
}

export function getQuickAddProjectAffordance(
  projectName: string,
  active: boolean,
): QuickAddProjectAffordance {
  if (active) {
    return {
      ariaLabel: `Adding tasks to project ${projectName}. Click to remove.`,
      tooltip: `New tasks will be added to ${projectName}. Click to remove.`,
    };
  }

  return {
    ariaLabel: `Add new tasks to project ${projectName}`,
    tooltip: `Add new tasks to ${projectName}`,
  };
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

export function syncQuickAddProjectActive(
  previousProjectId: string | null,
  nextProjectId: string | null,
  currentActive: boolean,
): boolean {
  return previousProjectId === nextProjectId ? currentActive : Boolean(nextProjectId);
}

interface PendingTask {
  id: string;
  text: string;
  /** Index of the parent task in the pending list (for nested paste). null = top-level. */
  parentIndex: number | null;
  /** Whether the source text indicated completion (e.g. `- [x]`). */
  isComplete: boolean;
}

function normalizePendingTaskText(text: string): string {
  return normalizePasteText(text);
}

function stripTaskListPrefix(line: string): string {
  return line.replace(/^\s*(?:[-•*]|\d+\.)\s+/, '');
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

const EFFORT_LABELS: Record<number, string> = { 1: 'XS', 2: 'S', 3: 'M', 4: 'L', 5: 'XL' };
const SUGGESTION_CONFIDENCE_THRESHOLD = 0.4;

/** Filter a QuickSortSuggestion to only include fields above the confidence threshold. */
function filterSuggestion(s: QuickSortSuggestion): QuickSortSuggestion | null {
  const priority = s.priority && s.priority.confidence >= SUGGESTION_CONFIDENCE_THRESHOLD ? s.priority : null;
  const effort = s.effort && s.effort.confidence >= SUGGESTION_CONFIDENCE_THRESHOLD ? s.effort : null;
  const tags = s.tags.filter(t => t.confidence >= SUGGESTION_CONFIDENCE_THRESHOLD);
  if (!priority && !effort && tags.length === 0) return null;
  return { priority, effort, tags };
}

/**
 * Merge two QuickSortSuggestions.  `override` fields win when present;
 * tags are de-duplicated by id.
 */
function mergeSuggestions(
  base: QuickSortSuggestion | null | undefined,
  override: QuickSortSuggestion | null | undefined,
): QuickSortSuggestion | null {
  if (!base && !override) return null;
  if (!base) return override ?? null;
  if (!override) return base;

  const priority = override.priority ?? base.priority;
  const effort = override.effort ?? base.effort;
  // De-duplicate tags by id AND name, preferring override entries
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const mergedTags: QuickSortSuggestion['tags'] = [];
  for (const t of [...override.tags, ...base.tags]) {
    const nameLower = t.name.toLowerCase();
    if (!seenIds.has(t.id) && !seenNames.has(nameLower)) {
      seenIds.add(t.id);
      seenNames.add(nameLower);
      mergedTags.push(t);
    }
  }

  if (!priority && !effort && mergedTags.length === 0) return null;
  return { priority, effort, tags: mergedTags };
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
  /** Whether suggestion apply is in-flight */
  suggestionsApplying?: boolean;
  /** Whether suggestions were already applied */
  suggestionsApplied?: boolean;
}

export function QuickAddBar({ onTaskAdded }: QuickAddBarProps) {
  const [input, setInput] = useState('');
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const [pendingChipsRef] = useListAnimate({ duration: 150 });
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [destinations, setDestinations] = useState<Destination[]>([LOCAL_DESTINATION]);
  const [destination, setDestination] = useState<Destination>(LOCAL_DESTINATION);
  const [showDestPicker, setShowDestPicker] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inlineToast, setInlineToast] = useState<InlineToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [listTypeaheadIndex, setListTypeaheadIndex] = useState(0);
  // Destination picker search & keyboard nav
  const [destSearch, setDestSearch] = useState('');
  const [destNavIndex, setDestNavIndex] = useState(0);
  const destSearchRef = useRef<HTMLInputElement>(null);
  const destScrollRef = useRef<HTMLDivElement>(null);
  // Animation state for the "flying token" when a list is selected
  const [pillFlash, setPillFlash] = useState(false);
  const [flyingToken, setFlyingToken] = useState<{ label: string; from: DOMRect; to: DOMRect } | null>(null);
  const [shouldRefocusInput, setShouldRefocusInput] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [workflowTemplate, setWorkflowTemplate] = useState<TaskTemplate | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  // Task ID to show in the popover detail dialog (from "View" toast action)
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  // Compound split hint: shown when NLP detects "verb and verb" pattern during typing
  const [compoundSplitHint, setCompoundSplitHint] = useState<string[] | null>(null);
  const [templateTypeaheadIndex, setTemplateTypeaheadIndex] = useState(0);
  const [cachedTemplates, setCachedTemplates] = useState<TaskTemplate[]>([]);
  const templatesFetchedRef = useRef(false);
  // Tag / priority / effort typeahead state
  const [tagTypeaheadIndex, setTagTypeaheadIndex] = useState(0);
  const [priorityTypeaheadIndex, setPriorityTypeaheadIndex] = useState(0);
  const [effortTypeaheadIndex, setEffortTypeaheadIndex] = useState(0);
  const [projectTypeaheadIndex, setProjectTypeaheadIndex] = useState(0);
  const [cachedTags, setCachedTags] = useState<Array<{ id: string; name: string; slug: string; color?: string | null }>>([]);
  const [cachedProjects, setCachedProjects] = useState<QuickAddProject[]>([]);
  const [projectsLoadState, setProjectsLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const tagsFetchedRef = useRef(false);
  const projectsFetchedRef = useRef(false);
  const [quickAddPreferences, setQuickAddPreferencesState] = useState<QuickAddPreferences>(DEFAULT_QUICK_ADD_PREFERENCES);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const inputHandleRef = useRef<TokenInputHandle | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const destPillRef = useRef<HTMLButtonElement>(null);
  const nextPendingTaskIdRef = useRef(0);
  const quickAddCtx = useQuickAddContext();
  // Local toggle for My Day — initialized from context, can be toggled by user
  const [myDayActive, setMyDayActive] = useState(false);
  const visibleContextProject = useMemo(
    () => getVisibleQuickAddProject(quickAddCtx.projectFilter, quickAddCtx.projectFilterName),
    [quickAddCtx.projectFilter, quickAddCtx.projectFilterName],
  );
  const [contextProjectActive, setContextProjectActive] = useState(false);
  const contextProjectIdRef = useRef<string | null>(null);
  // Tracks whether the user manually overrode the destination via the pill picker
  const userOverrodeDestRef = useRef(false);
  // Tracks whether we've already reconciled the destination after list-level destinations loaded
  const reconciledRef = useRef(false);
  // When true, submit the task after the next typeahead acceptance clears the dropdown
  const submitAfterTypeaheadRef = useRef(false);

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

  const parseInput = useCallback((text: string) => parseTaskInput(text, {
    ...quickAddPreferences,
    projects: cachedProjects,
  }), [quickAddPreferences, cachedProjects]);
  const parseInputForSubmit = useCallback((text: string) => parseTaskInputForSubmission(text, {
    ...quickAddPreferences,
    projects: cachedProjects,
  }), [quickAddPreferences, cachedProjects]);
  const modalInput = input.replace(/^\/\S+\s/, '');
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

  // Reset dest search when picker opens/closes
  useEffect(() => {
    if (showDestPicker) {
      setDestSearch('');
      setDestNavIndex(0);
      // Focus search input after animation frame
      requestAnimationFrame(() => destSearchRef.current?.focus());
    }
  }, [showDestPicker]);

  // Build grouped & filtered destination list for the picker
  const destPickerGroups = useMemo((): DestGroup[] => {
    const query = destSearch.toLowerCase().trim();

    // Filter destinations by search query
    const filtered = query
      ? destinations.filter(d => {
          const searchable = [d.shortLabel, d.label, d.listName, d.groupName, d.connectorType]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return searchable.includes(query);
        })
      : destinations;

    // Separate top-level sources (no listId) from list destinations
    const sources = filtered.filter(d => !d.listId);
    const lists = filtered.filter(d => d.listId);

    const groups: DestGroup[] = [];

    // Add top-level sources as their own group
    if (sources.length > 0) {
      groups.push({
        label: 'Sources',
        destinations: [...sources].sort((a, b) => a.shortLabel.localeCompare(b.shortLabel)),
      });
    }

    // Group lists by connector, then by list group within each connector
    const byConnector = new Map<string, Destination[]>();
    for (const d of lists) {
      const key = d.id; // connector instance id
      if (!byConnector.has(key)) byConnector.set(key, []);
      byConnector.get(key)!.push(d);
    }

    for (const [connectorId, connectorLists] of byConnector) {
      // Find the parent source destination for the header label
      const parentSource = destinations.find(d => d.id === connectorId && !d.listId);
      const connectorLabel = parentSource?.shortLabel || connectorId;
      const connectorType = parentSource?.connectorType || connectorLists[0]?.connectorType;

      // Sub-group by listGroup
      const byGroup = new Map<string, Destination[]>();
      const ungrouped: Destination[] = [];
      for (const d of connectorLists) {
        if (d.groupName) {
          if (!byGroup.has(d.groupName)) byGroup.set(d.groupName, []);
          byGroup.get(d.groupName)!.push(d);
        } else {
          ungrouped.push(d);
        }
      }

      // Sort groups by their sortOrder, then alphabetically
      const sortedGroupNames = [...byGroup.keys()].sort((a, b) => {
        const aOrder = byGroup.get(a)![0]?.groupSortOrder ?? Infinity;
        const bOrder = byGroup.get(b)![0]?.groupSortOrder ?? Infinity;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.localeCompare(b);
      });

      // If there are list groups, create sub-grouped entries
      if (sortedGroupNames.length > 0) {
        for (const groupName of sortedGroupNames) {
          const groupDests = [...byGroup.get(groupName)!].sort((a, b) =>
            (a.shortLabel).localeCompare(b.shortLabel)
          );
          groups.push({
            label: `${connectorLabel} › ${groupName}`,
            connectorType,
            destinations: groupDests,
          });
        }
      }

      // Ungrouped lists under this connector
      if (ungrouped.length > 0) {
        const sortedUngrouped = [...ungrouped].sort((a, b) => a.shortLabel.localeCompare(b.shortLabel));
        groups.push({
          label: sortedGroupNames.length > 0 ? `${connectorLabel} › Other` : connectorLabel,
          connectorType,
          destinations: sortedUngrouped,
        });
      }
    }

    return groups;
  }, [destinations, destSearch]);

  // Flat list for keyboard navigation
  const flatPickerDests = useMemo(() =>
    destPickerGroups.flatMap(g => g.destinations),
    [destPickerGroups]
  );

  // Clamp nav index when filtered list changes
  useEffect(() => {
    setDestNavIndex(i => Math.min(i, Math.max(flatPickerDests.length - 1, 0)));
  }, [flatPickerDests.length]);

  // Scroll keyboard-navigated item into view
  useEffect(() => {
    if (!showDestPicker) return;
    const container = destScrollRef.current;
    if (!container) return;
    const item = container.querySelector(`[data-dest-idx="${destNavIndex}"]`);
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [destNavIndex, showDestPicker]);

  // Precompute group start indices for flat keyboard nav
  const groupStartIndices = useMemo(() => {
    const indices: number[] = [];
    let acc = 0;
    for (const g of destPickerGroups) {
      indices.push(acc);
      acc += g.destinations.length;
    }
    return indices;
  }, [destPickerGroups]);

  // Derive typeahead state from input — active when typing `/query` (at start or after a space, no space after it yet)
  const listTypeahead = (() => {
    const match = input.match(/(?:^|\s)\/(\S*)$/); // typing /... at start or after space, no trailing space
    if (!match) return null;
    const query = match[1].toLowerCase();
    const listDests = destinations.filter(d => d.listName);
    if (listDests.length === 0) return null;

    // Substring match: /ideation → acme/ideation, /shop → Shopping
    const matches = query
      ? listDests.filter(d => {
          const name = d.listName!.toLowerCase();
          // Match anywhere in the name, or match each segment individually
          return name.includes(query)
            || name.replace(/[\s/]/g, '-').includes(query);
        })
      : listDests; // Show all lists when just `/` is typed
    return matches.length > 0 ? { query, matches } : null;
  })();

  // Derive template typeahead state — active when typing `t/query`
  const templateTypeahead = useMemo(() => {
    const match = input.match(/(?:^|\s)t\/(\S*)$/);
    if (!match) return null;
    const query = match[1].toLowerCase();
    if (cachedTemplates.length === 0) return null;

    const matches = query
      ? cachedTemplates.filter(t => t.name.toLowerCase().includes(query))
      : cachedTemplates;
    return matches.length > 0 ? { query, matches } : null;
  }, [input, cachedTemplates]);

  // Fetch templates lazily when t/ typeahead activates
  useEffect(() => {
    if (!templateTypeahead && !input.match(/(?:^|\s)t\/$/)) return;
    if (templatesFetchedRef.current) return;
    templatesFetchedRef.current = true;
    fetch('/api/subtask-templates')
      .then(r => r.json())
      .then(data => setCachedTemplates(data.templates || []))
      .catch(() => {});
  }, [input, templateTypeahead]);

  // Reset template typeahead index when matches change
  useEffect(() => {
    setTemplateTypeaheadIndex(0);
  }, [templateTypeahead?.query]);

  // Accept a template typeahead selection
  const acceptTemplateTypeahead = useCallback((template: TaskTemplate) => {
    // Strip the t/slug portion from input
    const cleaned = input.replace(/(?:^|\s)t\/\S*$/, '').trim();
    setInput(template.name);
    setParsed(parseInput(template.name));
    setSelectedTemplateId(template.id);
    setShowModal(true);
    if (inputHandleRef.current) {
      inputHandleRef.current.setText(template.name);
    }
  }, [input, parseInput]);

  // ── Tag typeahead: active when typing `#query` ───────────────────────────
  const tagTypeahead = useMemo(() => {
    const match = input.match(/(?:^|\s)#([a-zA-Z0-9_:./-]*)$/);
    if (!match) return null;
    const query = match[1].toLowerCase();
    if (cachedTags.length === 0 && query === '') return null; // nothing fetched yet, don't show empty

    const matches = query
      ? cachedTags.filter(t => t.name.toLowerCase().includes(query) || t.slug.includes(query))
      : cachedTags;
    return matches.length > 0 ? { query, matches } : null;
  }, [input, cachedTags]);

  // Fetch tags lazily when # typeahead activates
  useEffect(() => {
    if (!tagTypeahead && !input.match(/(?:^|\s)#$/)) return;
    if (tagsFetchedRef.current) return;
    tagsFetchedRef.current = true;
    fetch('/api/tags')
      .then(r => r.json())
      .then(data => setCachedTags(data.tags || []))
      .catch(() => {});
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

  const projectTypeahead = useMemo(() => {
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

  useEffect(() => {
    if (projectsFetchedRef.current) return;
    projectsFetchedRef.current = true;
    fetch('/api/hub-projects')
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

  const priorityTypeahead = useMemo(() => {
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

  const effortTypeahead = useMemo(() => {
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

  // Reset manual override and reconciliation flag when the page-level filter actually changes (new user intent)
  useEffect(() => {
    userOverrodeDestRef.current = false;
    reconciledRef.current = false;
  }, [quickAddCtx.sourceFilter, quickAddCtx.listFilter]);

  useEffect(() => {
    if (!shouldRefocusInput) return;
    inputHandleRef.current?.focus();
    setShouldRefocusInput(false);
  }, [shouldRefocusInput]);

  // Sync destination from page-level filter context (source/list filters)
  // Uses a ref to read destinations without depending on its array reference
  const destinationsRef = useRef(destinations);
  destinationsRef.current = destinations;
  // User-configured default capture destination (fetched from settings)
  const [defaultCaptureDest, setDefaultCaptureDest] = useState<{ connectorType: string; sourceListId?: string } | null>(null);

  // Fetch user's configured default capture destination
  useEffect(() => {
    fetch('/api/settings/capture-destination')
      .then(r => r.json())
      .then(data => {
        if (data.destination) {
          setDefaultCaptureDest(data.destination);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (userOverrodeDestRef.current) return; // user manually picked — don't override
    const dests = destinationsRef.current;
    if (dests.length <= 1) return; // still loading

    if (quickAddCtx.listFilter && quickAddCtx.listFilterConnectorType) {
      const listDest = dests.find(
        d => d.listId === quickAddCtx.listFilter && d.connectorType === quickAddCtx.listFilterConnectorType
      );
      if (listDest) {
        setDestination(listDest);
        return;
      }
      const sourceDest = dests.find(
        d => d.connectorType === quickAddCtx.listFilterConnectorType && !d.listId
      );
      if (sourceDest) setDestination(sourceDest);
    } else if (quickAddCtx.sourceFilter) {
      const sourceDest = dests.find(
        d => d.connectorType === quickAddCtx.sourceFilter && !d.listId
      );
      if (sourceDest) setDestination(sourceDest);
    } else if (defaultCaptureDest) {
      // No context filter active — fall back to user-configured default
      const defaultDest = defaultCaptureDest.sourceListId
        ? dests.find(d => d.connectorType === defaultCaptureDest.connectorType && d.listId === defaultCaptureDest.sourceListId)
        : dests.find(d => d.connectorType === defaultCaptureDest.connectorType && !d.listId);
      if (defaultDest) setDestination(defaultDest);
    }
  }, [quickAddCtx.sourceFilter, quickAddCtx.listFilter, quickAddCtx.listFilterConnectorType, defaultCaptureDest]);

  // Load available destinations from feature flags
  useEffect(() => {
    let cancelled = false;
    const abortController = new AbortController();

    fetch('/api/features', { signal: abortController.signal })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.taskDestinations && data.taskDestinations.length > 0) {
          const dynamicDests: Destination[] = data.taskDestinations.map((td: { id: string; type: string; name: string; account?: string; listSelectionMode?: string }) => {
            const account = (td.account as 'personal' | 'work') || null;
            return {
              id: td.id,
              label: td.name,
              shortLabel: td.name,
              connectorType: td.type,
              account,
              color: CONNECTOR_COLORS[td.type] || 'var(--text-muted)',
              listSelectionMode: (td.listSelectionMode as Destination['listSelectionMode']) || undefined,
            };
          });
          // Always include local as a fallback
          dynamicDests.push(LOCAL_DESTINATION);
          setDestinations(dynamicDests);
          // Apply user-configured default if available; otherwise first connector
          const cfg = defaultCaptureDest;
          const defaultDest = cfg
            ? dynamicDests.find(d => d.connectorType === cfg.connectorType && !d.listId)
            : null;
          setDestination(defaultDest || dynamicDests[0]);

          // Load source lists for quick-add-to-list (/ prefix)
          for (const td of data.taskDestinations) {
            fetch(`/api/connectors/${td.id}/lists`, { signal: abortController.signal })
              .then(r => r.ok ? r.json() : { sourceLists: [] })
              .then(listData => {
                if (cancelled) return;
                const lists = listData.sourceLists || listData.lists || [];
                const groups: Array<{ id: string; name: string; sortOrder: number }> = listData.groups || [];
                const groupMap = new Map(groups.map(g => [g.id, g]));
                if (lists.length) {
                  setDestinations(prev => {
                    const listDests: Destination[] = lists.map((l: { sourceId: string; name: string; groupId?: string; sortOrder?: number }) => {
                      const group = l.groupId ? groupMap.get(l.groupId) : undefined;
                      return {
                        id: td.id,
                        label: `${td.name} › ${l.name}`,
                        shortLabel: l.name,
                        connectorType: td.type,
                        account: (td.account as 'personal' | 'work') || null,
                        color: CONNECTOR_COLORS[td.type] || 'var(--text-muted)',
                        listId: l.sourceId,
                        listName: l.name,
                        listSelectionMode: (td.listSelectionMode as Destination['listSelectionMode']) || undefined,
                        groupName: group?.name,
                        groupSortOrder: group?.sortOrder,
                      };
                    });
                    // Deduplicate by listId to prevent strict-mode double-appends
                    const existingListIds = new Set(prev.filter(d => d.listId).map(d => `${d.id}-${d.listId}`));
                    const newDests = listDests.filter(d => !existingListIds.has(`${d.id}-${d.listId}`));
                    return newDests.length > 0 ? [...prev, ...newDests] : prev;
                  });
                }
              })
              .catch((err) => { taskLogger.error('Failed to fetch available lists', { err }); });
          }
        }
      })
      .catch((err) => { taskLogger.error('Failed to fetch connectors for quick add', { err }); });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, []);

  // Reconcile destination when list-level destinations arrive after the filter context was already set.
  // The context sync effect only runs on filter changes, but if lists load late we need one extra pass.
  useEffect(() => {
    // Only reconcile once, and only if we haven't manually overridden
    if (reconciledRef.current || userOverrodeDestRef.current) return;
    const hasListDests = destinations.some(d => d.listId);
    if (!hasListDests) return;
    // If a list filter is active and our current destination doesn't match, fix it
    if (quickAddCtx.listFilter && quickAddCtx.listFilterConnectorType) {
      const listDest = destinations.find(
        d => d.listId === quickAddCtx.listFilter && d.connectorType === quickAddCtx.listFilterConnectorType
      );
      if (listDest && (destination.listId !== listDest.listId || destination.connectorType !== listDest.connectorType)) {
        setDestination(listDest);
      }
      // Only mark reconciled if we actually found the target list destination
      if (listDest) {
        reconciledRef.current = true;
      }
    }
  }, [destinations, quickAddCtx.listFilter, quickAddCtx.listFilterConnectorType, destination]);

  // Reset typeahead index when matches change
  useEffect(() => {
    setListTypeaheadIndex(0);
  }, [listTypeahead?.query]);

  // Accept a typeahead list selection: set destination pill and strip the /query from input
  const acceptListTypeahead = useCallback((dest: Destination) => {
    // Animate the token "flying" from the input to the destination pill
    const editorEl = barRef.current?.querySelector('[data-lexical-editor]');
    const pillEl = destPillRef.current;
    if (editorEl && pillEl) {
      const from = editorEl.getBoundingClientRect();
      const to = pillEl.getBoundingClientRect();
      const label = dest.listName || dest.shortLabel;
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
    setDestination(dest);
    inputHandleRef.current?.focus();
  }, [input]);

  // Parse input on change
  useEffect(() => {
    if (input.trim()) {
      const result = parseInput(input);
      setParsed(result);

      // Check for /listname to quick-select a list (only after space = selection finalized)
      // Supports /listname at start or mid-text (e.g., "buy milk /garage stuff")
      const slashMatch = input.match(/(?:^|\s)\/(\S+)\s/);
      if (slashMatch) {
        const listQuery = slashMatch[1].toLowerCase();
        // Substring match: /ideation → acme/ideation
        const listDest = destinations.find(d =>
          d.listName && (
            d.listName.toLowerCase().includes(listQuery)
            || d.listName.toLowerCase().replace(/[\s/]/g, '-').includes(listQuery)
          )
        );
        if (listDest) {
          setDestination(listDest);
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

      // Auto-detect destination from parsed result
      if (result.destination === 'work') {
        const workDest = destinations.find(d => d.account === 'work');
        if (workDest) setDestination(workDest);
      } else if (result.destination === 'github') {
        const ghDest = destinations.find(d => d.connectorType === 'github-issues');
        if (ghDest) setDestination(ghDest);
      } else if (result.destination === 'personal') {
        const personalDest = destinations.find(d => d.account === 'personal');
        if (personalDest) setDestination(personalDest);
      }
    } else {
      setParsed(null);
    }
  }, [input, destinations, parseInput]);

  // Global keyboard shortcut: N to focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
  }, []);

  // Listen for custom event to open quick-add (from mobile "Add task" button).
  // On mobile the bar is visually hidden, so we open the full AddTaskModal directly.
  useEffect(() => {
    const handler = () => {
      // Check if we're on a narrow viewport (bar is hidden via `hidden sm:block`)
      const isMobile = window.innerWidth < 640;
      if (isMobile) {
        setShowModal(true);
      } else {
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
  }, []);

  // Template selection handlers
  const handleSelectSingleTemplate = useCallback((template: TaskTemplate) => {
    // Pre-fill the input with template name and open AddTaskModal with template ID
    setInput(template.name);
    setParsed(parseInput(template.name));
    setSelectedTemplateId(template.id);
    setShowModal(true);
    setShowTemplatePicker(false);
  }, [parseInput]);

  const handleSelectWorkflowTemplate = useCallback((template: TaskTemplate) => {
    setWorkflowTemplate(template);
    setShowTemplatePicker(false);
  }, []);

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
  }, [showDestPicker]);

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

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;

    const cleanInput = normalizePendingTaskText(input.replace(/^\/\S+\s/, ''));

    // Apply compound task splitting at submit time (deferred from typing)
    let currentInputTasks: PendingTask[] = [];
    if (cleanInput) {
      const compoundParts = splitCompoundTask(cleanInput);
      if (compoundParts && compoundParts.length >= 2) {
        currentInputTasks = compoundParts.map((text, i) => ({
          id: `current-${i}`,
          text: normalizePendingTaskText(text),
          parentIndex: null,
          isComplete: false,
        }));
      } else {
        currentInputTasks = [{ id: 'current', text: cleanInput, parentIndex: null, isComplete: false }];
      }
    }

    // Build the full task list: pending chips + current input (possibly split)
    const allTasks: PendingTask[] = [
      ...pendingTasks,
      ...currentInputTasks,
    ];
    if (allTasks.length === 0) return;
    const unresolvedProject = allTasks
      .map(task => parseInput(task.text))
      .find(task => task.project && !task.projectId);
    if (unresolvedProject?.project) {
      if (projectsLoadState === 'loading') {
        toast.info('Projects are still loading. Try again in a moment.');
      } else if (projectsLoadState === 'error') {
        toast.error('Projects could not be loaded. Remove the +Project token or reload and try again.');
      } else {
        toast.error(`Project “${unresolvedProject.project}” was not found. Select it from the +Project suggestions.`);
      }
      return;
    }

    // Fall back to the filter context's list when the destination pill doesn't carry one
    const resolvedListId = destination.listId || quickAddCtx.listFilter || undefined;
    const resolvedListName = destination.listName || quickAddCtx.listFilterName || undefined;

    // If this connector requires a list (e.g. GitHub repos) and none is resolved,
    // open the expanded modal so the user can pick one instead of silently failing.
    if (destination.listSelectionMode === 'required' && !resolvedListId) {
      setShowModal(true);
      return;
    }

    setIsSubmitting(true);

    try {
      // Separate parent tasks (parentIndex === null) from subtasks
      const parentTasks = allTasks.filter(t => t.parentIndex === null);
      const subtasks = allTasks.filter(t => t.parentIndex !== null);

      // Create parent tasks first
      const parentResults = await Promise.allSettled(
        parentTasks.map(async (task) => {
          const taskData = parseInputForSubmit(task.text);
          const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: taskData.title,
              dueDate: taskData.dueDate,
              priority: taskData.priority || 'none',
              connectorType: destination.connectorType,
              connectorInstanceId: destination.connectorType === 'local'
                ? undefined
                : destination.id,
              sourceListId: resolvedListId,
              sourceListName: resolvedListName,
              estimatedDuration: taskData.estimatedDuration || undefined,
              recurrence: taskData.recurrence || undefined,
              effort: taskData.effort || undefined,
              projectIds: (() => {
                const projectId = resolveQuickAddProjectId(
                  taskData.projectId,
                  visibleContextProject,
                  contextProjectActive,
                );
                return projectId ? [projectId] : undefined;
              })(),
              tagSlugs: (() => {
                const merged = new Set(taskData.tags);
                if (quickAddCtx.defaultTags) quickAddCtx.defaultTags.forEach(t => merged.add(t));
                return merged.size > 0 ? [...merged] : undefined;
              })(),
            }),
          });

          if (!res.ok) {
            throw new Error(`Failed to create task: ${task.text}`);
          }

          const { id: newTaskId, editPolicy } = await res.json() as {
            id: string;
            editPolicy: TaskEditPolicy;
          };

          // POST /api/tasks always creates with status 'todo' — mark complete if source indicated [x]
          if (task.isComplete && newTaskId) {
            if (!canEditTaskField(editPolicy, 'status')) {
              throw new Error(taskFieldBlockedReason(editPolicy, 'status'));
            }
            const completionResponse = await fetch(`/api/tasks/${newTaskId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'done' }),
            });
            if (!completionResponse.ok) {
              throw new Error(`Failed to mark task complete: ${task.text}`);
            }
          }

          // Add to My Day if active
          if (myDayActive) {
            const { getLocalToday } = await import('@/lib/utils/client-date');
            const myDayRes = await fetch('/api/my-day', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ taskId: newTaskId, date: getLocalToday() }),
            });
            if (!myDayRes.ok) {
              taskLogger.error('Failed to add task to My Day', { taskId: newTaskId, status: myDayRes.status });
            } else {
              window.dispatchEvent(new CustomEvent('mission-control:my-day-item-added', {
                detail: {
                  taskId: newTaskId,
                  title: taskData.title,
                  priority: taskData.priority || 'none',
                  dueDate: taskData.dueDate || null,
                  connectorType: destination.connectorType || 'local',
                  sourceListName: resolvedListName || null,
                  status: task.isComplete ? 'done' : 'todo',
                  editPolicy,
                },
              }));
            }
          }

          return { id: newTaskId, editPolicy };
        })
      );

      // Build a map from allTasks index → created parent task ID
      const parentIndexToId = new Map<number, string>();
      let parentResultIdx = 0;
      for (let i = 0; i < allTasks.length; i++) {
        if (allTasks[i].parentIndex === null) {
          const result = parentResults[parentResultIdx];
          if (result && result.status === 'fulfilled') {
            parentIndexToId.set(i, result.value.id);
          }
          parentResultIdx++;
        }
      }

      // Create subtasks under their parent tasks
      const subtaskResults = await Promise.allSettled(
        subtasks.map(async (task) => {
          const parentId = task.parentIndex !== null ? parentIndexToId.get(task.parentIndex) : null;
          if (!parentId) {
            throw new Error(`Parent task not created for subtask: ${task.text}`);
          }

          const taskData = parseInput(task.text);
          const res = await fetch(`/api/tasks/${parentId}/subtasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: taskData.title }),
          });

          if (!res.ok) {
            throw new Error(`Failed to create subtask: ${task.text}`);
          }

          const { subtask, editPolicy } = await res.json() as {
            subtask?: { id: string };
            editPolicy: TaskEditPolicy;
          };

          // Mark as complete if source indicated [x]
          if (task.isComplete && subtask?.id) {
            if (!canEditTaskField(editPolicy, 'status')) {
              throw new Error(taskFieldBlockedReason(editPolicy, 'status'));
            }
            const completionResponse = await fetch(`/api/tasks/${subtask.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'done' }),
            });
            if (!completionResponse.ok) {
              throw new Error(`Failed to mark subtask complete: ${task.text}`);
            }
          }

          if (!subtask?.id) throw new Error(`Subtask response missing ID: ${task.text}`);
          return { id: subtask.id, editPolicy };
        })
      );

      const totalCount = parentTasks.length + subtasks.length;
      const allResults = [...parentResults, ...subtaskResults];
      const failedCount = allResults.filter(r => r.status === 'rejected').length;
      const successfulCount = totalCount - failedCount;
      const createdTasks = allResults
        .filter((result): result is PromiseFulfilledResult<{ id: string; editPolicy: TaskEditPolicy }> => result.status === 'fulfilled')
        .map((result) => result.value);
      const createdTaskIds = createdTasks.map((task) => task.id);
      const createdTaskPolicies = Object.fromEntries(
        createdTasks.map((task) => [task.id, task.editPolicy]),
      );

      if (failedCount === 0) {
        setInput('');
        setPendingTasks([]);
        setParsed(null);
        setCompoundSplitHint(null);
        const myDaySuffix = myDayActive ? ' · ☀️ My Day' : '';
        const subtaskSuffix = subtasks.length > 0 ? ` (${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'})` : '';
        const toastMessage = `Added ${parentTasks.length} ${parentTasks.length === 1 ? 'task' : 'tasks'}${subtaskSuffix}`;
        const toastDestSuffix = `${destination.account ? ` · ${destination.account}` : ''}${myDaySuffix}`;
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);

        // For single-task adds, capture metadata to show in the toast
        let singleTaskMeta: InlineToast['singleTaskMeta'] = undefined;
        if (parentTasks.length === 1 && subtasks.length === 0) {
          const taskData = parseInputForSubmit(parentTasks[0].text);
          singleTaskMeta = {
            title: taskData.title,
            listName: resolvedListName || null,
            priority: taskData.priority,
            dueDate: taskData.dueDate,
            dueDateLabel: taskData.dueDateLabel,
          };
        }

        setInlineToast({
          message: toastMessage,
          taskIds: createdTaskIds,
          editPolicies: createdTaskPolicies,
          destSuffix: toastDestSuffix,
          singleTaskMeta,
        });
        toastTimerRef.current = setTimeout(() => setInlineToast(null), 6000);
        onTaskAdded?.();
        window.dispatchEvent(new CustomEvent('mission-control:task-added'));

        // For single-task adds: compute NLP hints immediately, then fetch AI suggestions
        if (createdTaskIds.length === 1) {
          // NLP hints from title keywords — shown instantly
          const cleanTitle = singleTaskMeta?.title ?? parentTasks[0].text;
          const nlpHints = parseNlpHints(cleanTitle, cachedTags);
          if (nlpHints) {
            setInlineToast(prev => prev && prev.taskIds[0] === createdTaskIds[0]
              ? { ...prev, suggestions: nlpHints }
              : prev
            );
            // Extend timer since we now have suggestions to review
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            toastTimerRef.current = setTimeout(() => setInlineToast(null), 10000);
          }

          // AI suggestions (non-blocking) — merge with NLP hints when they arrive
          fetch(`/api/tasks/quick-sort/suggestions?taskIds=${createdTaskIds[0]}`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
              if (!data?.suggestions) return;
              const raw = data.suggestions[createdTaskIds[0]] as QuickSortSuggestion | undefined;
              if (!raw) return;
              const filtered = filterSuggestion(raw);
              if (!filtered) return;
              // Merge: AI suggestions take precedence over NLP hints
              setInlineToast(prev => {
                if (!prev || prev.taskIds[0] !== createdTaskIds[0]) return prev;
                const merged = mergeSuggestions(prev.suggestions, filtered);
                return { ...prev, suggestions: merged };
              });
              if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
              toastTimerRef.current = setTimeout(() => setInlineToast(null), 10000);
            })
            .catch(() => {}); // Silently ignore suggestion fetch failures
        }
      } else {
        // On partial failure, re-queue failed parent tasks (subtasks of failed parents are lost)
        const failedParentTexts = parentTasks.filter((_, i) => parentResults[i].status === 'rejected').map(t => t.text);
        if (failedParentTexts.length > 0) {
          setPendingTasks(failedParentTexts.slice(0, -1).map(text => ({
            id: `pending-task-${nextPendingTaskIdRef.current++}`,
            text,
            parentIndex: null,
            isComplete: false,
          })));
          setInput(failedParentTexts[failedParentTexts.length - 1] ?? '');
        } else {
          setInput('');
          setPendingTasks([]);
        }
        const partialMessage = successfulCount > 0
          ? `Added ${successfulCount} ${successfulCount === 1 ? 'item' : 'items'} · ${failedCount} still pending`
          : 'Unable to add tasks';
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setInlineToast({ message: partialMessage, taskIds: [], editPolicies: {} });
        toastTimerRef.current = setTimeout(() => setInlineToast(null), 5000);
        if (successfulCount > 0) {
          onTaskAdded?.();
          window.dispatchEvent(new CustomEvent('mission-control:task-added'));
        }
      }
    } catch (err) {
      taskLogger.error('Failed to add task', { err });
    } finally {
      setIsSubmitting(false);
    }
  }, [input, pendingTasks, destination, isSubmitting, onTaskAdded, myDayActive, quickAddCtx.listFilter, quickAddCtx.listFilterName, quickAddCtx.defaultTags, parseInput, parseInputForSubmit, projectsLoadState, visibleContextProject, contextProjectActive]);

  // After typeahead acceptance clears the dropdown, auto-submit if flagged
  useEffect(() => {
    if (submitAfterTypeaheadRef.current && !listTypeahead) {
      submitAfterTypeaheadRef.current = false;
      handleSubmit();
    }
  }, [listTypeahead, handleSubmit]);

  const commitCurrentInputToPending = useCallback(() => {
    const normalized = normalizePendingTaskText(input.replace(/^\/\S+\s/, ''));
    if (!normalized) return false;
    setPendingTasks(prev => [...prev, { id: `pending-task-${nextPendingTaskIdRef.current++}`, text: normalized, parentIndex: null, isComplete: false }]);
    setInput('');
    setParsed(null);
    return true;
  }, [input]);

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
        updated.push({ id: `pending-task-${nextPendingTaskIdRef.current++}`, text: currentInput, parentIndex: null, isComplete: false });
      }
      return updated;
    });
    setInput(selectedTask.text);
    setShouldRefocusInput(true);
  }, [input, pendingTasks]);

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
    if (committed.length > 0) {
      setPendingTasks(prev => {
        const baseOffset = prev.length;
        return [
          ...prev,
          ...committed.map((task, i) => ({
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
      const parts = splitCompoundTask(remaining);
      setCompoundSplitHint(parts);
    } else {
      setCompoundSplitHint(null);
    }
  }, []);

  const acceptDateSuggestion = useCallback(() => {
    if (!parsed?.dateSuggestion) return;
    const matchedText = parsed.dateSuggestion.matchedText;
    const matchIndex = input.toLowerCase().lastIndexOf(matchedText.toLowerCase());
    if (matchIndex < 0) return;
    const nextInput = `${input.slice(0, matchIndex)}/due:${input.slice(matchIndex)}`;
    setInput(nextInput);
    inputHandleRef.current?.setText(nextInput);
    inputHandleRef.current?.focus();
  }, [input, parsed]);

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
        setInput('');
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
        setInput('');
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
        // Just remove the # token
        setInput(input.replace(/(?:^|\s)#[a-zA-Z0-9_:./-]*$/, '').trim());
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
        setInput(input.replace(/(?:^|\s)\+[^+#@!~^/]*$/, '').trim());
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
        setInput(input.replace(/(?:^|\s)![a-zA-Z0-9]*$/, '').trim());
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
        setInput(input.replace(/(?:^|\s)\^[a-zA-Z0-9]*$/, '').trim());
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
      setCompoundSplitHint(null);
      inputHandleRef.current?.blur();
      return true;
    }
    return false;
  }, [templateTypeahead, templateTypeaheadIndex, acceptTemplateTypeahead, listTypeahead, listTypeaheadIndex, acceptListTypeahead, tagTypeahead, tagTypeaheadIndex, acceptTagTypeahead, projectTypeahead, projectTypeaheadIndex, acceptProjectTypeahead, priorityTypeahead, priorityTypeaheadIndex, acceptPriorityTypeahead, effortTypeahead, effortTypeaheadIndex, acceptEffortTypeahead, input, pendingTasks, commitCurrentInputToPending, handleSubmit]);

  const inlineToastPolicies = inlineToast?.taskIds
    .map((taskId) => inlineToast.editPolicies[taskId])
    .filter((policy): policy is TaskEditPolicy => Boolean(policy)) ?? [];
  const undoBlockedPolicy = inlineToastPolicies.find((policy) => !canRemoveTask(policy));
  const undoBlockedReason = undoBlockedPolicy?.removalReason
    ?? (inlineToast && inlineToastPolicies.length !== inlineToast.taskIds.length
      ? 'Removal policy is unavailable for one or more created tasks'
      : undefined);
  const suggestionBlockedReason = (() => {
    if (!inlineToast?.suggestions || inlineToast.taskIds.length !== 1) return undefined;
    const policy = inlineToast.editPolicies[inlineToast.taskIds[0]];
    const fields: TaskField[] = [];
    if (inlineToast.suggestions.priority) fields.push('priority');
    if (inlineToast.suggestions.effort) fields.push('effort');
    if (inlineToast.suggestions.tags.length > 0) fields.push('tags');
    const blockedField = fields.find((field) => !canEditTaskField(policy, field));
    return blockedField ? taskFieldBlockedReason(policy, blockedField) : undefined;
  })();

  return (
    <>
      <div ref={barRef} className="relative z-10" style={{ minHeight: '2.5rem' }}>
        <div
          className={`absolute left-0 right-0 top-0 flex flex-wrap items-center gap-2 bg-[var(--surface-1)] rounded-xl px-1 py-1 transition-[background-color,border-color,box-shadow] duration-150 border ${
            isFocused
              ? 'border-[var(--border-focus)] shadow-[var(--shadow-focus-glow)]'
              : 'border-[var(--border)] shadow-[var(--shadow-sm)]'
          }`}
        >
          {/* Plus dropdown menu */}
          <div ref={plusMenuRef} className="relative">
            <Tooltip content="More actions">
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowPlusMenu(!showPlusMenu);
                }}
                className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
                  showPlusMenu
                    ? 'bg-[var(--accent-900)] text-[var(--accent-400)]'
                    : 'text-blue-400 hover:text-blue-300 hover:bg-[var(--surface-2)]'
                }`}
                aria-label="More actions"
              >
                <Plus size={16} />
              </button>
            </Tooltip>
            <AnimatePresence>
              {showPlusMenu && (
                <motion.div
                  variants={dropdownVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="absolute left-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--surface-1)] shadow-lg py-1"
                >
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
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
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setShowPlusMenu(false);
                      setShowModal(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <Maximize2 size={13} className="text-[var(--text-muted)]" />
                    <span>Expanded form</span>
                    <span className="ml-auto text-xs text-[var(--text-muted)]">Ctrl+Shift+N</span>
                  </button>
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
                  task.parentIndex !== null
                    ? 'ml-3 border-purple-800/30 bg-purple-900/20 text-purple-200'
                    : task.isComplete
                      ? 'border-green-800/30 bg-green-900/20 text-green-200 line-through opacity-70'
                      : 'border-blue-800/30 bg-blue-900/20 text-blue-200'
                }`}
              >
                <Tooltip content={task.parentIndex !== null ? 'Edit pending subtask' : 'Edit pending task'}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handlePendingTaskEdit(task.id);
                    }}
                    className="max-w-[240px] truncate text-left hover:text-white"
                  >
                    <span className="mr-1">{task.parentIndex !== null ? '↳' : task.isComplete ? <CheckSquare size={12} className="inline" /> : <Check size={12} className="inline" />}</span>
                    {task.text}
                  </button>
                </Tooltip>
                <Tooltip content={task.parentIndex !== null ? 'Remove pending subtask' : 'Remove pending task'}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handlePendingTaskDelete(task.id);
                    }}
                    className={`transition-colors hover:text-white ${
                      task.parentIndex !== null
                        ? 'text-purple-300'
                        : task.isComplete
                          ? 'text-green-300'
                          : 'text-blue-300'
                    }`}
                    aria-label={`Remove pending ${task.parentIndex !== null ? 'subtask' : 'task'} ${task.text}`}
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
              onFocus={() => {
                setIsFocused(true);
                // When a list filter is active, pre-select that list as destination (no text prefix needed)
                if (!input && quickAddCtx.listFilterName && quickAddCtx.listFilter) {
                  const listDest = destinations.find(d =>
                    d.listName && d.listName === quickAddCtx.listFilterName
                  );
                  if (listDest) {
                    setDestination(listDest);
                  }
                }
              }}
              onBlur={() => setIsFocused(false)}
              onKeyDown={handleKeyDown}
              placeholder={
                quickAddCtx.placeholderOverride
                  ? quickAddCtx.placeholderOverride
                  : visibleContextProject && contextProjectActive
                    ? `Add task to ${visibleContextProject.name}...`
                  : destination.listName
                    ? `Add task to ${destination.listName}...`
                    : destination.listSelectionMode === 'required' && !destination.listId
                      ? `Add task to ${destination.shortLabel} (pick a ${destination.connectorType === 'github-issues' ? 'repo' : 'list'} with /name)...`
                      : quickAddCtx.sourceFilter
                        ? `Add task to ${destination.shortLabel}...`
                        : 'Add a task... (t/ for templates)'
              }
              className="min-w-[12rem]"
            />
          </div>

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-1 pr-1">
            {/* Voice input toggle */}
            {voiceSupported && (
              <Tooltip content={isVoiceListening ? 'Stop dictation' : 'Dictate task'}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    isVoiceListening ? voiceStop() : voiceStart();
                  }}
                  aria-label={isVoiceListening ? 'Stop voice input' : 'Start voice input'}
                  className={cn(
                    'inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors',
                    isVoiceListening
                      ? 'text-red-400 bg-red-500/10 border border-red-500/30 animate-pulse'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                  )}
                >
                  {isVoiceListening ? <Square size={13} className="fill-current" /> : <Mic size={13} />}
                </button>
              </Tooltip>
            )}

            {/* My Day pill — shown when addToMyDay is active, toggleable */}
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
                  <span className="hidden sm:inline">My Day</span>
                </button>
              </Tooltip>
            )}

            {visibleContextProject && (
              <QuickAddProjectControl
                project={visibleContextProject}
                active={contextProjectActive}
                onActiveChange={setContextProjectActive}
              />
            )}

            {/* Expand to full form — shown when focused with text */}
            {isFocused && input.trim() && !listTypeahead && !templateTypeahead && !tagTypeahead && !priorityTypeahead && !effortTypeahead && (
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
            )}

            {/* Destination pill */}
            <motion.button
              ref={destPillRef}
              onClick={() => setShowDestPicker(!showDestPicker)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-3)] transition-colors"
              animate={pillFlash ? { scale: [1, 1.08, 1], borderColor: ['var(--border)', 'var(--accent)', 'var(--border)'] } : {}}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              title={destination.label}
            >
              <ConnectorIconImg type={destination.connectorType} size={14} />
              <span className="max-w-[120px] truncate">{destination.shortLabel}</span>
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

          {/* Compound task split hint — inside bar as a full-width second row */}
          {compoundSplitHint && compoundSplitHint.length >= 2 && !listTypeahead && !templateTypeahead && !tagTypeahead && !priorityTypeahead && !effortTypeahead && (
            <div className="flex w-full items-center gap-2 px-3 pb-1.5 pt-0.5 text-xs">
              <GitBranch size={12} className="text-teal-400 shrink-0" />
              <span className="text-[var(--text-muted)]">
                Will split into {compoundSplitHint.length} tasks on ↵
              </span>
              <span className="text-[var(--text-muted)] opacity-60">
                — use ;; to split now, or just keep typing
              </span>
            </div>
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
        {isFocused && !listTypeahead && !templateTypeahead && !tagTypeahead && !projectTypeahead && !priorityTypeahead && !effortTypeahead && parsed && (parsed.dueDate || parsed.dateSuggestion || parsed.priority || parsed.tags.length > 0 || parsed.project || parsed.estimatedDuration || parsed.recurrence) && (
          <div className="flex items-center gap-2 mt-1.5 px-3 text-xs">
            <Sparkles size={12} className="text-blue-400" />
            {parsed.dueDateLabel && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-900/30 text-green-300 border border-green-800/30">
                <Calendar size={12} className="inline" /> {parsed.dueDateLabel}
              </span>
            )}
            {parsed.dateSuggestion && (
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={acceptDateSuggestion}
                className="inline-flex items-center gap-1 rounded border border-green-800/30 bg-green-900/20 px-2 py-0.5 text-green-300 transition-colors hover:bg-green-900/40"
                title="Apply this date as the due date"
              >
                <Calendar size={12} /> Use {parsed.dateSuggestion.label}
              </button>
            )}
            {parsed.priority && (
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${
                parsed.priority === 'critical' ? 'bg-rose-900/40 text-rose-300 border-rose-700/30'
                : parsed.priority === 'high' ? 'bg-orange-900/30 text-orange-300 border-orange-800/30'
                : parsed.priority === 'medium' ? 'bg-amber-900/25 text-amber-300 border-amber-700/30'
                : 'bg-sky-900/25 text-sky-300 border-sky-700/30'
              }`}>
                {parsed.priority === 'critical' ? <Flame size={11} /> : parsed.priority === 'high' ? <AlertCircle size={11} /> : <AlertCircle size={11} />} {parsed.priority}
              </span>
            )}
            {parsed.estimatedDuration && (
              <span className="inline-flex items-center gap-1 rounded border border-blue-800/30 bg-blue-900/30 px-2 py-0.5 text-blue-300 tabular-nums">
                <Clock size={11} /> {parsed.estimatedDuration >= 60 ? `${parsed.estimatedDuration / 60}h` : `${parsed.estimatedDuration}m`}
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
                /{parsed.project}
              </span>
            )}
          </div>
        )}

        {/* Compound task split hint — shown when NLP detects "verb and verb" during typing */}
        {isFocused && compoundSplitHint && compoundSplitHint.length >= 2 && !listTypeahead && !templateTypeahead && !tagTypeahead && !priorityTypeahead && !effortTypeahead && (
          <div className="flex items-center gap-2 mt-1.5 px-3 text-xs">
            <GitBranch size={12} className="text-teal-400 shrink-0" />
            <span className="text-[var(--text-muted)]">
              Will split into {compoundSplitHint.length} tasks on ↵
            </span>
            <span className="text-[var(--text-muted)] opacity-60">
              — use ;; to split now, or just keep typing
            </span>
          </div>
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
                <span>Select a list</span>
                <span className="normal-case tracking-normal font-normal">↑↓ navigate · ↵ select</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {listTypeahead.matches.map((dest, i) => {
                  const isActive = i === listTypeaheadIndex;
                  const name = dest.listName || dest.shortLabel;
                  // Highlight the matching substring
                  const matchIdx = name.toLowerCase().indexOf(listTypeahead.query);
                  return (
                    <button
                      key={`${dest.id}-${dest.listId}`}
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
                        {(dest.groupName || dest.label !== dest.shortLabel) && (
                          <span className="block text-xs text-[var(--text-muted)] truncate">
                            {dest.groupName
                              ? `${dest.label} › ${dest.groupName}`
                              : dest.label}
                          </span>
                        )}
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

        {/* Destination picker dropdown */}
        <AnimatePresence>
          {showDestPicker && (
            <motion.div
              className="absolute right-0 top-full z-50 mt-1.5 flex max-h-[min(420px,calc(100vh-120px))] w-72 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--shadow-lg)]"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              {/* Search input */}
              <div className="px-2.5 pt-2.5 pb-1.5">
                <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[var(--surface-0)] border border-[var(--border)] rounded-lg">
                  <Search size={13} className="text-[var(--text-muted)] flex-shrink-0" />
                  <input
                    ref={destSearchRef}
                    type="text"
                    value={destSearch}
                    onChange={e => { setDestSearch(e.target.value); setDestNavIndex(0); }}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setDestNavIndex(i => Math.min(i + 1, flatPickerDests.length - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setDestNavIndex(i => Math.max(i - 1, 0));
                      } else if (e.key === 'Enter' && flatPickerDests.length > 0) {
                        e.preventDefault();
                        const dest = flatPickerDests[destNavIndex];
                        if (dest) {
                          setDestination(dest);
                          setShowDestPicker(false);
                          userOverrodeDestRef.current = true;
                          setInput(prev => prev.replace(/^\/\S+\s/, ''));
                        }
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setShowDestPicker(false);
                      }
                    }}
                    placeholder="Search destinations..."
                    className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none shadow-none border-none"
                  />
                </div>
              </div>

              {/* Scrollable grouped list */}
              <div ref={destScrollRef} className="overflow-y-auto flex-1 min-h-0">
                {destPickerGroups.length === 0 && (
                  <div className="px-3 py-4 text-xs text-[var(--text-muted)] text-center">
                    No matching destinations
                  </div>
                )}
                {destPickerGroups.map((group, groupIdx) => {
                  const groupStartIdx = groupStartIndices[groupIdx] ?? 0;

                  return (
                    <div key={group.label}>
                      <div className="px-3 pt-2 pb-1 text-[12px] font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1.5 sticky top-0 bg-[var(--surface-1)]">
                        {group.connectorType && <ConnectorIconImg type={group.connectorType} size={11} />}
                        <span className="truncate">{group.label}</span>
                      </div>
                      {group.destinations.map((dest, i) => {
                        const flatIdx = groupStartIdx + i;
                        const isNavTarget = flatIdx === destNavIndex;
                        const isSelected = destination.id === dest.id && destination.listId === dest.listId;
                        return (
                          <button
                            key={`${dest.id}-${dest.listId || 'default'}`}
                            data-dest-idx={flatIdx}
                            onClick={() => {
                              setDestination(dest);
                              setShowDestPicker(false);
                              userOverrodeDestRef.current = true;
                              setInput(prev => prev.replace(/^\/\S+\s/, ''));
                            }}
                            onMouseEnter={() => setDestNavIndex(flatIdx)}
                            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors ${
                              isNavTarget ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]'
                              : isSelected ? 'bg-[var(--surface-2)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                            }`}
                          >
                            <ConnectorIconImg type={dest.connectorType} size={14} />
                            <span className="flex-1 min-w-0">
                              <span className="block text-xs text-[var(--text-primary)] truncate">{dest.shortLabel}</span>
                              {dest.shortLabel !== dest.label && (
                                <span className="block text-[12px] text-[var(--text-muted)] truncate">{dest.label}</span>
                              )}
                            </span>
                            {isSelected && <span className="text-blue-400 text-xs flex-shrink-0"><Check size={12} /></span>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-muted)]">
                💡 Type <code className="text-blue-400">@work</code> or <code className="text-green-400">@github</code> to auto-select · <code className="text-purple-400">/list</code> to pick a list
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline toast notification */}
        <AnimatePresence>
          {inlineToast && (
            <motion.div
              className="absolute left-0 right-0 top-full mt-2 bg-green-950/80 border border-green-500/40 text-green-200 text-sm font-medium rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] z-50"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
            >
              {/* Row 1: task confirmation */}
              <div className="px-4 py-2 flex items-center gap-3">
                <span className="flex-1 min-w-0">
                  {inlineToast.singleTaskMeta ? (
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0"><Check size={12} /></span>
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
                      const results = await Promise.all(inlineToast.taskIds.map(id => fetch(`/api/tasks/${id}`, { method: 'DELETE' })));
                      const failed = results.filter(r => !r.ok);
                      if (failed.length > 0) {
                        toast.error('Undo failed — task could not be removed');
                        setInlineToast(null);
                        return;
                      }
                      // Check if any task was closed (not deleted) and show appropriate message
                      const bodies = await Promise.all(results.map(r => r.json().catch(() => ({}))));
                      const closedResult = bodies.find(b => b.action === 'closed');
                      if (closedResult) {
                        const label = CONNECTOR_LABELS[closedResult.connectorType] || closedResult.connectorType;
                        toast.info(`Undone · closed as not planned on ${label}`, { duration: 4000 });
                      }
                      setInlineToast(null);
                      onTaskAdded?.();
                      window.dispatchEvent(new CustomEvent('mission-control:task-added'));
                    }}
                  >
                    Undo
                  </button>
                )}
              </div>

              {/* Row 2: suggestion nudge (appears after async fetch) */}
              <AnimatePresence>
                {inlineToast.suggestions && !inlineToast.suggestionsApplied && (
                  <motion.div
                    className="px-4 py-1.5 border-t border-green-500/20 flex items-center gap-2"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <span className="shrink-0 text-xs leading-none">✨</span>
                    <span className="flex-1 min-w-0 flex items-center gap-1.5 text-xs text-green-300/80">
                      {inlineToast.suggestions.priority && (
                        <span className="px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-900/20 text-amber-300">
                          {inlineToast.suggestions.priority.value === 'critical' ? 'P0' :
                           inlineToast.suggestions.priority.value === 'high' ? 'P1' :
                           inlineToast.suggestions.priority.value === 'medium' ? 'P2' : 'P3'}
                        </span>
                      )}
                      {inlineToast.suggestions.effort && (
                        <span className="px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-900/20 text-sky-300">
                          {EFFORT_LABELS[inlineToast.suggestions.effort.value] ?? `E${inlineToast.suggestions.effort.value}`}
                        </span>
                      )}
                      {inlineToast.suggestions.tags.map(tag => (
                        <span key={tag.id} className="px-1.5 py-0.5 rounded border border-purple-500/30 bg-purple-900/20 text-purple-300 truncate max-w-[80px]">
                          {tag.name}
                        </span>
                      ))}
                    </span>
                    <button
                      className="shrink-0 text-xs font-semibold text-amber-300 hover:text-amber-100 transition-colors disabled:opacity-50"
                      disabled={inlineToast.suggestionsApplying || Boolean(suggestionBlockedReason)}
                      title={suggestionBlockedReason}
                      onClick={async () => {
                        const taskId = inlineToast.taskIds[0];
                        const s = inlineToast.suggestions;
                        if (!taskId || !s) return;
                        setInlineToast(prev => prev ? { ...prev, suggestionsApplying: true } : prev);
                        try {
                          const body: Record<string, unknown> = {};
                          if (s.priority) body.priority = s.priority.value;
                          if (s.effort) body.effort = s.effort.value;
                          if (s.tags.length > 0) body.tags = s.tags.map(t => t.id);
                          const response = await fetch(`/api/tasks/${taskId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body),
                          });
                          if (!response.ok) {
                            const payload = await response.json().catch(() => null) as { error?: string } | null;
                            throw new Error(payload?.error ?? 'Failed to apply suggestions');
                          }
                          setInlineToast(prev => prev ? { ...prev, suggestionsApplied: true, suggestionsApplying: false } : prev);
                          onTaskAdded?.();
                          window.dispatchEvent(new CustomEvent('mission-control:task-added'));
                          // Auto-dismiss after apply
                          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
                          toastTimerRef.current = setTimeout(() => setInlineToast(null), 2000);
                        } catch (error) {
                          setInlineToast(prev => prev ? { ...prev, suggestionsApplying: false } : prev);
                          toast.error(error instanceof Error ? error.message : 'Failed to apply suggestions');
                        }
                      }}
                    >
                      {inlineToast.suggestionsApplying ? 'Applying…' : 'Apply'}
                    </button>
                  </motion.div>
                )}
                {inlineToast.suggestionsApplied && (
                  <motion.div
                    className="px-4 py-1.5 border-t border-green-500/20 flex items-center gap-2 text-xs text-green-400"
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
            onClose={() => { setShowModal(false); setSelectedTemplateId(null); }}
            onSubmit={() => {
              setInput('');
              setParsed(null);
              setShowModal(false);
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