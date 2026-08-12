'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Filter, HelpCircle, Save, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  TaskFilterBuilder,
  type TaskFilterBuilderCategory,
} from '@/components/filters/TaskFilterBuilder';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import {
  EMPTY_TASK_FILTER_CONTEXT,
  taskFilterContextToDashboard,
  updateTaskFilterContext,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { parseFilterQuery, type FilterToken, type FilterTokenType } from '@/lib/utils/parseFilterQuery';
import type { EnabledSource, HubProject, ListGroup, SourceList, TaskTag } from '@/types/dashboard';
import { PRIORITY_LABELS, STATUS_LABELS } from '@/types/dashboard';

interface TaskKeywordFilterProps {
  filteredCount: number;
  sources: EnabledSource[];
  sourceLists: Array<SourceList & { connectorType?: string }>;
  tags: TaskTag[];
  assignees: string[];
  projects: HubProject[];
  listGroups: ListGroup[];
  onSaveView?: () => void;
  controller?: {
    context: TaskFilterContext;
    setContext: (context: TaskFilterContext, mode?: 'push' | 'replace') => void;
    clear?: (mode?: 'push' | 'replace') => void;
  };
  onOpenFilters?: () => void;
  filtersButtonLabel?: string;
  hiddenBuilderFilters?: TaskFilterBuilderCategory[];
  secondaryContent?: React.ReactNode;
  placeholder?: string;
  className?: string;
}

interface FilterSnapshot {
  sourceFilter: string | null;
  listFilter: string | null;
  listGroupFilter: string | null;
  tagFilter: string[];
  quickFilter: string | null;
  projectFilter: string | null;
  priorityFilter: string[];
  statusFilter: string[];
  textFilter: string;
}

interface AppliedFilter {
  id: string;
  label: string;
  style: { bg: string; text: string; border: string };
  type: 'source' | 'listGroup' | 'list' | 'priority' | 'status' | 'tag' | 'quick' | 'project';
  value: string;
}

const FILTER_UNDO_TOAST_ID = 'filter-undo';

// ── Token colour map ─────────────────────────────────────────────────────────

const TOKEN_STYLES: Record<FilterTokenType, { bg: string; text: string; border: string }> = {
  title:    { bg: 'bg-purple-500/15',  text: 'text-purple-300',  border: 'border-purple-500/30' },
  tag:      { bg: 'bg-green-500/15',   text: 'text-green-300',   border: 'border-green-500/30' },
  priority: { bg: 'bg-red-500/20',     text: 'text-red-300',     border: 'border-red-500/30' },
  status:   { bg: 'bg-yellow-500/15',  text: 'text-yellow-300',  border: 'border-yellow-500/30' },
  source:   { bg: 'bg-blue-500/15',    text: 'text-blue-300',    border: 'border-blue-500/30' },
  list:     { bg: 'bg-cyan-500/15',    text: 'text-cyan-300',    border: 'border-cyan-500/30' },
  listid:   { bg: 'bg-cyan-500/15',    text: 'text-cyan-300',    border: 'border-cyan-500/30' },
  assignee: { bg: 'bg-orange-500/15',  text: 'text-orange-300',  border: 'border-orange-500/30' },
  due:      { bg: 'bg-slate-500/15',   text: 'text-slate-300',   border: 'border-slate-500/30' },
  project:  { bg: 'bg-indigo-500/15',  text: 'text-indigo-300',  border: 'border-indigo-500/30' },
  phase:    { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-300', border: 'border-fuchsia-500/30' },
  disposition: { bg: 'bg-emerald-500/15', text: 'text-emerald-300', border: 'border-emerald-500/30' },
  text:     { bg: '',                  text: '',                  border: '' },
};

const QUICK_FILTER_LABELS: Record<string, string> = {
  myDay: 'My Day',
  overdue: 'Overdue',
  high: 'High Priority',
  week: 'Due This Week',
  assigned: 'Assigned to Me',
  recentlyCreated: 'Recently Created',
  waiting: 'Waiting / On Hold',
};

// ── Autocomplete suggestions ──────────────────────────────────────────────────

interface Suggestion {
  prefix: string;
  hint: string;
}

const SUGGESTIONS: Suggestion[] = [
  { prefix: 'title:',    hint: 'Title contains…' },
  { prefix: 'tag:',      hint: 'Exact tag slug' },
  { prefix: 'priority:', hint: 'high / >=high / <=medium' },
  { prefix: 'status:',   hint: 'todo / in_progress…' },
  { prefix: 'source:',   hint: 'Connector type' },
  { prefix: 'list:',     hint: 'List name contains…' },
  { prefix: 'assignee:', hint: 'Assignee name' },
  { prefix: 'due:',      hint: 'overdue / today / week / none' },
  { prefix: 'project:',  hint: 'Project ID / none' },
  { prefix: 'phase:',    hint: 'Phase ID / none' },
  { prefix: 'disposition:', hint: 'active / handled / dismissed' },
];

// ── Help content ──────────────────────────────────────────────────────────────

const HELP_ROWS: Array<{ token: string; description: string }> = [
  { token: 'title:text',           description: 'Title contains text' },
  { token: 'tag:slug',             description: 'Exact tag slug' },
  { token: 'priority:high',        description: 'Priority level' },
  { token: 'priority:>=high',      description: 'Priority threshold' },
  { token: 'status:todo',          description: 'Status value' },
  { token: 'source:github-issues', description: 'Connector type' },
  { token: 'list:backlog',         description: 'List name contains' },
  { token: 'assignee:alice',       description: 'Assignee name' },
  { token: 'due:<2026-08-01',      description: 'Due before a date' },
  { token: 'project:none',         description: 'Tasks without a project' },
  { token: 'phase:none',           description: 'Tasks without a phase' },
  { token: 'disposition:handled',   description: 'Local Mission Control disposition' },
  { token: '-tag:wontfix',         description: 'Exclude matching tasks' },
  { token: '(no prefix)',          description: 'Full-text on title, tags, notes' },
];

// ── Token type guard for structured tokens ────────────────────────────────────

function isStructuredToken(t: FilterToken): boolean {
  return t.type !== 'text';
}

// ── Reconstruct full query string from tokens ─────────────────────────────────

function tokensToQuery(tokens: FilterToken[], draft: string): string {
  const parts = tokens.map((t) => t.raw);
  if (draft.trim()) parts.push(draft.trim());
  return parts.join(' ');
}

// ── Split a store query string into committed tokens + trailing draft ──────────

function splitQuery(query: string): { committed: FilterToken[]; draft: string } {
  const parsed = parseFilterQuery(query);
  // The "draft" is the last whitespace-separated word if the query doesn't end with whitespace
  const endsWithSpace = query.endsWith(' ');
  if (endsWithSpace || !query.trim()) {
    return { committed: parsed.tokens, draft: '' };
  }
  // A complete structured token is committed even when it came from the builder
  // or a restored view and therefore has no trailing space.
  const lastToken = parsed.tokens.at(-1);
  if (lastToken && isStructuredToken(lastToken)) {
    return { committed: parsed.tokens, draft: '' };
  }

  // Last free-text token is still being typed – keep it in draft
  const tokens = [...parsed.tokens];
  const last = tokens.pop();
  return {
    committed: tokens,
    draft: last?.raw ?? '',
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaskKeywordFilter({
  filteredCount,
  sources,
  sourceLists,
  tags,
  assignees,
  projects,
  listGroups,
  onSaveView,
  controller,
  onOpenFilters,
  filtersButtonLabel = 'Open task filters',
  hiddenBuilderFilters = [],
  secondaryContent,
  placeholder = 'Filter tasks… (press / to focus, ? for help)',
  className = 'mb-3',
}: TaskKeywordFilterProps) {
  const storeTextFilter = useDashboardViewStore((s) => s.textFilter);
  const storeSetTextFilter = useDashboardViewStore((s) => s.setTextFilter);
  const storeSourceFilter = useDashboardViewStore((s) => s.sourceFilter);
  const storeListFilter = useDashboardViewStore((s) => s.listFilter);
  const storeListGroupFilter = useDashboardViewStore((s) => s.listGroupFilter);
  const storeTagFilter = useDashboardViewStore((s) => s.tagFilter);
  const storeQuickFilter = useDashboardViewStore((s) => s.quickFilter);
  const storeProjectFilter = useDashboardViewStore((s) => s.projectFilter);
  const storePriorityFilter = useDashboardViewStore((s) => s.priorityFilter);
  const storeStatusFilter = useDashboardViewStore((s) => s.statusFilter);
  const storeSetSourceFilter = useDashboardViewStore((s) => s.setSourceFilter);
  const storeSetListFilter = useDashboardViewStore((s) => s.setListFilter);
  const storeSetListGroupFilter = useDashboardViewStore((s) => s.setListGroupFilter);
  const storeSetTagFilter = useDashboardViewStore((s) => s.setTagFilter);
  const storeSetQuickFilter = useDashboardViewStore((s) => s.setQuickFilter);
  const storeSetProjectFilter = useDashboardViewStore((s) => s.setProjectFilter);
  const storeSetPriorityFilter = useDashboardViewStore((s) => s.setPriorityFilter);
  const storeSetStatusFilter = useDashboardViewStore((s) => s.setStatusFilter);
  const storeResetFilters = useDashboardViewStore((s) => s.resetFilters);
  const controlledContextRef = useRef(controller?.context);
  useEffect(() => {
    controlledContextRef.current = controller?.context;
  }, [controller?.context]);
  const controlledDashboard = controller
    ? taskFilterContextToDashboard(controller.context)
    : null;
  const textFilter = controller?.context.query ?? storeTextFilter;
  const sourceFilter = controlledDashboard?.sourceFilter ?? storeSourceFilter;
  const listFilter = controlledDashboard?.listFilter ?? storeListFilter;
  const listGroupFilter = controlledDashboard?.listGroupFilter ?? storeListGroupFilter;
  const tagFilter = controlledDashboard?.tagFilter ?? storeTagFilter;
  const quickFilter = controlledDashboard?.quickFilter ?? storeQuickFilter;
  const projectFilter = controlledDashboard?.projectFilter ?? storeProjectFilter;
  const priorityFilter = controlledDashboard?.priorityFilter ?? storePriorityFilter;
  const statusFilter = controlledDashboard?.statusFilter ?? storeStatusFilter;

  const updateControlledContext = useCallback((
    patch: Partial<Omit<TaskFilterContext, 'version'>>,
  ) => {
    if (!controller) return;
    const next = updateTaskFilterContext(
      controlledContextRef.current ?? controller.context,
      patch,
    );
    controlledContextRef.current = next;
    controller.setContext(next);
  }, [controller]);

  const setTextFilter = useCallback((value: string) => {
    if (controller) updateControlledContext({ query: value });
    else storeSetTextFilter(value);
  }, [controller, storeSetTextFilter, updateControlledContext]);
  const setSourceFilter = useCallback((value: string | null) => {
    if (controller) updateControlledContext({ sources: value ? [value] : [] });
    else storeSetSourceFilter(value);
  }, [controller, storeSetSourceFilter, updateControlledContext]);
  const setListFilter = useCallback((value: string | null) => {
    if (controller) updateControlledContext({ listIds: value ? [value] : [] });
    else storeSetListFilter(value);
  }, [controller, storeSetListFilter, updateControlledContext]);
  const setListGroupFilter = useCallback((value: string | null) => {
    if (controller) updateControlledContext({ listGroupId: value });
    else storeSetListGroupFilter(value);
  }, [controller, storeSetListGroupFilter, updateControlledContext]);
  const setTagFilter = useCallback((value: string[]) => {
    if (controller) updateControlledContext({ tagSlugs: value });
    else storeSetTagFilter(value);
  }, [controller, storeSetTagFilter, updateControlledContext]);
  const setQuickFilter = useCallback((value: string | null) => {
    if (controller) updateControlledContext({ quickFilter: value });
    else storeSetQuickFilter(value);
  }, [controller, storeSetQuickFilter, updateControlledContext]);
  const setProjectFilter = useCallback((value: string | null) => {
    if (controller) updateControlledContext({ projectId: value });
    else storeSetProjectFilter(value);
  }, [controller, storeSetProjectFilter, updateControlledContext]);
  const setPriorityFilter = useCallback((value: string[]) => {
    if (controller) updateControlledContext({ priorities: value });
    else storeSetPriorityFilter(value);
  }, [controller, storeSetPriorityFilter, updateControlledContext]);
  const setStatusFilter = useCallback((value: string[]) => {
    if (controller) updateControlledContext({ statuses: value });
    else storeSetStatusFilter(value);
  }, [controller, storeSetStatusFilter, updateControlledContext]);
  const resetFilters = useCallback(() => {
    if (controller) {
      controlledContextRef.current = EMPTY_TASK_FILTER_CONTEXT;
      if (controller.clear) controller.clear();
      else controller.setContext(EMPTY_TASK_FILTER_CONTEXT);
    } else {
      storeResetFilters();
    }
  }, [controller, storeResetFilters]);

  // committedTokens: tokens the user has "committed" by pressing Space/Enter
  // draft: the portion currently being typed in the input
  const [committedTokens, setCommittedTokens] = useState<FilterToken[]>(() => splitQuery(textFilter).committed);
  const [draft, setDraft] = useState(() => splitQuery(textFilter).draft);
  const [isDraftFocused, setIsDraftFocused] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const activeUndoStateRef = useRef<string | null>(null);

  // Autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [acIndex, setAcIndex] = useState(0);
  // Help tooltip state
  const [showHelp, setShowHelp] = useState(false);

  // Sync state when store changes externally (e.g., clear-all)
  useEffect(() => {
    const { committed, draft: d } = splitQuery(textFilter);
    setCommittedTokens(committed);
    setDraft(d);
  }, [textFilter]);

  const currentFilterStateKey = controller
    ? taskFilterContextKey(controller.context)
    : filterSnapshotKey({
        sourceFilter,
        listFilter,
        listGroupFilter,
        tagFilter,
        quickFilter,
        projectFilter,
        priorityFilter,
        statusFilter,
        textFilter,
      });

  useEffect(() => {
    if (
      activeUndoStateRef.current !== null
      && activeUndoStateRef.current !== currentFilterStateKey
    ) {
      activeUndoStateRef.current = null;
      toast.dismiss(FILTER_UNDO_TOAST_ID);
    }
  }, [currentFilterStateKey]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowAutocomplete(false);
        setShowHelp(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Push the current state to the store (debounced)
  const pushToStore = useCallback((tokens: FilterToken[], currentDraft: string) => {
    const full = tokensToQuery(tokens, currentDraft);
    if (activeUndoStateRef.current !== null) {
      activeUndoStateRef.current = null;
      toast.dismiss(FILTER_UNDO_TOAST_ID);
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setTextFilter(full), 200);
  }, [setTextFilter]);

  // Autocomplete: filter suggestions based on what the user is typing in draft
  const filteredSuggestions = draft
    ? SUGGESTIONS.filter((s) => s.prefix.startsWith(draft.toLowerCase()))
    : SUGGESTIONS;

  const getFilterSnapshot = useCallback((): FilterSnapshot => ({
    sourceFilter,
    listFilter,
    listGroupFilter,
    tagFilter: [...tagFilter],
    quickFilter,
    projectFilter,
    priorityFilter: [...priorityFilter],
    statusFilter: [...statusFilter],
    textFilter: tokensToQuery(committedTokens, draft),
  }), [
    committedTokens, draft, listFilter, listGroupFilter, priorityFilter, projectFilter,
    quickFilter, sourceFilter, statusFilter, tagFilter,
  ]);

  const removeWithUndo = useCallback((
    remove: () => void,
    message = 'Filter removed'
  ) => {
    const snapshot = getFilterSnapshot();
    const controlledSnapshot = controller
      ? updateTaskFilterContext(
          controlledContextRef.current ?? controller.context,
          { query: snapshot.textFilter },
        )
      : null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setTextFilter(snapshot.textFilter);
    remove();
    if (controller) {
      const removedStateKey = taskFilterContextKey(
        controlledContextRef.current ?? controller.context,
      );
      activeUndoStateRef.current = removedStateKey;
      toast(message, {
        id: FILTER_UNDO_TOAST_ID,
        action: {
          label: 'Undo',
          onClick: () => {
            const liveStateKey = taskFilterContextKey(
              controlledContextRef.current ?? controller.context,
            );
            if (
              !controlledSnapshot
              || activeUndoStateRef.current !== removedStateKey
              || liveStateKey !== removedStateKey
            ) {
              activeUndoStateRef.current = null;
              toast.dismiss(FILTER_UNDO_TOAST_ID);
              return;
            }
            activeUndoStateRef.current = null;
            controlledContextRef.current = controlledSnapshot;
            controller.setContext(controlledSnapshot);
          },
        },
      });
      return;
    }
    const removedStateKey = filterSnapshotKey(
      getStoreFilterSnapshot(useDashboardViewStore.getState())
    );
    activeUndoStateRef.current = removedStateKey;
    toast(message, {
      id: FILTER_UNDO_TOAST_ID,
      action: {
        label: 'Undo',
        onClick: () => {
          const liveStateKey = filterSnapshotKey(
            getStoreFilterSnapshot(useDashboardViewStore.getState())
          );
          if (
            activeUndoStateRef.current !== removedStateKey
            || liveStateKey !== removedStateKey
          ) {
            activeUndoStateRef.current = null;
            toast.dismiss(FILTER_UNDO_TOAST_ID);
            return;
          }
          if (debounceRef.current) clearTimeout(debounceRef.current);
          activeUndoStateRef.current = null;
          useDashboardViewStore.setState(snapshot);
        },
      },
    });
  }, [controller, getFilterSnapshot, setTextFilter]);

  const appliedFilters = useMemo(() => {
    const filters: AppliedFilter[] = [];

    const sourceFilters = controller?.context.sources
      ?? (sourceFilter ? [sourceFilter] : []);
    for (const source of sourceFilters) {
      filters.push({
        id: `source-${source}`,
        label: `source:${source}`,
        style: TOKEN_STYLES.source,
        type: 'source',
        value: source,
      });
    }
    if (listGroupFilter) {
      const label = listGroups.find((group) => group.id === listGroupFilter)?.name || 'Group';
      filters.push({
        id: `list-group-${listGroupFilter}`,
        label: `group:${label}`,
        style: TOKEN_STYLES.list,
        type: 'listGroup',
        value: listGroupFilter,
      });
    }
    const listFilters = controller?.context.listIds
      ?? (listFilter ? [listFilter] : []);
    for (const listId of listFilters) {
      const label = sourceLists.find((list) =>
        list.sourceId === listId
        || `${list.connectorInstanceId}:${list.sourceId}` === listId)?.name || 'List';
      filters.push({
        id: `list-${listId}`,
        label: `list:${label}`,
        style: TOKEN_STYLES.list,
        type: 'list',
        value: listId,
      });
    }
    for (const priority of priorityFilter) {
      const label = PRIORITY_LABELS[priority] !== '—'
        ? `${PRIORITY_LABELS[priority]} ${priority}`
        : 'No priority';
      filters.push({
        id: `priority-${priority}`,
        label: `priority:${label}`,
        style: TOKEN_STYLES.priority,
        type: 'priority',
        value: priority,
      });
    }
    for (const status of statusFilter) {
      filters.push({
        id: `status-${status}`,
        label: `status:${STATUS_LABELS[status] || status}`,
        style: TOKEN_STYLES.status,
        type: 'status',
        value: status,
      });
    }
    for (const tag of tagFilter) {
      filters.push({
        id: `tag-${tag}`,
        label: `tag:${tag}`,
        style: TOKEN_STYLES.tag,
        type: 'tag',
        value: tag,
      });
    }
    if (quickFilter) {
      filters.push({
        id: `quick-${quickFilter}`,
        label: `quick:${QUICK_FILTER_LABELS[quickFilter] || quickFilter}`,
        style: quickFilter === 'high'
          ? TOKEN_STYLES.priority
          : quickFilter === 'assigned'
            ? TOKEN_STYLES.assignee
            : quickFilter === 'waiting'
              ? TOKEN_STYLES.status
              : TOKEN_STYLES.due,
        type: 'quick',
        value: quickFilter,
      });
    }
    if (projectFilter) {
      const label = projects.find((project) => project.id === projectFilter)?.name || 'Project';
      filters.push({
        id: `project-${projectFilter}`,
        label: `project:${label}`,
        style: TOKEN_STYLES.tag,
        type: 'project',
        value: projectFilter,
      });
    }

    return filters;
  }, [
    controller, listFilter, listGroupFilter, listGroups, priorityFilter, projectFilter,
    projects, quickFilter, sourceFilter, sourceLists, statusFilter, tagFilter,
  ]);

  const removeAppliedFilter = useCallback((filter: AppliedFilter) => {
    removeWithUndo(() => {
      switch (filter.type) {
        case 'source':
          if (controller) {
            const remainingSources = controller.context.sources.filter(
              (value) => value !== filter.value,
            );
            const remainingListIds = remainingSources.length
              ? controller.context.listIds.filter((listId) => {
                  const list = sourceLists.find((candidate) =>
                    candidate.sourceId === listId
                    || `${candidate.connectorInstanceId}:${candidate.sourceId}` === listId);
                  return list?.connectorType !== filter.value;
                })
              : [];
            updateControlledContext({
              sources: remainingSources,
              listIds: remainingListIds,
              ...(remainingSources.length ? {} : { listGroupId: null }),
            });
          } else {
            setSourceFilter(null);
            setListFilter(null);
            setListGroupFilter(null);
          }
          break;
        case 'listGroup':
          setListGroupFilter(null);
          break;
        case 'list':
          if (controller) {
            updateControlledContext({
              listIds: controller.context.listIds.filter((value) => value !== filter.value),
            });
          } else {
            setListFilter(null);
          }
          break;
        case 'priority':
          setPriorityFilter(priorityFilter.filter((value) => value !== filter.value));
          break;
        case 'status':
          setStatusFilter(statusFilter.filter((value) => value !== filter.value));
          break;
        case 'tag':
          setTagFilter(tagFilter.filter((value) => value !== filter.value));
          break;
        case 'quick':
          setQuickFilter(null);
          break;
        case 'project':
          setProjectFilter(null);
          break;
      }
    });
  }, [
    controller, priorityFilter, removeWithUndo, setListFilter, setListGroupFilter,
    setPriorityFilter, setProjectFilter, setQuickFilter, setSourceFilter, setStatusFilter,
    setTagFilter, sourceLists, statusFilter, tagFilter, updateControlledContext,
  ]);

  const handleDraftChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // If the user typed a space and the draft looks like a complete structured token, commit it
    if (value.endsWith(' ') && draft) {
      const parsed = parseFilterQuery(draft.trimEnd());
      if (parsed.tokens.length === 1 && isStructuredToken(parsed.tokens[0])) {
        const newCommitted = [...committedTokens, parsed.tokens[0]];
        setCommittedTokens(newCommitted);
        setDraft('');
        setShowAutocomplete(false);
        pushToStore(newCommitted, '');
        return;
      }
    }

    setDraft(value);
    setAcIndex(0);
    setShowAutocomplete(value.trim().length > 0);
    pushToStore(committedTokens, value);
  }, [draft, committedTokens, pushToStore]);

  const applyAutocomplete = useCallback((suggestion: Suggestion) => {
    setDraft(suggestion.prefix);
    setShowAutocomplete(false);
    pushToStore(committedTokens, suggestion.prefix);
    inputRef.current?.focus();
  }, [committedTokens, pushToStore]);

  const removeToken = useCallback((index: number) => {
    const next = committedTokens.filter((_, i) => i !== index);
    removeWithUndo(() => {
      setCommittedTokens(next);
      setTextFilter(tokensToQuery(next, draft));
    });
    inputRef.current?.focus();
  }, [committedTokens, draft, removeWithUndo, setTextFilter]);

  const toggleBuilderToken = useCallback((
    type: Exclude<FilterTokenType, 'title' | 'text' | 'listid'>,
    value: string,
    negated: boolean
  ) => {
    const existingIndex = committedTokens.findIndex(
      (token) => token.type === type && token.value === value && token.negated === negated
    );
    if (existingIndex >= 0) {
      const next = committedTokens.filter((_, index) => index !== existingIndex);
      removeWithUndo(() => {
        setCommittedTokens(next);
        setTextFilter(tokensToQuery(next, draft));
      });
    } else {
      const next = [...committedTokens, {
        type,
        value,
        negated,
        raw: `${negated ? '-' : ''}${type}:${quoteFilterValue(value)}`,
      }];
      setCommittedTokens(next);
      pushToStore(next, draft);
    }
    setShowAutocomplete(false);
    setShowHelp(false);
  }, [committedTokens, draft, pushToStore, removeWithUndo, setTextFilter]);

  const handleClear = useCallback(() => {
    removeWithUndo(() => {
      setCommittedTokens([]);
      setDraft('');
      setShowAutocomplete(false);
      resetFilters();
    }, 'Filters cleared');
    inputRef.current?.focus();
  }, [removeWithUndo, resetFilters]);

  const handleClearTextSearch = useCallback(() => {
    removeWithUndo(() => {
      setDraft('');
      setShowAutocomplete(false);
      setTextFilter(tokensToQuery(committedTokens, ''));
    }, 'Search cleared');
    inputRef.current?.focus();
  }, [committedTokens, removeWithUndo, setTextFilter]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showAutocomplete && filteredSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % filteredSuggestions.length);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + filteredSuggestions.length) % filteredSuggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && filteredSuggestions[acIndex])) {
        e.preventDefault();
        applyAutocomplete(filteredSuggestions[acIndex]);
        return;
      }
    }

    if (e.key === 'Enter' && draft.trim()) {
      const parsed = parseFilterQuery(draft.trim());
      if (parsed.tokens.length === 1 && isStructuredToken(parsed.tokens[0])) {
        e.preventDefault();
        const next = [...committedTokens, parsed.tokens[0]];
        setCommittedTokens(next);
        setDraft('');
        setShowAutocomplete(false);
        pushToStore(next, '');
        return;
      }
    }

    // Backspace on empty draft removes the last committed token
    if (e.key === 'Backspace' && draft === '' && committedTokens.length > 0) {
      removeToken(committedTokens.length - 1);
      return;
    }
    if (e.key === 'Backspace' && draft === '' && appliedFilters.length > 0) {
      const lastFilter = appliedFilters.at(-1);
      if (lastFilter) removeAppliedFilter(lastFilter);
      return;
    }

    if (e.key === 'Escape') {
      if (showAutocomplete) {
        setShowAutocomplete(false);
        return;
      }
      if (appliedFilters.length > 0 || committedTokens.length > 0 || draft) {
        handleClear();
      } else {
        inputRef.current?.blur();
      }
    }
  }, [showAutocomplete, filteredSuggestions, acIndex, applyAutocomplete, appliedFilters, draft, committedTokens, removeToken, removeAppliedFilter, handleClear, pushToStore]);

  // Keyboard shortcut: "/" to focus when not already in an input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !isInputFocused()) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const hasContent = appliedFilters.length > 0 || committedTokens.length > 0 || draft.trim().length > 0;
  const structuredTokens = committedTokens.filter(isStructuredToken);

  return (
    <div className={`${className} px-0 relative`} ref={wrapperRef}>
      <div className="flex items-stretch gap-2">
        {onOpenFilters ? (
          <button
            type="button"
            onClick={onOpenFilters}
            className="inline-flex h-auto items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
            aria-label={filtersButtonLabel}
          >
            <Filter size={14} /> Filters
          </button>
        ) : null}
        {/* Main filter container – looks like a pill-enabled input */}
        <div
          className={`relative flex flex-1 items-center gap-1.5 flex-wrap pl-8 pr-28 py-1.5 bg-[var(--surface-2)] border rounded-md transition-[background-color,border-color,box-shadow] duration-150 cursor-text focus-within:border-[var(--border-focus)] focus-within:shadow-[var(--shadow-focus-glow)] ${hasContent ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}
          onClick={() => inputRef.current?.focus()}
        >
        {/* Search icon */}
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
        />

        {/* Sidebar and quick filters share the same applied-filter surface. */}
        {appliedFilters.map((filter) => (
          <span
            key={filter.id}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium border ${filter.style.bg} ${filter.style.text} ${filter.style.border}`}
          >
            <span>{filter.label}</span>
            <button
              onClick={(event) => {
                event.stopPropagation();
                removeAppliedFilter(filter);
              }}
              className="ml-0.5 opacity-50 hover:opacity-100 leading-none"
              aria-label={`Remove ${filter.label} filter`}
            >
              ×
            </button>
          </span>
        ))}

        {/* Committed token pills */}
        {committedTokens.map((token, i) => {
          if (!isStructuredToken(token)) {
            // Free-text committed tokens render as plain text badges
            return (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)]"
              >
                {token.value}
                <button
                  onClick={(e) => { e.stopPropagation(); removeToken(i); }}
                  className="ml-0.5 opacity-50 hover:opacity-100 leading-none"
                  aria-label={`Remove "${token.value}" filter`}
                >
                  ×
                </button>
              </span>
            );
          }
          const style = token.negated
            ? { bg: 'bg-red-500/15', text: 'text-red-300', border: 'border-red-500/30' }
            : TOKEN_STYLES[token.type];
          return (
            <span
              key={i}
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium border ${style.bg} ${style.text} ${style.border}`}
            >
              <span className="opacity-60">{token.negated ? '-' : ''}{token.type}:</span>
              <span>{getTokenDisplayValue(token, projects)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeToken(i); }}
                className="ml-0.5 opacity-50 hover:opacity-100 leading-none"
                aria-label={`Remove ${token.type}:${token.value} filter`}
              >
                ×
              </button>
            </span>
          );
        })}

        {/* Text input for the draft (what's currently being typed) */}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={handleDraftChange}
          onFocus={() => {
            setIsDraftFocused(true);
            if (draft.trim().length > 0) setShowAutocomplete(true);
          }}
          onBlur={() => setIsDraftFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder={appliedFilters.length === 0 && committedTokens.length === 0 ? placeholder : 'Add more filters…'}
          aria-label="Filter tasks by keyword"
          className={`${draft ? 'flex-none min-w-0' : 'flex-1 min-w-[120px]'} bg-transparent text-sm outline-none shadow-none border-none placeholder:text-[var(--text-muted)]`}
          style={draft ? { width: `calc(${Math.max(draft.length, 1)}ch + 0.25rem)` } : undefined}
        />
        {draft.trim().length > 0 && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleClearTextSearch();
            }}
            className={`-ml-1 p-0.5 rounded text-xs leading-none text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text-secondary)] focus-visible:opacity-100 transition-opacity ${isDraftFocused ? 'opacity-0 pointer-events-none' : 'opacity-70 hover:opacity-100'}`}
            title="Clear text search"
            aria-label="Clear text search"
          >
            ×
          </button>
        )}

        {/* Right-side actions */}
        <div className="absolute right-2 flex items-center gap-1.5">
          {hasContent && (
            <span className="text-xs text-[var(--text-muted)]">
              {filteredCount} {filteredCount === 1 ? 'match' : 'matches'}
            </span>
          )}

          {/* Help toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); setShowHelp((v) => !v); setShowAutocomplete(false); }}
            className="p-0.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            title="Show filter syntax help"
            aria-label="Show filter syntax help"
          >
            <HelpCircle size={13} />
          </button>

          {hasContent && (
            <button
              onClick={(e) => { e.stopPropagation(); handleClear(); }}
              className="p-0.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              title="Clear all filters (Esc)"
              aria-label="Clear all filters"
            >
              <X size={14} />
            </button>
          )}
          {hasContent && onSaveView && (
            <button
              onClick={(e) => { e.stopPropagation(); onSaveView(); }}
              className="p-0.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              title="Save as view"
              aria-label="Save current filters as a view"
            >
              <Save size={13} />
            </button>
          )}
        </div>
      </div>

        <TaskFilterBuilder
          tokens={committedTokens}
          sources={sources}
          sourceLists={sourceLists}
          tags={tags}
          assignees={assignees}
          projects={projects}
          hiddenCategories={hiddenBuilderFilters}
          onToggleToken={toggleBuilderToken}
        />
        {secondaryContent}
      </div>

      {/* Autocomplete dropdown */}
      {showAutocomplete && filteredSuggestions.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg shadow-lg z-50 py-1">
          {filteredSuggestions.map((s, i) => (
            <button
              key={s.prefix}
              onMouseDown={(e) => { e.preventDefault(); applyAutocomplete(s); }}
              className={`w-full text-left flex items-center gap-2 px-3 py-2 text-xs transition-colors ${i === acIndex ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-3)]'}`}
            >
              <span className="font-mono text-[var(--accent-400)] flex-shrink-0">{s.prefix}</span>
              <span className="text-[var(--text-muted)] truncate">{s.hint}</span>
            </button>
          ))}
        </div>
      )}

      {/* Help tooltip */}
      {showHelp && (
        <div className="absolute top-full right-0 mt-1 w-72 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg shadow-lg z-50 p-3">
          <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">Filter syntax</p>
          <table className="w-full text-[11px] border-collapse">
            <tbody>
              {HELP_ROWS.map(({ token, description }) => (
                <tr key={token} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="py-1 pr-3 font-mono text-[var(--accent-400)] whitespace-nowrap">{token}</td>
                  <td className="py-1 text-[var(--text-muted)]">{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-[var(--text-muted)]">
            Values in one category use OR; categories use AND. Quote values with spaces:{' '}
            <span className="font-mono">title:&quot;hello world&quot;</span>
          </p>
        </div>
      )}

      {/* Token summary strip (shown only when there are structured tokens) */}
      {structuredTokens.length > 0 && (
        <div className="mt-1 flex items-center gap-1 flex-wrap px-1">
          <span className="text-[10px] text-[var(--text-muted)]">Filtering:</span>
          {structuredTokens.map((t, i) => {
            const style = t.negated
              ? { bg: 'bg-red-500/15', text: 'text-red-300', border: 'border-red-500/30' }
              : TOKEN_STYLES[t.type];
            return (
              <span
                key={i}
                className={`text-[10px] font-mono px-1 py-0.5 rounded border ${style.bg} ${style.text} ${style.border}`}
              >
                {t.negated ? '-' : ''}{t.type}:{t.value}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getTokenDisplayValue(token: FilterToken, projects: HubProject[]): string {
  if (token.value === 'none') {
    const noneLabels: Partial<Record<FilterTokenType, string>> = {
      assignee: 'No assignee',
      due: 'No due date',
      list: 'No list',
      phase: 'No phase',
      priority: 'No priority',
      project: 'No project',
      tag: 'No tags',
    };
    return noneLabels[token.type] ?? token.value;
  }
  if (token.type === 'project') {
    return projects.find((project) => project.id === token.value)?.name ?? token.value;
  }
  if (token.type === 'phase') {
    for (const project of projects) {
      const phase = project.phases?.find((candidate) => candidate.id === token.value);
      if (phase) return `${project.name} › ${phase.name}`;
    }
  }
  return token.value;
}

function quoteFilterValue(value: string): string {
  return value.includes(' ') ? `"${value.replaceAll('"', '')}"` : value;
}

function getStoreFilterSnapshot(state: FilterSnapshot): FilterSnapshot {
  return {
    sourceFilter: state.sourceFilter,
    listFilter: state.listFilter,
    listGroupFilter: state.listGroupFilter,
    tagFilter: [...state.tagFilter],
    quickFilter: state.quickFilter,
    projectFilter: state.projectFilter,
    priorityFilter: [...state.priorityFilter],
    statusFilter: [...state.statusFilter],
    textFilter: state.textFilter,
  };
}

function filterSnapshotKey(snapshot: FilterSnapshot): string {
  return JSON.stringify(snapshot);
}

function taskFilterContextKey(context: TaskFilterContext): string {
  return JSON.stringify(context);
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}
