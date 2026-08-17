"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  DndContext,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  addDays,
  differenceInCalendarDays,
  format,
  isAfter,
  isBefore,
  startOfDay,
} from 'date-fns';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock3,
  Columns3,
  GripVertical,
  Layers3,
  Lightbulb,
  Link2,
  List,
  LoaderCircle,
  NotepadText,
  Network,
  Palette,
  PencilLine,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  TriangleAlert,
  Type,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import PhaseProposalReview, { type PhaseProposal } from '@/components/projects/PhaseProposalReview';
import { TaskPickerDialog } from '@/components/projects/TaskPickerDialog';
import { AddTaskModal } from '@/components/add-task';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import { TaskContextMenu, type TaskContextMenuActions, type HubProject } from '@/components/task-list/TaskContextMenu';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { ShowCompletedToggle } from '@/components/toolbar/ShowCompletedToggle';
import { dropdownVariants, fadeSlideUp, scaleIn, staggerContainer } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import type {
  AutoIncludeRule,
  LocalDisposition,
  ProjectHealth,
  ProjectStatus,
  SourceBinding,
  TaskPriority,
  TaskStatus,
} from '@/types';
import { COLOR_PRESETS, CONNECTOR_COLORS } from '@/lib/constants/colors';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  selectedTaskFieldBlockedReason,
  selectedTaskRemovalBlockedReason,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import { projectLogger } from '@/lib/client-logger';
import { getLocalToday as getClientToday, getLocalTomorrow as getClientTomorrow } from '@/lib/utils/client-date';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { fetchAllTasks } from '@/lib/tasks/fetch-all';
import {
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
  ProjectHierarchyClientError,
  ProjectHierarchyUndoTracker,
} from '@/lib/projects/hierarchy-client';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchySnapshot,
} from '@/lib/projects/hierarchy-types';
import { pushUndoWithToast, useUndoStore } from '@/lib/stores/undoStore';
import {
  BulkActionBar,
  BulkDispositionButtons,
  BulkDueDateDropdown,
  BulkPriorityDropdown,
  BulkStatusDropdown,
  BulkMoveToPhaseDropdown,
  executeBulkOperation,
  resolveSelectionAnchorIndex,
  useBulkSelection,
} from '@/components/bulk-actions';


import type {
  GanttPhaseRow,
  GanttZoom,
  PhaseItem,
  PhaseTaskEntry,
  PhaseViewMode,
  ProgressSummary,
  ProjectPhase,
  ProjectRecord,
  ProjectRuleMatch,
  ProjectTab,
  ProjectTask,
  TaskEffortFilter,
} from './types';
import {
  BUTTON_TRANSITION,
  GANTT_ROW_HEIGHT,
  HEALTH_LABELS,
  LEFT_GANTT_COLUMN_WIDTH,
  PHASE_STATUS_LABELS,
  PHASE_STATUS_ORDER,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TABS,
  TASK_STATUS_LABELS,
  ZOOM_CELL_WIDTH,
} from './constants';
import {
  buildGanttRows,
  buildTimelineSegments,
  formatDateLabel,
  formatRelativeTime,
  filterProjectTasks,
  getConnectorIcon,
  getHealthSummary,
  getPhaseColor,
  getPhaseStatusColor,
  getPriorityDotColor,
  getProgressSummary,
  getProjectTabCount,
  getProjectStatus,
  getTaskStatusColor,
  getTimelineRange,
  parseLocalDate,
  sortTasks,
  syncTaskPhaseMemberships,
  toRgba,
} from './utils';
import {
  DependencyArrows,
  DraggableTaskItem,
  DroppablePhaseZone,
  LoadingSkeleton,
  PhaseAddTaskMenu,
  PhaseStatusBadge,
  PriorityDot,
  ProjectOverviewKpis,
  SortablePhaseItem,
  StatusBadge,
  TaskDisplayId,
  TaskInfoBadges,
  TaskStatusBadge,
} from './components';
import { PhaseAssignView } from './PhaseAssignView';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { IconPickerButton } from '@/components/ui/icon-picker';
import { BurnReportCard } from '@/components/projects/BurnReportCard';
import { ViewInGraphLink } from '@/components/graph/ViewInGraphLink';
import { taskFilterContextForEntityCollection } from '@/lib/graph/graph-navigation';
import {
  countTaskFilters,
  EMPTY_TASK_FILTER_CONTEXT,
  updateTaskFilterContext,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import type {
  EnabledSource,
  HubProject as FilterHubProject,
  SourceList,
  TaskTag,
} from '@/types/dashboard';
import { resolveProjectIconColor } from '@/lib/projects/normalize-project';
import { ProjectActionsCard } from './ProjectActionsCard';

type AddTaskDest = { id: string; label: string; connectorType: string; account: 'personal' | 'work' | null; color: string; listSelectionMode?: 'required' | 'optional' | 'not-applicable' };
const LOCAL_DESTINATION: AddTaskDest = { id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' };
const ProjectStructureGraph = dynamic(
  () => import('@/components/graph/ProjectStructureGraph'),
  {
    ssr: false,
    loading: () => <div className="h-full min-h-0 animate-pulse rounded-xl bg-[var(--surface-0)]" />,
  },
);

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const projectId = Array.isArray(params.id) ? params.id[0] : params.id;
  const currentProjectIdRef = useRef(projectId);
  currentProjectIdRef.current = projectId;
  const initialTab = searchParams.get('tab') as ProjectTab | null;
  const initialAction = searchParams.get('action');

  // Persist last-selected project for quick return
  useEffect(() => {
    if (projectId) {
      try { localStorage.setItem('projects-last-selected', projectId); } catch { /* ignore */ }
    }
  }, [projectId]);

  const [activeTab, setActiveTab] = useState<ProjectTab>(initialTab || 'overview');
  const [phaseViewMode, setPhaseViewMode] = useState<PhaseViewMode>('list');
  const [reportingPhaseId, setReportingPhaseId] = useState<string | null>(null);
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>('week');
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [phases, setPhases] = useState<ProjectPhase[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [ruleMatches, setRuleMatches] = useState<ProjectRuleMatch[]>([]);
  const [ruleMatchesLoading, setRuleMatchesLoading] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const [phaseItemsByPhase, setPhaseItemsByPhase] = useState<Record<string, PhaseItem[]>>({});
  const hierarchyRevisionRef = useRef(0);
  const hierarchyProjectIdRef = useRef<string | null>(null);
  const hierarchyUndoTrackerRef = useRef(new ProjectHierarchyUndoTracker());
  const loadRequestIdRef = useRef(0);
  const loadedProjectIdRef = useRef<string | null>(null);
  const [hierarchyAnnouncement, setHierarchyAnnouncement] = useState('');
  const reportRefreshKey = useMemo(() => [
    ...tasks.map((task) => `${task.id}:${task.status}:${task.effort ?? ''}:${task.updatedAt}`),
    ...Object.entries(phaseItemsByPhase)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phaseId, items]) => `${phaseId}:${items.map((item) => item.taskId).sort().join(',')}`),
  ].join('|'), [phaseItemsByPhase, tasks]);
  const [collapsedPhaseIds, setCollapsedPhaseIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem(`project-phases-collapsed:${projectId}`);
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [phaseToRevealId, setPhaseToRevealId] = useState<string | null>(null);
  const phaseCardRefs = useRef(new Map<string, HTMLDivElement>());
  const [editingPhaseId, setEditingPhaseId] = useState<string | null>(null);
  const [editingPhaseName, setEditingPhaseName] = useState('');
  const [editingPhaseDescId, setEditingPhaseDescId] = useState<string | null>(null);
  const [editingPhaseDesc, setEditingPhaseDesc] = useState('');
  const [taskFilterContext, setTaskFilterContext] = useState<TaskFilterContext>(
    EMPTY_TASK_FILTER_CONTEXT,
  );
  const [taskEffortFilter, setTaskEffortFilter] = useState<TaskEffortFilter>('all');
  const [taskSortBy, setTaskSortBy] = useState<'priority' | 'dueDate' | 'updated' | 'title'>('priority');
  const [taskSortDir, setTaskSortDir] = useState<'asc' | 'desc'>('asc');
  const [myDayTaskIds, setMyDayTaskIds] = useState<Set<string>>(new Set());
  const [allProjects, setAllProjects] = useState<HubProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingPhase, setCreatingPhase] = useState(false);
  const savingPhaseCountsRef = useRef(new Map<string, number>());
  const [savingPhaseIds, setSavingPhaseIds] = useState<Set<string>>(new Set());
  const [proposal, setProposal] = useState<PhaseProposal | null>(null);
  const [isProposalOpen, setIsProposalOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const { setQuickAddFilter, clearQuickAddFilter } = useQuickAddContext();

  useEffect(() => {
    if (!project || project.id !== projectId) return;

    setQuickAddFilter({
      projectFilter: project.id,
      projectFilterName: project.name,
    });
    return () => clearQuickAddFilter();
  }, [clearQuickAddFilter, project?.id, project?.name, projectId, setQuickAddFilter]);

  function startSavingPhase(phaseId: string) {
    if (savingPhaseCountsRef.current.size > 0) return false;
    savingPhaseCountsRef.current.set(phaseId, 1);
    setSavingPhaseIds((current) => {
      if (current.has(phaseId)) return current;
      const next = new Set(current);
      next.add(phaseId);
      return next;
    });
    return true;
  }

  function finishSavingPhase(phaseId: string) {
    savingPhaseCountsRef.current.delete(phaseId);
    setSavingPhaseIds((current) => {
      if (!current.has(phaseId)) return current;
      const next = new Set(current);
      next.delete(phaseId);
      return next;
    });
  }
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });

  // Measure sticky header height for Plan toolbar offset
  const stickyHeaderRef = useRef<HTMLElement>(null);
  const [stickyHeaderHeight, setStickyHeaderHeight] = useState(0);
  const planToolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stickyHeaderRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setStickyHeaderHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [project]);

  useEffect(() => {
    if (
      !phaseToRevealId
      || activeTab !== 'phases'
      || phaseViewMode !== 'list'
      || collapsedPhaseIds.includes(phaseToRevealId)
    ) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      const phaseCard = phaseCardRefs.current.get(phaseToRevealId);
      if (!phaseCard) return;

      const planToolbarHeight = planToolbarRef.current?.getBoundingClientRect().height ?? 0;
      phaseCard.style.scrollMarginTop = `${stickyHeaderHeight + planToolbarHeight + 24}px`;
      phaseCard.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
      phaseCard.focus({ preventScroll: true });
      setPhaseToRevealId((current) => current === phaseToRevealId ? null : current);
    });

    return () => cancelAnimationFrame(frameId);
  }, [activeTab, collapsedPhaseIds, phaseToRevealId, phaseViewMode, prefersReducedMotion, stickyHeaderHeight]);

  // ── Connector capabilities for source binding warnings ──────────────────
  const [connectorListModes, setConnectorListModes] = useState<Record<string, string>>({});
  const [existingCategories, setExistingCategories] = useState<string[]>([]);
  const [categorySaved, setCategorySaved] = useState(false);

  useEffect(() => {
    fetch('/api/projects-overview')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.categories) return;
        const cats = (data.categories as { category: string }[]).map(c => c.category).filter(Boolean);
        setExistingCategories(cats);
      })
      .catch(() => {});
  }, []);

  const [addTaskDestinations, setAddTaskDestinations] = useState<AddTaskDest[]>([LOCAL_DESTINATION]);

  useEffect(() => {
    fetch('/api/features')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.taskDestinations) return;
        const modes: Record<string, string> = {};
        const dests: AddTaskDest[] = [];
        for (const td of data.taskDestinations) {
          const lsm = (td.listSelectionMode as AddTaskDest['listSelectionMode']) || undefined;
          modes[td.id] = td.listSelectionMode || 'not-applicable';
          dests.push({
            id: td.id,
            label: td.name,
            connectorType: td.type,
            account: (td.account as 'personal' | 'work') || null,
            color: CONNECTOR_COLORS[td.type] || 'var(--text-muted)',
            listSelectionMode: lsm,
          });
        }
        dests.push(LOCAL_DESTINATION);
        setConnectorListModes(modes);
        setAddTaskDestinations(dests);
      })
      .catch((err) => { projectLogger.error('Failed to fetch connector list modes', { err }); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Add-task flows ──────────────────────────────────────────────────────
  const [showCreateTaskForPhaseId, setShowCreateTaskForPhaseId] = useState<string | null>(null);
  const [showPickerForPhaseId, setShowPickerForPhaseId] = useState<string | null>(null);
  const [addTaskMenuPhaseId, setAddTaskMenuPhaseId] = useState<string | null>(null);
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false);

  // ── Task detail panel & actions ─────────────────────────────────────────
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const taskSelection = useTaskSelection({
    selectedTaskId,
    onSelectionChange: setSelectedTaskId,
  });
  const handleGraphTaskSelect = useCallback((taskId: string | null) => {
    taskSelection.cancelPendingDeselect();
    setSelectedTaskId(taskId);
  }, [taskSelection.cancelPendingDeselect]);
  const handlePhaseDependencyRemoved = useCallback((phaseId: string) => {
    setPhases((current) => current.map((phase) => (
      phase.id === phaseId ? { ...phase, startAfterPhaseId: null } : phase
    )));
  }, []);
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [phaseTaskSearch, setPhaseTaskSearch] = useState('');
  const bulk = useBulkSelection();
  const selectedBulkTasks = tasks.filter((task) => bulk.bulkSelected.has(task.id));
  const selectedBulkPolicies = selectedBulkTasks.map((task) => task.editPolicy);
  const bulkStatusBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'status');
  const bulkPriorityBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'priority');
  const bulkDueDateBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'dueDate');
  const bulkRemovalBlockedReason = selectedTaskRemovalBlockedReason(selectedBulkPolicies);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  useEffect(() => { setPortalContainer(document.body); }, []);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Use pointerWithin for precise task drops into phase zones, fall back to closestCenter for phase reordering
  const collisionDetection: CollisionDetection = useCallback((...args) => {
    const pointerCollisions = pointerWithin(...args);
    if (pointerCollisions.length > 0) return pointerCollisions;
    return closestCenter(...args);
  }, []);

  const applyHierarchySnapshot = useCallback((snapshot: ProjectHierarchySnapshot) => {
    if (snapshot.projectId !== currentProjectIdRef.current) return;
    if (
      hierarchyProjectIdRef.current === snapshot.projectId
      && snapshot.revision < hierarchyRevisionRef.current
    ) {
      return;
    }
    hierarchyProjectIdRef.current = snapshot.projectId;
    hierarchyRevisionRef.current = snapshot.revision;
    setPhases(snapshot.phases);
    setPhaseItemsByPhase(snapshot.phaseItemsByPhase);
    setTasks((current) => syncTaskPhaseMemberships(current, snapshot));
  }, []);

  const loadProjectTasks = useCallback(async () => {
    return fetchAllTasks<ProjectTask>(`/api/tasks?projectId=${projectId}&parentOnly=true&sortBy=updated`);
  }, [projectId]);

  const loadRuleMatches = useCallback(async () => {
    setRuleMatchesLoading(true);
    try {
      const response = await fetch(`/api/hub-projects/${projectId}/rule-matches`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || 'Failed to load qualifying tasks');
      }
      const payload = (await response.json()) as { matches?: ProjectRuleMatch[] };
      if (projectId === currentProjectIdRef.current) setRuleMatches(payload.matches ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load qualifying tasks');
    } finally {
      if (projectId === currentProjectIdRef.current) setRuleMatchesLoading(false);
    }
  }, [projectId]);

  const updateAutoIncludeRules = useCallback(async (
    updated: AutoIncludeRule[],
    successMessage?: string,
  ) => {
    setSavingRules(true);
    try {
      const response = await fetch(`/api/hub-projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoIncludeRules: updated }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        evaluation?: { added: number };
        evaluationFailed?: boolean;
      } | null;
      if (!response.ok) throw new Error(payload?.error || 'Failed to update rules');

      setProject((previous) => previous ? { ...previous, autoIncludeRules: updated } : previous);
      const [currentTasks] = await Promise.all([loadProjectTasks(), loadRuleMatches()]);
      if (projectId === currentProjectIdRef.current) setTasks(currentTasks);
      if (payload?.evaluationFailed) {
        toast.warning('Rule saved, but matching tasks could not be added. Try refreshing the preview.');
      } else if (successMessage) {
        const added = payload?.evaluation?.added ?? 0;
        toast.success(added > 0 ? `${successMessage} · ${added} task${added === 1 ? '' : 's'} added` : successMessage);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update rules');
      throw error;
    } finally {
      if (projectId === currentProjectIdRef.current) setSavingRules(false);
    }
  }, [loadProjectTasks, loadRuleMatches, projectId]);

  const restoreAutoIncludedTask = useCallback(async (taskId: string) => {
    setSavingRules(true);
    try {
      const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || 'Failed to restore task');

      const [currentTasks] = await Promise.all([loadProjectTasks(), loadRuleMatches()]);
      if (projectId === currentProjectIdRef.current) setTasks(currentTasks);
      toast.success('Task restored to auto-include');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore task');
    } finally {
      if (projectId === currentProjectIdRef.current) setSavingRules(false);
    }
  }, [loadProjectTasks, loadRuleMatches, projectId]);

  const discardHierarchyUndos = useCallback(() => {
    const undoEntryIds = hierarchyUndoTrackerRef.current.clear();
    for (const undoEntryId of undoEntryIds) {
      useUndoStore.getState().removeEntry(undoEntryId);
      toast.dismiss(undoEntryId);
    }
  }, []);

  const reconcileHierarchyConflict = useCallback(async (snapshot: ProjectHierarchySnapshot) => {
    if (snapshot.projectId !== currentProjectIdRef.current) return;
    discardHierarchyUndos();
    applyHierarchySnapshot(snapshot);
    try {
      const currentTasks = await loadProjectTasks();
      if (projectId === currentProjectIdRef.current) setTasks(currentTasks);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reconcile project tasks');
    }
  }, [applyHierarchySnapshot, discardHierarchyUndos, loadProjectTasks, projectId]);

  const runHierarchyCommand = useCallback(async (
    command: ProjectHierarchyCommand,
    options: { undoLabel: string; announcement: string },
  ) => {
    const commandId = crypto.randomUUID();
    try {
      const result = await executeProjectHierarchyCommand({
        projectId,
        expectedRevision: hierarchyRevisionRef.current,
        command,
        commandId,
      });
      if (projectId !== currentProjectIdRef.current) return result;
      applyHierarchySnapshot(result.hierarchy);
      hierarchyUndoTrackerRef.current.push(commandId, result.revision);
      setHierarchyAnnouncement(options.announcement);
      const undoEntryId = pushUndoWithToast(options.undoLabel, async () => {
        try {
          const undoResult = await executeProjectHierarchyCommand({
            projectId,
            expectedRevision: hierarchyUndoTrackerRef.current.expectedRevision(commandId),
            command: result.inverseCommand,
          });
          applyHierarchySnapshot(undoResult.hierarchy);
          hierarchyUndoTrackerRef.current.complete(commandId, undoResult.revision);
          setHierarchyAnnouncement(`Undid: ${options.announcement}`);
        } catch (error) {
          if (error instanceof ProjectHierarchyClientError && error.current) {
            await reconcileHierarchyConflict(error.current);
          }
          throw error;
        }
      }, {
        validationError: () => hierarchyUndoTrackerRef.current.validationError(commandId),
      });
      hierarchyUndoTrackerRef.current.attachUndoEntry(commandId, undoEntryId);
      return result;
    } catch (error) {
      if (error instanceof ProjectHierarchyClientError && error.current) {
        await reconcileHierarchyConflict(error.current);
      }
      throw error;
    }
  }, [applyHierarchySnapshot, projectId, reconcileHierarchyConflict]);

  const loadProjectDetail = useCallback(async (
    { background = false }: { background?: boolean } = {},
  ) => {
    if (!projectId) return;
    const requestId = ++loadRequestIdRef.current;
    const projectChanged = loadedProjectIdRef.current !== projectId;
    const refreshInBackground = background && loadedProjectIdRef.current === projectId;

    if (projectChanged) {
      setTaskFilterContext(EMPTY_TASK_FILTER_CONTEXT);
      setTaskEffortFilter('all');
    }
    if (!refreshInBackground) {
      setLoading(true);
      setError(null);
    }

    try {
      const [projectResponse, hierarchy, tasksResponse] = await Promise.all([
        fetch(`/api/hub-projects/${projectId}`),
        loadProjectHierarchy(projectId),
        loadProjectTasks(),
      ]);

      if (!projectResponse.ok) {
        const payload = (await projectResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || 'Failed to load project');
      }
      const projectPayload = (await projectResponse.json()) as { project: ProjectRecord };
      if (
        requestId !== loadRequestIdRef.current
        || projectId !== currentProjectIdRef.current
      ) return;

      setProject(projectPayload.project);
      loadedProjectIdRef.current = projectId;
      if (
        hierarchyProjectIdRef.current === hierarchy.projectId
        && hierarchy.revision !== hierarchyRevisionRef.current
      ) {
        discardHierarchyUndos();
      }
      applyHierarchySnapshot(hierarchy);
      setTasks(syncTaskPhaseMemberships(tasksResponse, hierarchy));
    } catch (caughtError) {
      if (
        requestId !== loadRequestIdRef.current
        || projectId !== currentProjectIdRef.current
      ) return;
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to load project detail';
      if (!refreshInBackground) setError(message);
      toast.error(message);
    } finally {
      if (
        requestId === loadRequestIdRef.current
        && projectId === currentProjectIdRef.current
      ) {
        setLoading(false);
      }
    }
  }, [applyHierarchySnapshot, discardHierarchyUndos, loadProjectTasks, projectId]);

  const refreshProjectHierarchy = useCallback(async () => {
    const hierarchy = await loadProjectHierarchy(projectId);
    if (hierarchy.revision !== hierarchyRevisionRef.current) discardHierarchyUndos();
    applyHierarchySnapshot(hierarchy);
  }, [applyHierarchySnapshot, discardHierarchyUndos, projectId]);

  useEffect(() => {
    discardHierarchyUndos();
    void loadProjectDetail();
  }, [discardHierarchyUndos, loadProjectDetail]);

  useEffect(() => {
    if (activeTab === 'settings') void loadRuleMatches();
  }, [activeTab, loadRuleMatches]);

  // Re-fetch project data when a sync completes (refetchKey increments)
  const { progress: syncProgress } = useSyncStream();
  const prevRefetchKeyRef = useRef(syncProgress.refetchKey);
  useEffect(() => {
    if (syncProgress.refetchKey > prevRefetchKeyRef.current) {
      prevRefetchKeyRef.current = syncProgress.refetchKey;
      const timeoutId = window.setTimeout(() => {
        void loadProjectDetail({ background: true });
      }, 500);
      return () => window.clearTimeout(timeoutId);
    }
  }, [syncProgress.refetchKey, loadProjectDetail]);

  // Load My Day task IDs for context menu integration
  useEffect(() => {
    fetch('/api/my-day')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.items) {
          setMyDayTaskIds(new Set((data.items as { taskId: string }[]).map(i => i.taskId)));
        }
      })
      .catch(() => {});
  }, []);

  // Load all projects for "Add to Project" context menu
  useEffect(() => {
    fetch('/api/hub-projects?includePhases=true')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.projects) {
          setAllProjects(data.projects as HubProject[]);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-trigger AI suggest when navigated with ?action=ai-suggest
  useEffect(() => {
    if (initialAction === 'ai-suggest' && !loading && project && !isGenerating && !isProposalOpen) {
      void handleGeneratePhaseProposal();
    }
    // Only run once after initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, project]);

  const progress = useMemo(() => getProgressSummary(tasks), [tasks]);
  const health = useMemo(() => {
    if (!project) {
      return { health: 'on_track' as ProjectHealth, message: 'Loading health…' };
    }
    return getHealthSummary(project, phases, tasks, progress);
  }, [phases, progress, project, tasks]);

  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task] as const)), [tasks]);
  const proposalTaskMap = useMemo(
    () =>
      new Map(
        tasks.map((task) => [
          task.id,
          {
            id: task.id,
            title: task.title,
            priority: task.priority,
            status: task.status,
            connectorType: task.connectorType,
          },
        ] as const),
      ),
    [tasks],
  );
  const phaseEntries = useMemo(() => {
    return phases.reduce<Record<string, PhaseTaskEntry[]>>((accumulator, phase) => {
      const entries = (phaseItemsByPhase[phase.id] ?? [])
        .map((item) => {
          const task = taskMap.get(item.taskId);
          return task ? { item, task } : null;
        })
        .filter((entry): entry is PhaseTaskEntry => entry !== null);
      accumulator[phase.id] = entries;
      return accumulator;
    }, {});
  }, [phaseItemsByPhase, phases, taskMap]);
  const graphRefreshKey = useMemo(() => JSON.stringify({
    phases: phases.map((phase) => [
      phase.id,
      phase.status,
      phase.startAfterPhaseId,
      phase.updatedAt,
    ]),
    phaseItems: Object.entries(phaseItemsByPhase).map(([phaseId, items]) => [
      phaseId,
      items.map((item) => item.taskId),
    ]),
    tasks: tasks.map((task) => [task.id, task.status, task.updatedAt]),
  }), [phaseItemsByPhase, phases, tasks]);

  const taskToPhase = useMemo(() => {
    const mapping = new Map<string, ProjectPhase>();
    for (const phase of phases) {
      for (const item of phaseItemsByPhase[phase.id] ?? []) {
        if (!mapping.has(item.taskId)) {
          mapping.set(item.taskId, phase);
        }
      }
    }
    return mapping;
  }, [phaseItemsByPhase, phases]);

  const phaseMenuItems = useMemo(() => phases.map((p) => ({ id: p.id, name: p.name })), [phases]);

  // Tasks in the project that are not assigned to any phase
  const unassignedTasks = useMemo(() => {
    if (phases.length === 0) return [];
    return tasks.filter((t) => !taskToPhase.has(t.id));
  }, [tasks, taskToPhase, phases]);

  // Flat ordered list of all task IDs shown in the Plan list view (for shift-click range selection)
  const planListTaskIds = useMemo(() => {
    const ids: string[] = [];
    for (const phase of phases) {
      const entries = phaseEntries[phase.id] ?? [];
      for (const { task } of entries) ids.push(task.id);
    }
    for (const task of unassignedTasks) ids.push(task.id);
    return ids;
  }, [phases, phaseEntries, unassignedTasks]);

  const handleBulkModifierClick = useCallback((taskId: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const clickedIndex = planListTaskIds.indexOf(taskId);
    if (e.shiftKey) {
      const enteringBulk = !bulk.bulkMode;
      if (enteringBulk) bulk.enterBulkMode();
      const lastIndex = resolveSelectionAnchorIndex(
        planListTaskIds,
        bulk.lastClickedIndexRef.current,
        enteringBulk ? selectedTaskId : null,
      );
      if (lastIndex !== null && lastIndex !== clickedIndex) {
        const start = Math.min(lastIndex, clickedIndex);
        const end = Math.max(lastIndex, clickedIndex);
        bulk.setBulkSelected((prev) => {
          const next = new Set(prev);
          if (enteringBulk && selectedTaskId) next.add(selectedTaskId);
          for (let i = start; i <= end; i++) {
            const id = planListTaskIds[i];
            if (id) next.add(id);
          }
          return next;
        });
      } else {
        bulk.setBulkSelected((prev) => {
          const next = new Set(prev);
          if (enteringBulk && selectedTaskId) next.add(selectedTaskId);
          next.add(taskId);
          return next;
        });
      }
      bulk.lastClickedIndexRef.current = clickedIndex;
    } else if (e.ctrlKey || e.metaKey) {
      const enteringBulk = !bulk.bulkMode;
      if (enteringBulk) bulk.enterBulkMode();
      bulk.setBulkSelected((prev) => {
        const next = new Set(prev);
        if (enteringBulk && selectedTaskId) next.add(selectedTaskId);
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        return next;
      });
      bulk.lastClickedIndexRef.current = clickedIndex;
    }
  }, [planListTaskIds, bulk, selectedTaskId]);

  const recentActivity = useMemo(
    () => [...tasks].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()).slice(0, 4),
    [tasks],
  );
  const projectTaskSources = useMemo<EnabledSource[]>(() => {
    const connectorTypes = [...new Set(tasks.map((task) => task.connectorType))];
    return connectorTypes.map((connectorType) => ({
      type: connectorType,
      name: addTaskDestinations.find((destination) => (
        destination.connectorType === connectorType
      ))?.label || connectorType,
      icon: '',
    }));
  }, [addTaskDestinations, tasks]);
  const projectTaskSourceLists = useMemo<SourceList[]>(() => {
    const lists = new Map<string, SourceList>();
    for (const task of tasks) {
      if (!task.sourceListName) continue;
      const sourceId = task.sourceListId || task.sourceListName.toLowerCase();
      const key = `${task.connectorInstanceId}:${sourceId}`;
      const existing = lists.get(key);
      lists.set(key, {
        id: key,
        sourceId,
        connectorInstanceId: task.connectorInstanceId,
        name: task.sourceListName,
        taskCount: (existing?.taskCount ?? 0) + 1,
        groupId: null,
      });
    }
    return [...lists.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [tasks]);
  const projectTaskTags = useMemo<TaskTag[]>(() => {
    const tags = new Map<string, TaskTag>();
    for (const task of tasks) {
      for (const tag of task.tags ?? []) {
        const existing = tags.get(tag.slug);
        tags.set(tag.slug, { ...tag, count: (existing?.count ?? 0) + 1 });
      }
    }
    return [...tags.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [tasks]);
  const projectTaskAssignees = useMemo(
    () => [...new Set(tasks.map((task) => task.assignee?.trim()).filter((value): value is string => Boolean(value)))].sort(),
    [tasks],
  );
  const projectTaskFilterProjects = useMemo<FilterHubProject[]>(() => (
    project
      ? [{
          id: project.id,
          name: project.name,
          color: project.color,
          icon: project.icon,
          phases: phases.map((phase) => ({ id: phase.id, name: phase.name })),
        }]
      : []
  ), [phases, project]);
  const filteredTasks = useMemo(() => {
    const filtered = filterProjectTasks(tasks, taskFilterContext, projectId)
      .filter((task) => taskEffortFilter === 'all' || task.effort === taskEffortFilter);
    return sortTasks(filtered, taskSortBy, taskSortDir);
  }, [projectId, taskEffortFilter, taskFilterContext, taskSortBy, taskSortDir, tasks]);
  const hasProjectTaskFilters = (
    countTaskFilters(taskFilterContext)
    - (taskFilterContext.completion === 'all' ? 1 : 0)
  ) > 0
    || taskEffortFilter !== 'all';
  const clearProjectTaskFilters = useCallback(() => {
    setTaskFilterContext((current) => ({
      ...EMPTY_TASK_FILTER_CONTEXT,
      completion: current.completion,
    }));
    setTaskEffortFilter('all');
  }, []);

  const ganttRows = useMemo(() => buildGanttRows(phases, phaseEntries, project), [phaseEntries, phases, project]);
  const timelineRange = useMemo(() => getTimelineRange(ganttRows), [ganttRows]);
  const timelineCellWidth = ZOOM_CELL_WIDTH[ganttZoom];
  const timelineWidth = (differenceInCalendarDays(timelineRange.end, timelineRange.start) + 1) * timelineCellWidth;
  const timelineSegments = useMemo(
    () => buildTimelineSegments(timelineRange.start, timelineRange.end, ganttZoom, timelineCellWidth),
    [ganttZoom, timelineCellWidth, timelineRange.end, timelineRange.start],
  );
  const todayMarkerOffset = differenceInCalendarDays(startOfDay(new Date()), timelineRange.start) * timelineCellWidth;
  const lastUpdated = useMemo(() => {
    const timestamps = [project?.updatedAt, ...phases.map((phase) => phase.updatedAt), ...tasks.map((task) => task.updatedAt)]
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((value) => !Number.isNaN(value));
    return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
  }, [phases, project?.updatedAt, tasks]);

  async function handleAddPhase() {
    if (!project) return;
    if (!startSavingPhase('__create__')) return;
    setCreatingPhase(true);
    try {
      const nextSortOrder = phases.length > 0 ? Math.max(...phases.map((phase) => phase.sortOrder)) + 1 : 0;
      const response = await fetch('/api/project-phases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          name: `Phase ${phases.length + 1}`,
          color: project.color,
          sortOrder: nextSortOrder,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { phase?: ProjectPhase; error?: string } | null;
      if (!response.ok || !payload?.phase) {
        throw new Error(payload?.error || 'Failed to create phase');
      }

      const createdPhase = payload.phase;
      setPhases((current) => [...current, createdPhase].sort((left, right) => left.sortOrder - right.sortOrder));
      setPhaseItemsByPhase((current) => ({ ...current, [createdPhase.id]: [] }));
      await refreshProjectHierarchy();
      setCollapsedPhaseIds((current) => current.filter((phaseId) => phaseId !== createdPhase.id));
      setActiveTab('phases');
      setEditingPhaseId(createdPhase.id);
      setEditingPhaseName(createdPhase.name);
      toast.success('Phase added');
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to create phase');
    } finally {
      setCreatingPhase(false);
      finishSavingPhase('__create__');
    }
  }

  async function handleGeneratePhaseProposal() {
    if (!projectId) return;

    setIsGenerating(true);
    try {
      const response = await fetch('/api/project-phases/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });

      const payload = (await response.json().catch(() => null)) as { proposal?: PhaseProposal; error?: string } | null;
      if (!response.ok || !payload?.proposal) {
        throw new Error(payload?.error || 'Failed to generate phase proposal');
      }

      setProposal(payload.proposal);
      setIsProposalOpen(true);
      toast.success('AI phase proposal ready');
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to generate phase proposal');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleRefinePhases() {
    if (!projectId || phases.length === 0) return;

    setIsRefining(true);
    try {
      const currentPhases = phases.map((phase) => ({
        name: phase.name,
        taskIds: (phaseItemsByPhase[phase.id] ?? []).map((item) => item.taskId),
      }));

      const response = await fetch('/api/project-phases/ai-refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, currentPhases }),
      });

      const payload = (await response.json().catch(() => null)) as { proposal?: PhaseProposal; error?: string } | null;
      if (!response.ok || !payload?.proposal) {
        throw new Error(payload?.error || 'Failed to refine phase plan');
      }

      setProposal(payload.proposal);
      setIsProposalOpen(true);
      toast.success('AI refinement ready for review');
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to refine phase plan');
    } finally {
      setIsRefining(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveDragId(null);

    if (!over || active.id === over.id) return;

    const activeType = active.data.current?.type;
    if (activeType === 'phase') {
      await handlePhaseDragEnd(event);
    } else if (activeType === 'task') {
      await handleTaskDragEnd(event);
    }
  }

  async function handlePhaseDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (!over || active.id === over.id) return;

    const activeId = String(active.id).replace('phase:', '');
    const overId = String(over.id).replace('phase:', '');

    const oldIndex = phases.findIndex((p) => p.id === activeId);
    const newIndex = phases.findIndex((p) => p.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;

    const previousPhases = phases;
    const reordered = arrayMove(phases, oldIndex, newIndex);
    setPhases(reordered);

    try {
      const phaseName = phases[oldIndex]?.name ?? 'Phase';
      await runHierarchyCommand({
        type: 'reorder_phases',
        orderedPhaseIds: reordered.map((phase) => phase.id),
      }, {
        undoLabel: 'Phase order updated',
        announcement: `Moved ${phaseName} to position ${newIndex + 1} of ${phases.length}`,
      });
    } catch (error) {
      if (!(error instanceof ProjectHierarchyClientError && error.current)) {
        setPhases(previousPhases);
      }
      toast.error(error instanceof Error ? error.message : 'Failed to save phase order');
    }
  }

  async function handleTaskDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (!over) return;

    const taskId = String(active.id).replace('task:', '');
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !canEditTaskField(task.editPolicy, 'phases')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'phases'));
      return;
    }
    const overStr = String(over.id);
    const sourcePhaseId = phases.find((phase) => (
      (phaseItemsByPhase[phase.id] ?? []).some((item) => item.taskId === taskId)
    ))?.id ?? null;
    let targetPhaseId: string | null = null;
    let targetIndex = 0;
    const droppedOnUnassigned = overStr === 'unassigned-drop'
      || over.data.current?.type === 'unassigned-drop';
    if (droppedOnUnassigned) {
      if (!sourcePhaseId) return;
    } else if (overStr.startsWith('phase-drop:')) {
      targetPhaseId = overStr.replace('phase-drop:', '');
      targetIndex = (phaseItemsByPhase[targetPhaseId] ?? []).length;
    } else if (overStr.startsWith('phase:')) {
      targetPhaseId = overStr.replace('phase:', '');
      targetIndex = (phaseItemsByPhase[targetPhaseId] ?? []).length;
    } else if (overStr.startsWith('task:')) {
      const overTaskId = overStr.replace('task:', '');
      targetPhaseId = phases.find((phase) => (
        (phaseItemsByPhase[phase.id] ?? []).some((item) => item.taskId === overTaskId)
      ))?.id ?? null;
      if (targetPhaseId) {
        targetIndex = (phaseItemsByPhase[targetPhaseId] ?? [])
          .findIndex((item) => item.taskId === overTaskId);
      }
    }

    if (!droppedOnUnassigned && !targetPhaseId) return;
    if (sourcePhaseId === targetPhaseId && targetPhaseId) {
      const sourceItems = phaseItemsByPhase[targetPhaseId] ?? [];
      const sourceIndex = sourceItems.findIndex((item) => item.taskId === taskId);
      if (sourceIndex === targetIndex) return;
    }

    const previousState = phaseItemsByPhase;
    setPhaseItemsByPhase((current) => {
      const next: Record<string, PhaseItem[]> = Object.fromEntries(
        Object.entries(current).map(([phaseId, items]) => [
          phaseId,
          items.filter((item) => item.taskId !== taskId)
            .map((item, index) => ({ ...item, sortOrder: index })),
        ]),
      );
      if (targetPhaseId) {
        const existing = Object.values(current).flat()
          .find((item) => item.taskId === taskId);
        const targetItems = next[targetPhaseId] ?? [];
        targetItems.splice(Math.min(targetIndex, targetItems.length), 0, existing
          ? { ...existing, phaseId: targetPhaseId }
          : {
              id: `temp-${taskId}`,
              phaseId: targetPhaseId,
              taskId,
              sortOrder: 0,
              estimatedEffortHours: null,
              isProposed: false,
              proposalType: null,
              createdAt: new Date().toISOString(),
            });
        next[targetPhaseId] = targetItems.map((item, index) => ({ ...item, sortOrder: index }));
      }
      return next;
    });

    const taskName = taskMap.get(taskId)?.title ?? 'Task';
    const targetPhaseName = targetPhaseId
      ? phases.find((phase) => phase.id === targetPhaseId)?.name ?? 'phase'
      : 'Unassigned';
    try {
      await runHierarchyCommand({
        type: 'move_tasks',
        taskIds: [taskId],
        toPhaseId: targetPhaseId,
        toIndex: targetIndex,
      }, {
        undoLabel: `Moved ${taskName}`,
        announcement: `Moved ${taskName} to ${targetPhaseName}`,
      });
    } catch (error) {
      if (!(error instanceof ProjectHierarchyClientError && error.current)) {
        setPhaseItemsByPhase(previousState);
      }
      toast.error(error instanceof Error ? error.message : 'Failed to move task');
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  // ── Task actions (complete, priority, status, due date, delete) ────────
  function requireEditableTask(taskId: string, field: 'status' | 'priority' | 'dueDate'): ProjectTask | null {
    const task = tasks.find((candidate) => candidate.id === taskId) ?? null;
    if (task && canEditTaskField(task.editPolicy, field)) return task;
    toast.error(taskFieldBlockedReason(task?.editPolicy, field));
    return null;
  }

  async function handleCompleteTask(taskId: string) {
    const task = requireEditableTask(taskId, 'status');
    if (!task) return;

    const previousStatus = task.status;
    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        setTasks((current) => current.map((candidate) => (
          candidate.id === taskId ? { ...candidate, status: 'done' as TaskStatus } : candidate
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
    if (!requireEditableTask(taskId, 'priority')) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      if (!response.ok) throw new Error('Failed to set priority');
      setTasks((current) => current.map((t) => (t.id === taskId ? { ...t, priority: priority as TaskPriority } : t)));
    } catch {
      toast.error('Failed to set priority');
    }
  }

  async function handleSetTaskStatus(taskId: string, status: string) {
    if (!requireEditableTask(taskId, 'status')) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Failed to set status');
      setTasks((current) => current.map((t) => (t.id === taskId ? { ...t, status: status as TaskStatus } : t)));
    } catch {
      toast.error('Failed to set status');
    }
  }

  async function handleSetTaskDueDate(taskId: string, date: string) {
    if (!requireEditableTask(taskId, 'dueDate')) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: date || null }),
      });
      if (!response.ok) throw new Error('Failed to set due date');
      setTasks((current) => current.map((t) => (t.id === taskId ? { ...t, dueDate: date || null } : t)));
    } catch {
      toast.error('Failed to set due date');
    }
  }

  async function handleSetTaskLocalDisposition(taskId: string, disposition: LocalDisposition) {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || !canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, disposition)) {
        toast.error(task
          ? taskDispositionBlockedReason(task.editPolicy, task.localDisposition, disposition)
          : 'Task disposition is unavailable');
        return;
      }
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
        toast.error(error instanceof Error ? error.message : 'Failed to update Mission Control state');
    }
  }

  async function handleDeleteTask(taskId: string) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !canRemoveTask(task.editPolicy)) {
      toast.error(task?.editPolicy.removalReason ?? 'This task cannot be removed');
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete task');
      setTasks((current) => current.filter((t) => t.id !== taskId));
      // Also remove from any phase items
      setPhaseItemsByPhase((current) => {
        const next: Record<string, PhaseItem[]> = {};
        for (const [phaseId, items] of Object.entries(current)) {
          next[phaseId] = items.filter((item) => item.taskId !== taskId);
        }
        return next;
      });
      if (selectedTaskId === taskId) setSelectedTaskId(null);
      await refreshProjectHierarchy();
      toast.success('Task deleted');
    } catch {
      toast.error('Failed to delete task');
    }
  }

  function handleRemoveFromProject(taskId: string) {
    const previousTasks = tasks;
    const previousPhaseItems = phaseItemsByPhase;
    const previousSelectedTaskId = selectedTaskId;

    setTasks((current) => current.filter((t) => t.id !== taskId));
    setPhaseItemsByPhase((current) => {
      const next: Record<string, PhaseItem[]> = {};
      for (const [phaseId, items] of Object.entries(current)) {
        next[phaseId] = items.filter((item) => item.taskId !== taskId);
      }
      return next;
    });
    if (selectedTaskId === taskId) setSelectedTaskId(null);

    let undone = false;
    toast.success('Removed from project', {
      action: {
        label: 'Undo',
        onClick: () => {
          undone = true;
          setTasks(previousTasks);
          setPhaseItemsByPhase(previousPhaseItems);
          setSelectedTaskId(previousSelectedTaskId);
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
            setPhaseItemsByPhase(previousPhaseItems);
            setSelectedTaskId(previousSelectedTaskId);
            toast.error('Failed to remove task from project');
          } else {
            await refreshProjectHierarchy();
          }
        } catch {
          setTasks(previousTasks);
          setPhaseItemsByPhase(previousPhaseItems);
          setSelectedTaskId(previousSelectedTaskId);
          toast.error('Failed to remove task from project');
        }
      }
    }, 5500);
  }

  async function handleAddToProject(taskId: string, targetProjectId: string, phaseId?: string | null) {
    const targetProject = allProjects.find((p) => p.id === targetProjectId);

    if (targetProjectId === projectId) {
      // Same project — treat as a phase move
      void handleMoveTaskToPhase(taskId, phaseId ?? null);
      return;
    }

    // Different project — add task to that project
    try {
      const res = await fetch(`/api/hub-projects/${targetProjectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, phaseId: phaseId ?? null }),
      });
      if (!res.ok) throw new Error('Failed to add to project');

      const phaseName = phaseId
        ? targetProject?.phases?.find((p) => p.id === phaseId)?.name ?? null
        : null;
      const label = phaseName
        ? `Moved to ${targetProject?.name || 'project'} → ${phaseName}`
        : `Moved to ${targetProject?.name || 'project'} → No phase`;
      toast.success(label);

      // Update local hubProjectIds
      setTasks((prev) => prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              hubProjectIds: [...(t.hubProjectIds || []).filter((id) => id !== targetProjectId), targetProjectId],
              projectPhaseMemberships: [
                ...(t.projectPhaseMemberships || []).filter((membership) => membership.projectId !== targetProjectId),
                {
                  projectId: targetProjectId,
                  projectName: targetProject?.name || 'Unknown Project',
                  phaseId: phaseId ?? null,
                  phaseName,
                },
              ],
            }
          : t
      ));
    } catch {
      toast.error('Failed to add task to project');
    }
  }

  function getTaskContextActions(task: ProjectTask): TaskContextMenuActions {
    return {
      onComplete: () => void handleCompleteTask(task.id),
      onSetPriority: (priority) => void handleSetTaskPriority(task.id, priority),
      onSetStatus: (status) => void handleSetTaskStatus(task.id, status),
      onAddToMyDay: () => void handleAddToMyDay(task.id),
      onRemoveFromMyDay: () => void handleRemoveFromMyDay(task.id),
      onMoveToPhase: (phaseId) => void handleMoveTaskToPhase(task.id, phaseId),
      onAddToProject: (targetProjectId, phaseId) => void handleAddToProject(task.id, targetProjectId, phaseId),
      onDueToday: () => void handleSetTaskDueDate(task.id, getClientToday()),
      onDueTomorrow: () => void handleSetTaskDueDate(task.id, getClientTomorrow()),
      onPickDate: (date) => void handleSetTaskDueDate(task.id, date),
      onClearDueDate: () => void handleSetTaskDueDate(task.id, ''),
      onSetLocalDisposition: (disposition) => void handleSetTaskLocalDisposition(task.id, disposition),
      onRemoveFromProject: () => void handleRemoveFromProject(task.id),
      onDelete: () => void handleDeleteTask(task.id),
    };
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
    const currentPhaseId = taskToPhase.get(taskId)?.id ?? null;
    if (currentPhaseId === targetPhaseId) return;
    const taskName = taskMap.get(taskId)?.title ?? 'Task';
    const phaseName = targetPhaseId
      ? phases.find((phase) => phase.id === targetPhaseId)?.name ?? 'phase'
      : 'No phase';
    try {
      await runHierarchyCommand({
        type: 'move_tasks',
        taskIds: [taskId],
        toPhaseId: targetPhaseId,
        toIndex: targetPhaseId ? (phaseItemsByPhase[targetPhaseId] ?? []).length : 0,
      }, {
        undoLabel: `Moved ${taskName} to ${phaseName}`,
        announcement: `Moved ${taskName} to ${phaseName}`,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to move task');
    }
  }

  async function renamePhase(phase: ProjectPhase, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === phase.name) {
      return;
    }

    if (!startSavingPhase(phase.id)) return;
    try {
      const response = await fetch(`/api/project-phases/${phase.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const payload = (await response.json().catch(() => null)) as { phase?: ProjectPhase; error?: string } | null;
      if (!response.ok || !payload?.phase) {
        throw new Error(payload?.error || 'Failed to rename phase');
      }

      setPhases((current) => current.map((entry) => (entry.id === phase.id ? payload.phase! : entry)));
      await refreshProjectHierarchy();
      toast.success('Phase renamed');
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to rename phase');
    } finally {
      finishSavingPhase(phase.id);
    }
  }

  async function commitPhaseName(phase: ProjectPhase) {
    const name = editingPhaseName;
    setEditingPhaseId(null);
    setEditingPhaseName('');
    await renamePhase(phase, name);
  }

  const ALLOWED_PHASE_FIELDS = new Set(['name', 'description', 'status', 'color', 'estimatedDays', 'targetStart', 'targetEnd', 'startAfterPhaseId', 'sortOrder']);

  async function handleUpdatePhaseField(phaseId: string, field: string, value: unknown) {
    if (!ALLOWED_PHASE_FIELDS.has(field)) {
      toast.error(`Invalid field: ${field}`);
      return;
    }
    if (!startSavingPhase(phaseId)) return;
    try {
      const response = await fetch(`/api/project-phases/${phaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      const payload = (await response.json().catch(() => null)) as { phase?: ProjectPhase; error?: string } | null;
      if (!response.ok || !payload?.phase) {
        throw new Error(payload?.error || 'Failed to update phase');
      }

      setPhases((current) => current.map((entry) => (entry.id === phaseId ? payload.phase! : entry)));
      await refreshProjectHierarchy();
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to update phase');
    } finally {
      finishSavingPhase(phaseId);
    }
  }

  async function handleDeletePhase(phase: ProjectPhase) {
    setConfirmDialog({
      open: true,
      title: 'Delete phase?',
      message: `Delete "${phase.name}"? Tasks in this phase will be unassigned. This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog((d) => ({ ...d, open: false }));
        if (!startSavingPhase(phase.id)) return;
        try {
          const response = await fetch(`/api/project-phases/${phase.id}`, { method: 'DELETE' });
          const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null;
          if (!response.ok || !payload?.success) {
            throw new Error(payload?.error || 'Failed to delete phase');
          }

          setPhases((current) => current.filter((entry) => entry.id !== phase.id));
          setPhaseItemsByPhase((current) => {
            const next = { ...current };
            delete next[phase.id];
            return next;
          });
          setCollapsedPhaseIds((current) => current.filter((phaseId) => phaseId !== phase.id));
          await refreshProjectHierarchy();
          toast.success('Phase deleted');
        } catch (caughtError) {
          toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to delete phase');
        } finally {
          finishSavingPhase(phase.id);
        }
      },
    });
  }

  async function handleCyclePhaseStatus(phase: ProjectPhase) {
    const currentIndex = PHASE_STATUS_ORDER.indexOf(phase.status);
    const nextStatus = PHASE_STATUS_ORDER[(currentIndex + 1) % PHASE_STATUS_ORDER.length];

    if (!startSavingPhase(phase.id)) return;
    try {
      const response = await fetch(`/api/project-phases/${phase.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: nextStatus,
          completedAt: nextStatus === 'completed' ? new Date().toISOString() : null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { phase?: ProjectPhase; error?: string } | null;
      if (!response.ok || !payload?.phase) {
        throw new Error(payload?.error || 'Failed to update phase');
      }

      setPhases((current) => current.map((entry) => (entry.id === phase.id ? payload.phase! : entry)));
      await refreshProjectHierarchy();
      toast.success(`Phase marked ${PHASE_STATUS_LABELS[nextStatus].toLowerCase()}`);
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to update phase');
    } finally {
      finishSavingPhase(phase.id);
    }
  }

  function togglePhaseCollapsed(phaseId: string) {
    setCollapsedPhaseIds((current) => {
      const next = current.includes(phaseId) ? current.filter((entry) => entry !== phaseId) : [...current, phaseId];
      try { localStorage.setItem(`project-phases-collapsed:${projectId}`, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function openPhaseInPlan(phaseId: string) {
    setActiveTab('phases');
    setPhaseViewMode('list');
    setCollapsedPhaseIds((current) => {
      const next = current.filter((entry) => entry !== phaseId);
      try { localStorage.setItem(`project-phases-collapsed:${projectId}`, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setPhaseToRevealId(phaseId);
  }

  function collapseAllPhases() {
    const allIds = phases.map((p) => p.id);
    setCollapsedPhaseIds(allIds);
    try { localStorage.setItem(`project-phases-collapsed:${projectId}`, JSON.stringify(allIds)); } catch { /* ignore */ }
  }

  function expandAllPhases() {
    setCollapsedPhaseIds([]);
    try { localStorage.setItem(`project-phases-collapsed:${projectId}`, JSON.stringify([])); } catch { /* ignore */ }
  }

  /** Assign an existing task to this project and optionally to a phase */
  async function handleAddExistingTasksToPhase(taskIds: string[], phaseId: string | null) {
    if (!project) return;
    try {
      // 1. Assign each task to the project
      await Promise.all(
        taskIds.map((taskId) =>
          fetch(`/api/hub-projects/${project.id}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId }),
          }),
        ),
      );

      // 2. If a target phase was specified, also add each task to that phase
      if (phaseId) {
        const existingItems = phaseItemsByPhase[phaseId] ?? [];
        const startOrder = existingItems.length > 0 ? Math.max(...existingItems.map((i) => i.sortOrder)) + 1 : 0;

        await Promise.all(
          taskIds.map((taskId, index) =>
            fetch(`/api/project-phases/${phaseId}/items`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ taskId, sortOrder: startOrder + index }),
            }),
          ),
        );
      }

      toast.success(`Added ${taskIds.length} task${taskIds.length > 1 ? 's' : ''}`);
      void loadProjectDetail({ background: true });
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to add tasks');
    }
  }

  /** Handle a newly created task — assign to project and optionally to a phase */
  async function handleNewTaskCreated(taskId: string, phaseId: string | null) {
    if (!project) return;
    try {
      // The task was already created with projectIds via AddTaskModal.
      // If a target phase was specified, also add the task to that phase.
      if (phaseId) {
        const existingItems = phaseItemsByPhase[phaseId] ?? [];
        const nextOrder = existingItems.length > 0 ? Math.max(...existingItems.map((i) => i.sortOrder)) + 1 : 0;

        await fetch(`/api/project-phases/${phaseId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, sortOrder: nextOrder }),
        });
      }

      void loadProjectDetail({ background: true });
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : 'Failed to assign task to phase');
    }
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Project unavailable</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href="/projects">Back to Projects</Link>
              </Button>
              <Button onClick={() => void loadProjectDetail()}>Retry</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Project not found</CardTitle>
            <CardDescription>The requested project could not be located.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/projects">Back to Projects</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isGraphView = activeTab === 'phases' && phaseViewMode === 'graph';
  const excludedRuleMatches = ruleMatches.filter((match) => match.excluded);
  const activeRuleMatches = ruleMatches.filter((match) => !match.excluded);

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
    <motion.div
      className={cn(
        'min-h-0 min-w-0 flex-1',
        isGraphView ? 'flex flex-col overflow-y-auto' : 'space-y-6 overflow-y-auto',
      )}
      variants={staggerContainer}
      initial="hidden"
      animate="show"
    >
      {/* Compact sticky header */}
      <motion.section ref={stickyHeaderRef} variants={scaleIn} className="sticky top-0 z-20 bg-[var(--surface-0)]">
        <div className="border-b border-[var(--border)] px-4 sm:px-6">
          {/* Top row: title + stats */}
          <div className="flex items-center gap-3 py-3">
            {project.metadata?.syncManaged ? (
              <Image src="/icons/connectors/github.svg" alt="GitHub" width={14} height={14} className="flex-shrink-0 opacity-80" />
            ) : project.icon ? (
              <IconRenderer value={project.icon} size={18} color={project.color} />
            ) : (
              <span className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} aria-hidden="true" />
            )}
            <h1 className="text-lg font-semibold leading-tight text-[var(--text-primary)] truncate flex-1">
              {project.name}
            </h1>
            <div className="hidden sm:flex items-center gap-4 text-xs text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
              <span><span className="font-semibold text-[var(--text-primary)]">{progress.percentComplete}%</span> done</span>
              <span><span className="font-semibold text-[var(--text-primary)]">{progress.totalTasks}</span> tasks</span>
              <span><span className="font-semibold text-[var(--text-primary)]">{phases.length}</span> phases</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <StatusBadge status={getProjectStatus(project)} />
              {project.category ? <Badge variant="outline">{project.category}</Badge> : null}
              <ViewInGraphLink
                context={taskFilterContextForEntityCollection({ type: 'project', id: projectId })}
                origin={{
                  href: `/projects/${encodeURIComponent(projectId)}?tab=${encodeURIComponent(activeTab)}`,
                  label: project.name,
                }}
                compact
                className="h-7 min-h-7 min-w-7 border border-[var(--border)]"
              />
              <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs text-[var(--text-secondary)]">
                <Link href={`/kanban?projectId=${projectId}`}>
                  <Columns3 className="h-3.5 w-3.5" />
                  <span className="hidden md:inline">Kanban</span>
                </Link>
              </Button>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 -mb-px">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const count = getProjectTabCount(tab.id, phases.length, tasks.length);
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'px-3 py-2 text-sm font-medium border-b-2 transition-colors duration-150',
                    isActive
                      ? 'border-[var(--accent-400)] text-[var(--text-primary)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border)]',
                  )}
                >
                  {tab.label}{count !== null ? ` (${count})` : ''}
                </button>
              );
            })}
          </div>
        </div>
      </motion.section>

      <div className={cn(
        'px-4 pb-6 sm:px-6',
        isGraphView ? 'flex min-h-[32rem] flex-1 flex-col pt-6' : 'space-y-6',
      )}>
      {activeTab === 'overview' ? (
        <motion.section variants={fadeSlideUp} className="space-y-6">
          <ProjectOverviewKpis progress={progress} health={health} />

          <BurnReportCard
            projectId={projectId}
            scopeName={project.name}
            refreshKey={reportRefreshKey}
            onTaskSelect={handleGraphTaskSelect}
          />

          <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
                <CardDescription>Project context and current direction.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-6 text-[var(--text-secondary)] text-pretty">
                  {project.description || 'No project description has been added yet.'}
                </p>
                <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">Progress snapshot</p>
                      <p className="text-xs text-[var(--text-tertiary)]">Completion rolls up from all tasks currently assigned to this project.</p>
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{progress.percentComplete}%</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${progress.percentComplete}%`, backgroundColor: project.color }} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
                <CardDescription>Latest task updates plus overall freshness.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-secondary)]">
                  Last updated <span className="font-medium text-[var(--text-primary)]">{formatRelativeTime(lastUpdated)}</span>
                </div>
                <div className="space-y-2">
                  {recentActivity.length === 0 ? (
                    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-tertiary)]">
                      No recent task activity yet.
                    </div>
                  ) : (
                    recentActivity.map((task) => {
                      const ConnectorIcon = getConnectorIcon(task.connectorType);
                      return (
                        <div
                          key={task.id}
                          className={cn(
                            'flex min-h-10 items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                            selectedTaskId === task.id && 'ring-1 ring-[var(--accent-400)] border-[var(--accent-400)]',
                          )}
                          onClick={() => taskSelection.toggleTask(task.id)}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{task.title}</p>
                              <TaskDisplayId task={task} />
                              <TaskInfoBadges task={task} />
                            </div>
                            <p className="mt-1 text-xs text-[var(--text-tertiary)]">Updated {formatRelativeTime(task.updatedAt)}</p>
                          </div>
                          <TaskStatusBadge status={task.status} statusReason={task.statusReason} />
                        </div>
                      );
                    })
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Phase progress</CardTitle>
                <CardDescription>Status of each project phase.</CardDescription>
              </CardHeader>
              <CardContent>
                {phases.length === 0 ? (
                  <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-tertiary)]">
                    No phases defined yet. <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setActiveTab('phases')}>Set up phases →</button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {phases.map((phase) => {
                      const entries = phaseEntries[phase.id] ?? [];
                      const doneTasks = entries.filter(({ task }) => task.status === 'done').length;
                      const pct = entries.length > 0 ? Math.round((doneTasks / entries.length) * 100) : 0;
                      const phaseColor = getPhaseColor(phase, project);
                      return (
                        <button
                          key={phase.id}
                          type="button"
                          onClick={() => openPhaseInPlan(phase.id)}
                          className="block w-full space-y-1.5 rounded-[var(--radius-md)] p-1 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                          aria-label={`Open ${phase.name} in Plan`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: phaseColor }} />
                              <span className="text-sm font-medium text-[var(--text-primary)]">{phase.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <PhaseStatusBadge status={phase.status} />
                              <span className="text-xs text-[var(--text-tertiary)] tabular-nums">{doneTasks}/{entries.length}</span>
                            </div>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                            <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${pct}%`, backgroundColor: phaseColor }} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Key dates</CardTitle>
                <CardDescription>Current schedule anchors for the project lifecycle.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3">
                  <span className="text-sm text-[var(--text-secondary)]">Started</span>
                  <span className="text-sm font-medium text-[var(--text-primary)]">{formatDateLabel(project.startedAt)}</span>
                </div>
                <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3">
                  <span className="text-sm text-[var(--text-secondary)]">Target date</span>
                  <span className="text-sm font-medium text-[var(--text-primary)]">{formatDateLabel(project.targetDate)}</span>
                </div>
                <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3">
                  <span className="text-sm text-[var(--text-secondary)]">Completed</span>
                  <span className="text-sm font-medium text-[var(--text-primary)]">{formatDateLabel(project.completedAt)}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </motion.section>
      ) : null}

      {activeTab === 'phases' ? (
        <motion.section
          variants={fadeSlideUp}
          className={cn(isGraphView ? 'flex min-h-0 flex-1 flex-col' : 'space-y-6')}
        >
          <Card className={cn(isGraphView && 'flex min-h-0 flex-1 flex-col overflow-hidden')}>
            <CardHeader
              ref={planToolbarRef}
              className={cn(
                'z-10 gap-4 rounded-t-[var(--radius-lg)] border-b border-[var(--border-subtle)] bg-[var(--surface-1)] sm:flex-row sm:items-center sm:justify-between sm:space-y-0',
                isGraphView ? 'relative shrink-0' : 'sticky',
              )}
              style={isGraphView ? undefined : { top: stickyHeaderHeight }}
            >
              <div>
                <CardTitle>Plan</CardTitle>
                <CardDescription>Organize tasks into phases. Right-click tasks for actions.</CardDescription>
                <p className="sr-only" aria-live="polite" aria-atomic="true">
                  {hierarchyAnnouncement}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {phaseViewMode !== 'assign' && phaseViewMode !== 'graph' && (
                <div className="flex items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-3 h-9">
                  <Search size={14} className="text-[var(--text-tertiary)]" />
                  <input
                    type="text"
                    placeholder="Filter tasks…"
                    value={phaseTaskSearch}
                    onChange={(e) => setPhaseTaskSearch(e.target.value)}
                    className="bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none w-28"
                  />
                  {phaseTaskSearch && (
                    <button type="button" onClick={() => setPhaseTaskSearch('')} className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                      <X size={12} />
                    </button>
                  )}
                </div>
                )}
                <div className="flex rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-0.5">
                  {(['list', 'gantt', 'graph', 'assign'] as const).map((viewMode) => (
                    <button
                      key={viewMode}
                      type="button"
                      onClick={() => { setPhaseViewMode(viewMode); if (viewMode !== 'list') bulk.clearSelection(); }}
                      className={cn(
                        'h-8 rounded-[var(--radius-md)] px-3 text-sm font-medium capitalize',
                        BUTTON_TRANSITION,
                        phaseViewMode === viewMode
                          ? 'bg-[var(--accent-600)] text-white shadow-[var(--shadow-sm)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] active:scale-[0.96]',
                      )}
                    >
                      {viewMode === 'graph' ? <Network size={14} className="mr-1.5 inline" /> : null}
                      {viewMode}
                    </button>
                  ))}
                </div>
                {phaseViewMode === 'gantt' ? (
                  <div className="flex rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-0.5">
                    {(['day', 'week', 'month'] as const).map((zoom) => (
                      <button
                        key={zoom}
                        type="button"
                        onClick={() => setGanttZoom(zoom)}
                        className={cn(
                          'h-8 rounded-[var(--radius-md)] px-3 text-sm font-medium capitalize',
                          BUTTON_TRANSITION,
                          ganttZoom === zoom
                            ? 'bg-[var(--accent-600)] text-white shadow-[var(--shadow-sm)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] active:scale-[0.96]',
                        )}
                      >
                        {zoom}
                      </button>
                    ))}
                  </div>
                ) : null}
                {phaseViewMode !== 'assign' && (
                <>
                {phaseViewMode === 'list' && phases.length > 0 && (
                  <div className="flex rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-0.5">
                    <Tooltip content="Expand all phases">
                      <button
                        type="button"
                        onClick={expandAllPhases}
                        disabled={collapsedPhaseIds.length === 0}
                        className={cn('h-8 rounded-[var(--radius-md)] px-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none', BUTTON_TRANSITION)}
                        aria-label="Expand all phases"
                      >
                        <ChevronsUpDown size={16} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Collapse all phases">
                      <button
                        type="button"
                        onClick={collapseAllPhases}
                        disabled={collapsedPhaseIds.length === phases.length}
                        className={cn('h-8 rounded-[var(--radius-md)] px-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none', BUTTON_TRANSITION)}
                        aria-label="Collapse all phases"
                      >
                        <ChevronsDownUp size={16} />
                      </button>
                    </Tooltip>
                  </div>
                )}
                {phaseViewMode === 'list' && tasks.length > 0 && !bulk.bulkMode && (
                  <button
                    type="button"
                    onClick={bulk.enterBulkMode}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                  >
                    Select
                  </button>
                )}
                <Button variant="outline" className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 hover:text-purple-300" onClick={() => void handleGeneratePhaseProposal()} disabled={isGenerating || isRefining}>
                  {isGenerating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                  AI Suggest Phases
                </Button>
                {phases.length > 0 ? (
                  <Button variant="outline" className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 hover:text-purple-300" onClick={() => void handleRefinePhases()} disabled={isRefining || isGenerating}>
                    {isRefining ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                    Refine Plan
                  </Button>
                ) : null}
                <Button onClick={handleAddPhase} disabled={creatingPhase || savingPhaseIds.size > 0}>
                  {creatingPhase ? <LoaderCircle className="animate-spin" /> : <Plus />}
                  Add phase
                </Button>
                </>
                )}
              </div>
              {/* Bulk action bar inside sticky header so it stays visible when scrolled */}
              {bulk.bulkMode && phaseViewMode === 'list' && (
                <div className="border-t border-[var(--border-subtle)]">
                  <BulkActionBar selectedCount={bulk.bulkSelected.size} onCancel={bulk.clearSelection}>
                    <button
                      disabled={Boolean(bulkStatusBlockedReason)}
                      title={bulkStatusBlockedReason}
                      onClick={async () => {
                        const ids = Array.from(bulk.bulkSelected);
                        const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) }), `Completed ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                        if (failed.length === 0) {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, status: 'done' as TaskStatus } : t));
                          bulk.clearSelection();
                        } else {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) && !failed.includes(t.id) ? { ...t, status: 'done' as TaskStatus } : t));
                          bulk.setBulkSelected(new Set(failed));
                        }
                      }}
                      className="text-xs px-2 py-1 bg-green-900/30 text-green-300 border border-green-800/40 rounded-[var(--radius-sm)] hover:bg-green-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Check size={12} className="inline" /> Complete
                    </button>
                    <BulkStatusDropdown
                      disabled={Boolean(bulkStatusBlockedReason)}
                      disabledReason={bulkStatusBlockedReason}
                      onSetStatus={async (status) => {
                        const ids = Array.from(bulk.bulkSelected);
                        const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }), `Status set on ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                        if (failed.length === 0) {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, status: status as TaskStatus } : t));
                          bulk.clearSelection();
                        } else {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) && !failed.includes(t.id) ? { ...t, status: status as TaskStatus } : t));
                          bulk.setBulkSelected(new Set(failed));
                        }
                      }}
                    />
                    <BulkPriorityDropdown
                      disabled={Boolean(bulkPriorityBlockedReason)}
                      disabledReason={bulkPriorityBlockedReason}
                      onSetPriority={async (priority) => {
                        const ids = Array.from(bulk.bulkSelected);
                        const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority }) }), `Priority set on ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                        if (failed.length === 0) {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, priority: priority as TaskPriority } : t));
                          bulk.clearSelection();
                        } else {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) && !failed.includes(t.id) ? { ...t, priority: priority as TaskPriority } : t));
                          bulk.setBulkSelected(new Set(failed));
                        }
                      }}
                    />
                    <BulkDueDateDropdown
                      disabled={Boolean(bulkDueDateBlockedReason)}
                      disabledReason={bulkDueDateBlockedReason}
                      onSetDate={async (date) => {
                        const ids = Array.from(bulk.bulkSelected);
                        const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dueDate: date || null }) }), date ? `Due date set on ${ids.length} task${ids.length > 1 ? 's' : ''}` : `Due date cleared on ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                        if (failed.length === 0) {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, dueDate: date || null } : t));
                          bulk.clearSelection();
                        } else {
                          setTasks((prev) => prev.map((t) => ids.includes(t.id) && !failed.includes(t.id) ? { ...t, dueDate: date || null } : t));
                          bulk.setBulkSelected(new Set(failed));
                        }
                      }}
                    />
                    <BulkDispositionButtons
                      tasks={selectedBulkTasks}
                      onSetDisposition={async (localDisposition) => {
                        const ids = Array.from(bulk.bulkSelected);
                        const { failed } = await executeBulkOperation(
                          ids,
                          (id) => fetch(`/api/tasks/${id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ localDisposition }),
                          }),
                          localDisposition === 'handled'
                            ? `Marked ${ids.length} task${ids.length > 1 ? 's' : ''} handled in Mission Control`
                            : `Dismissed ${ids.length} task${ids.length > 1 ? 's' : ''} in Mission Control`,
                        );
                        setTasks((current) => current.filter((task) => (
                          !ids.includes(task.id) || failed.includes(task.id)
                        )));
                        if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                        else bulk.clearSelection();
                      }}
                    />
                    {phases.length > 0 && (
                      <BulkMoveToPhaseDropdown
                        phases={phaseMenuItems}
                        onMoveToPhase={async (targetPhaseId) => {
                          const ids = Array.from(bulk.bulkSelected);
                          const phaseName = targetPhaseId ? phases.find((p) => p.id === targetPhaseId)?.name : 'Unassigned';
                          try {
                            await runHierarchyCommand({
                              type: 'move_tasks',
                              taskIds: ids,
                              toPhaseId: targetPhaseId,
                              toIndex: targetPhaseId ? (phaseItemsByPhase[targetPhaseId] ?? []).length : 0,
                            }, {
                              undoLabel: `Moved ${ids.length} task${ids.length > 1 ? 's' : ''} to ${phaseName}`,
                              announcement: `Moved ${ids.length} task${ids.length > 1 ? 's' : ''} to ${phaseName}`,
                            });
                            bulk.clearSelection();
                          } catch (error) {
                            toast.error(error instanceof Error ? error.message : 'Failed to move tasks');
                          }
                        }}
                      />
                    )}
                    <button
                      onClick={async () => {
                        const ids = Array.from(bulk.bulkSelected);
                        const previousTasks = tasks;
                        const previousPhaseItems = phaseItemsByPhase;
                        setTasks((prev) => prev.filter((t) => !ids.includes(t.id)));
                        setPhaseItemsByPhase((current) => {
                          const next: Record<string, PhaseItem[]> = {};
                          for (const [phaseId, items] of Object.entries(current)) {
                            next[phaseId] = items.filter((item) => !ids.includes(item.taskId));
                          }
                          return next;
                        });
                        bulk.clearSelection();

                        let undone = false;
                        toast.success(`Removed ${ids.length} task${ids.length > 1 ? 's' : ''} from project`, {
                          action: {
                            label: 'Undo',
                            onClick: () => {
                              undone = true;
                              setTasks(previousTasks);
                              setPhaseItemsByPhase(previousPhaseItems);
                            },
                          },
                          duration: 5000,
                        });

                        setTimeout(async () => {
                          if (!undone) {
                            let failed = 0;
                            for (const id of ids) {
                              try {
                                const res = await fetch(`/api/hub-projects/${projectId}/tasks`, {
                                  method: 'DELETE',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ taskId: id }),
                                });
                                if (!res.ok) failed++;
                              } catch { failed++; }
                            }
                            await refreshProjectHierarchy();
                            if (failed > 0) {
                              setTasks(previousTasks);
                              setPhaseItemsByPhase(previousPhaseItems);
                              toast.error(`Failed to remove ${failed} task${failed > 1 ? 's' : ''}`);
                            }
                          }
                        }, 5500);
                      }}
                      className="text-xs px-2 py-1 bg-slate-900/30 text-slate-300 border border-slate-800/40 rounded-[var(--radius-sm)] hover:bg-slate-900/50 transition-colors duration-100"
                    >
                      Remove from project
                    </button>
                    <button
                      onClick={() => {
                        const count = bulk.bulkSelected.size;
                        setConfirmDialog({
                          open: true,
                          title: `Delete ${count} task${count > 1 ? 's' : ''}?`,
                          message: 'Each selected task will be deleted locally, cancelled locally, closed, or deleted at its source according to its task policy.',
                          confirmLabel: 'Remove tasks',
                          variant: 'danger',
                          onConfirm: async () => {
                            setConfirmDialog((d) => ({ ...d, open: false }));
                            const ids = Array.from(bulk.bulkSelected);
                            const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/tasks/${id}`, { method: 'DELETE' }), `${ids.length} task${ids.length > 1 ? 's' : ''} deleted`);
                            if (failed.length === 0) {
                              setTasks((prev) => prev.filter((t) => !ids.includes(t.id)));
                              setPhaseItemsByPhase((current) => {
                                const next: Record<string, PhaseItem[]> = {};
                                for (const [phaseId, items] of Object.entries(current)) {
                                  next[phaseId] = items.filter((item) => !ids.includes(item.taskId));
                                }
                                return next;
                              });
                              bulk.clearSelection();
                            } else {
                              const succeeded = ids.filter((id) => !failed.includes(id));
                              setTasks((prev) => prev.filter((t) => !succeeded.includes(t.id)));
                              setPhaseItemsByPhase((current) => {
                                const next: Record<string, PhaseItem[]> = {};
                                for (const [phaseId, items] of Object.entries(current)) {
                                  next[phaseId] = items.filter((item) => !succeeded.includes(item.taskId));
                                }
                                return next;
                              });
                              bulk.setBulkSelected(new Set(failed));
                            }
                          },
                        });
                      }}
                      disabled={Boolean(bulkRemovalBlockedReason)}
                      title={bulkRemovalBlockedReason}
                      className="text-xs px-2 py-1 bg-red-900/30 text-red-300 border border-red-800/40 rounded-[var(--radius-sm)] hover:bg-red-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 size={12} className="inline" /> Delete
                    </button>
                  </BulkActionBar>
                </div>
              )}
            </CardHeader>

            {/* AI Insights - inline hints based on phase data */}
            {phases.length >= 2 && (() => {
              const insights: Array<{ type: 'gap' | 'stale' | 'overlap'; message: string }> = [];
              const stalePhasesCount = phases.filter((p) => p.status === 'in_progress').length;
              if (stalePhasesCount > 2) {
                insights.push({ type: 'stale', message: `${stalePhasesCount} phases are marked in-progress simultaneously — consider focusing on fewer.` });
              }
              const emptyPhases = phases.filter((p) => (phaseEntries[p.id] ?? []).length === 0);
              if (emptyPhases.length > 0) {
                insights.push({ type: 'gap', message: `${emptyPhases.length} phase${emptyPhases.length > 1 ? 's have' : ' has'} no items — add tasks or use "AI Suggest" to populate.` });
              }
              for (let i = 0; i < phases.length - 1; i++) {
                const current = phases[i];
                const next = phases[i + 1];
                if (current.targetEnd && next.targetStart && new Date(current.targetEnd) > new Date(next.targetStart)) {
                  insights.push({ type: 'overlap', message: `"${current.name}" overlaps with "${next.name}" — verify this is intentional.` });
                  break;
                }
              }
              if (insights.length === 0) return null;
              return (
                <div className="mx-6 mb-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Lightbulb size={13} className="text-purple-400" />
                    <span className="text-[12px] font-semibold uppercase tracking-wider text-purple-400">Insights</span>
                  </div>
                  <div className="space-y-1.5">
                    {insights.slice(0, 3).map((insight, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                        <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-purple-400 flex-shrink-0" />
                        <span>{insight.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <CardContent className={cn(isGraphView && 'min-h-0 flex-1')}>
              {phases.length === 0 && phaseViewMode !== 'graph' ? (
                <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-8 text-center">
                  <p className="text-sm font-medium text-[var(--text-primary)]">No phases yet</p>
                  <p className="mt-2 text-sm text-[var(--text-tertiary)]">Create the first phase to start shaping delivery.</p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <Button variant="secondary" onClick={() => void handleGeneratePhaseProposal()} disabled={isGenerating}>
                      {isGenerating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                      AI Suggest Phases
                    </Button>
                    <Button onClick={handleAddPhase} disabled={creatingPhase || savingPhaseIds.size > 0}>
                      <Plus />
                      Add first phase
                    </Button>
                  </div>
                </div>
              ) : phaseViewMode === 'graph' ? (
                <ProjectStructureGraph
                  projectId={projectId}
                  refreshKey={graphRefreshKey}
                  selectedTaskId={selectedTaskId}
                  onTaskSelect={handleGraphTaskSelect}
                  onPhaseDependencyRemoved={handlePhaseDependencyRemoved}
                />
              ) : phaseViewMode === 'list' ? (
                <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                  <SortableContext items={phases.map((p) => `phase:${p.id}`)} strategy={verticalListSortingStrategy}>
                    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-4">
                      {phases.map((phase) => {
                        const allEntries = phaseEntries[phase.id] ?? [];
                        const entries = phaseTaskSearch
                          ? allEntries.filter(({ task }) => task.title.toLowerCase().includes(phaseTaskSearch.toLowerCase()))
                          : allEntries;
                        const isCollapsed = collapsedPhaseIds.includes(phase.id);
                        const isEditing = editingPhaseId === phase.id;
                        const isSaving = savingPhaseIds.has(phase.id);
                        const isPhaseMutationDisabled = savingPhaseIds.size > 0;
                        const phaseColor = getPhaseColor(phase, project);

                        // Progress for this phase
                        const doneCount = allEntries.filter(({ task }) => task.status === 'done').length;
                        const totalCount = allEntries.length;
                        const pctComplete = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
                        return (
                          <SortablePhaseItem key={phase.id} phaseId={phase.id} isMenuOpen={addTaskMenuPhaseId === phase.id}>
                            {(dragHandleProps) => (
                              <div
                                ref={(node) => {
                                  if (node) phaseCardRefs.current.set(phase.id, node);
                                  else phaseCardRefs.current.delete(phase.id);
                                }}
                                tabIndex={-1}
                                role="region"
                                aria-label={`${phase.name} phase`}
                                className="overflow-visible rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] shadow-[0_1px_0_rgba(255,255,255,0.04),0_14px_32px_rgba(0,0,0,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                                style={{ scrollMarginTop: stickyHeaderHeight + 24 }}
                              >
                                {/* ── Phase Header ── */}
                                <div className="relative rounded-t-[var(--radius-lg)] bg-gradient-to-r from-[var(--surface-1)] to-[var(--surface-0)]" style={{ borderLeft: `3px solid ${phaseColor}` }}>
                                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="flex min-w-0 gap-3">
                                      <button
                                        type="button"
                                        {...dragHandleProps}
                                        className={cn('mt-0.5 inline-flex min-h-10 min-w-10 cursor-grab items-center justify-center rounded-[10px] text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] active:cursor-grabbing active:scale-[0.96]', BUTTON_TRANSITION)}
                                        aria-label="Drag to reorder phase"
                                      >
                                        <GripVertical size={16} />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => togglePhaseCollapsed(phase.id)}
                                        className={cn('mt-0.5 inline-flex min-h-10 min-w-10 items-center justify-center rounded-[10px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] active:scale-[0.96]', BUTTON_TRANSITION)}
                                        aria-label={isCollapsed ? 'Expand phase tasks' : 'Collapse phase tasks'}
                                      >
                                        {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                                      </button>
                                      <div className="min-w-0 space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                          {isEditing ? (
                                            <input
                                              value={editingPhaseName}
                                              onChange={(event) => setEditingPhaseName(event.target.value)}
                                              onBlur={() => void commitPhaseName(phase)}
                                              onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                  event.preventDefault();
                                                  void commitPhaseName(phase);
                                                }
                                                if (event.key === 'Escape') {
                                                  setEditingPhaseId(null);
                                                  setEditingPhaseName('');
                                                }
                                              }}
                                              autoFocus
                                              className="min-h-10 w-full max-w-md rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] outline-none"
                                            />
                                          ) : (
                                            <button
                                              type="button"
                                              disabled={isPhaseMutationDisabled}
                                              className="text-left text-base font-semibold text-[var(--text-primary)] cursor-pointer hover:text-[var(--accent)] transition-colors disabled:pointer-events-none"
                                              onClick={() => {
                                                setEditingPhaseId(phase.id);
                                                setEditingPhaseName(phase.name);
                                              }}
                                              title="Click to rename"
                                            >
                                              {phase.name}
                                            </button>
                                          )}
                                          <button type="button" onClick={() => void handleCyclePhaseStatus(phase)} disabled={isPhaseMutationDisabled} title="Click to cycle status">
                                            <PhaseStatusBadge status={phase.status} />
                                          </button>
                                          {/* Task count — read-only pill, visually distinct */}
                                          <span className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
                                            <Layers3 size={11} />
                                            {phaseTaskSearch ? `${entries.length}/${allEntries.length}` : entries.length} {allEntries.length === 1 ? 'task' : 'tasks'}
                                          </span>
                                          {/* Progress indicator */}
                                          {totalCount > 0 && (
                                            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                                              <span className="font-medium text-[var(--text-secondary)]">{doneCount}/{totalCount}</span>
                                              <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-[var(--surface-2)]">
                                                <span
                                                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
                                                  style={{ width: `${pctComplete}%`, backgroundColor: pctComplete === 100 ? 'var(--success, #22c55e)' : phaseColor }}
                                                />
                                              </span>
                                              <span className="tabular-nums">{pctComplete}%</span>
                                            </span>
                                          )}
                                          {/* Description icon when no description exists */}
                                          {!phase.description && editingPhaseDescId !== phase.id && (
                                            <Tooltip content="Add description">
                                              <button
                                                type="button"
                                                onClick={() => { setEditingPhaseDescId(phase.id); setEditingPhaseDesc(''); }}
                                                disabled={isPhaseMutationDisabled}
                                                className={cn('inline-flex min-h-7 min-w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] active:scale-[0.96]', BUTTON_TRANSITION)}
                                                aria-label="Add description"
                                              >
                                                <NotepadText size={14} />
                                              </button>
                                            </Tooltip>
                                          )}
                                          {isSaving ? <LoaderCircle size={14} className="animate-spin text-[var(--text-tertiary)]" /> : null}
                                        </div>
                                        {/* Description row — only show when there IS a description or when editing */}
                                        {editingPhaseDescId === phase.id ? (
                                          <textarea
                                            value={editingPhaseDesc}
                                            disabled={isPhaseMutationDisabled}
                                            onChange={(e) => setEditingPhaseDesc(e.target.value)}
                                            onBlur={() => {
                                              const trimmed = editingPhaseDesc.trim();
                                              setEditingPhaseDescId(null);
                                              if (trimmed !== (phase.description || '')) {
                                                void handleUpdatePhaseField(phase.id, 'description', trimmed || null);
                                              }
                                            }}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Escape') { setEditingPhaseDescId(null); }
                                            }}
                                            autoFocus
                                            placeholder="Add a description…"
                                            rows={1}
                                            className="w-full field-sizing-content resize-none rounded-md border border-[var(--border-strong)] bg-[var(--surface-1)] px-2 py-1 text-sm text-[var(--text-secondary)] outline-none"
                                          />
                                        ) : phase.description ? (
                                          <div
                                            className={cn('group/desc flex items-start gap-1.5', isPhaseMutationDisabled ? 'cursor-default' : 'cursor-pointer')}
                                            onClick={() => {
                                              if (isPhaseMutationDisabled) return;
                                              setEditingPhaseDescId(phase.id);
                                              setEditingPhaseDesc(phase.description || '');
                                            }}
                                            title="Click to edit description"
                                            aria-disabled={isPhaseMutationDisabled}
                                          >
                                            <p className="text-sm text-[var(--text-secondary)] text-pretty whitespace-pre-wrap group-hover/desc:text-[var(--text-primary)] transition-colors">
                                              {phase.description}
                                            </p>
                                            <PencilLine size={12} className="mt-0.5 shrink-0 text-[var(--text-tertiary)] opacity-0 group-hover/desc:opacity-100 transition-opacity" />
                                          </div>
                                        ) : null}
                                        <div className="flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)]">
                                          <label className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border-strong)] bg-[var(--surface-1)] px-2 py-1 cursor-pointer hover:bg-[var(--surface-2)] hover:border-[var(--accent-500)]/40" title="Click to edit estimated days">
                                            <Clock3 size={12} className="text-[var(--text-muted)]" />
                                            <input
                                              type="number"
                                              min={0}
                                              disabled={isPhaseMutationDisabled}
                                              className="w-12 bg-transparent text-xs text-center outline-none shadow-none border-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                              defaultValue={phase.estimatedDays ?? ''}
                                              placeholder="—"
                                              onBlur={(e) => {
                                                const val = e.target.value ? Number(e.target.value) : null;
                                                if (val !== phase.estimatedDays) void handleUpdatePhaseField(phase.id, 'estimatedDays', val);
                                              }}
                                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                            />
                                            <span className="text-xs">days</span>
                                          </label>
                                          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border-strong)] bg-[var(--surface-1)] px-2 py-1 hover:border-[var(--accent-500)]/40" title="Phase date range">
                                            <CalendarDays size={12} className="text-[var(--text-muted)]" />
                                            <input
                                              type="date"
                                              className="bg-transparent text-xs outline-none shadow-none border-none w-[6.5rem]"
                                              defaultValue={phase.targetStart ?? ''}
                                              disabled={isPhaseMutationDisabled}
                                              onChange={(e) => void handleUpdatePhaseField(phase.id, 'targetStart', e.target.value || null)}
                                            />
                                            <span className="text-xs">→</span>
                                            <input
                                              type="date"
                                              className="bg-transparent text-xs outline-none shadow-none border-none w-[6.5rem]"
                                              defaultValue={phase.targetEnd ?? ''}
                                              disabled={isPhaseMutationDisabled}
                                              onChange={(e) => void handleUpdatePhaseField(phase.id, 'targetEnd', e.target.value || null)}
                                            />
                                          </span>
                                        </div>
                                      </div>
                                    </div>

                                    {/* Right-side actions — use flex-shrink-0 and no-wrap to prevent wrapping issues */}
                                    <div className="flex shrink-0 items-center gap-1.5">
                                      <Tooltip content="Open progress report">
                                      <button
                                        type="button"
                                        onClick={() => setReportingPhaseId((current) => current === phase.id ? null : phase.id)}
                                        className={cn(
                                          'inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-xs font-medium active:scale-[0.96]',
                                          reportingPhaseId === phase.id
                                            ? 'border-[var(--accent-500)]/40 bg-[var(--accent-500)]/10 text-[var(--accent-400)]'
                                            : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                                          BUTTON_TRANSITION,
                                        )}
                                        aria-expanded={reportingPhaseId === phase.id}
                                      >
                                        <ChartNoAxesCombined size={14} />
                                        Report
                                      </button>
                                      </Tooltip>
                                      <Tooltip content="Set dependency">
                                      <div>
                                      <Select disabled={isPhaseMutationDisabled} value={phase.startAfterPhaseId || ''} onValueChange={(v) => {
                                          const value = v || null;
                                          void handleUpdatePhaseField(phase.id, 'startAfterPhaseId', value);
                                        }}>
                                        <SelectTrigger className={cn('inline-flex min-h-9 items-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)]', BUTTON_TRANSITION)} title="Set dependency">
                                          <Link2 size={14} className="mr-1.5 shrink-0 text-[var(--text-muted)]" />
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="">No dependency</SelectItem>
                                          {phases.filter(p => p.id !== phase.id).map(p => (
                                            <SelectItem key={p.id} value={p.id}>After: {p.name}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      </div>
                                      </Tooltip>
                                      <Tooltip content="Delete phase">
                                      <button
                                        type="button"
                                        onClick={() => void handleDeletePhase(phase)}
                                        disabled={isPhaseMutationDisabled}
                                        className={cn('inline-flex min-h-9 min-w-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] hover:border-[var(--danger)]/30 hover:bg-[var(--danger)]/10 hover:text-[var(--danger)] active:scale-[0.96]', BUTTON_TRANSITION)}
                                        aria-label={`Delete ${phase.name}`}
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                      </Tooltip>
                                    </div>
                                  </div>
                                </div>

                                {reportingPhaseId === phase.id ? (
                                  <BurnReportCard
                                    projectId={projectId}
                                    phaseId={phase.id}
                                    scopeName={phase.name}
                                    refreshKey={reportRefreshKey}
                                    embedded
                                    onTaskSelect={handleGraphTaskSelect}
                                  />
                                ) : null}

                                {!isCollapsed ? (
                                    <div className="border-t border-[var(--border)] bg-[var(--surface-1)]/50 p-4" data-phase-drop={phase.id}>
                                      {entries.length === 0 ? (
                                        <DroppablePhaseZone phaseId={phase.id}>
                                          <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-6 text-center">
                                            <p className="text-sm text-[var(--text-tertiary)]">No tasks in this phase yet.</p>
                                            <div className="relative mt-3 inline-flex" data-phase-add-menu>
                                              <button
                                                type="button"
                                                onClick={() => setAddTaskMenuPhaseId(addTaskMenuPhaseId === phase.id ? null : phase.id)}
                                                aria-expanded={addTaskMenuPhaseId === phase.id}
                                                aria-haspopup="menu"
                                                className={cn('inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-hover)] active:scale-[0.96]', BUTTON_TRANSITION)}
                                              >
                                                <Plus size={14} />
                                                Add task
                                              </button>
                                              <AnimatePresence>
                                                {addTaskMenuPhaseId === phase.id && (
                                                  <PhaseAddTaskMenu
                                                    onCreateNew={() => {
                                                      setAddTaskMenuPhaseId(null);
                                                      setShowCreateTaskForPhaseId(phase.id);
                                                    }}
                                                    onLinkExisting={() => {
                                                      setAddTaskMenuPhaseId(null);
                                                      setShowPickerForPhaseId(phase.id);
                                                    }}
                                                    onClose={() => setAddTaskMenuPhaseId(null)}
                                                  />
                                                )}
                                              </AnimatePresence>
                                            </div>
                                          </div>
                                        </DroppablePhaseZone>
                                      ) : (
                                        <DroppablePhaseZone phaseId={phase.id}>
                                          <SortableContext items={entries.map(({ task }) => `task:${task.id}`)} strategy={verticalListSortingStrategy}>
                                          <div className="space-y-2">
                                            {entries.map(({ item, task }) => {
                                              const ConnectorIcon = getConnectorIcon(task.connectorType);
                                              const isDone = task.status === 'done' || completingIds.has(task.id);
                                              const isInactive = isInactiveTaskStatus(task.status) || completingIds.has(task.id);
                                              const isBulkSelected = bulk.bulkSelected.has(task.id);
                                              return (
                                                <DraggableTaskItem key={item.id} taskId={task.id}>
                                                  {(taskDragHandleProps) => (
                                                    <TaskContextMenu
                                                     task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, connectorType: task.connectorType, sourceId: task.sourceId, dueDate: task.dueDate ?? null, localDisposition: task.localDisposition, taskSourceModel: task.taskSourceModel, editPolicy: task.editPolicy }}
                                                     isInMyDay={myDayTaskIds.has(task.id)}
                                                    projectPhases={phaseMenuItems}
                                                    projects={allProjects}
                                                    taskProjectIds={task.hubProjectIds}
                                                    taskProjectPhaseMemberships={task.projectPhaseMemberships}
                                                    actions={getTaskContextActions(task)}
                                                   >
                                                    <div
                                                      className={cn(
                                                        'flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                                                        selectedTaskId === task.id && !bulk.bulkMode && 'ring-1 ring-[var(--accent-400)] border-[var(--accent-400)]',
                                                        isBulkSelected && 'bg-blue-900/20 border-blue-500/30',
                                                        isInactive && 'opacity-50',
                                                      )}
                                                      onMouseDown={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); }}
                                                      onClick={(e) => {
                                                        if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                                          handleBulkModifierClick(task.id, e);
                                                        } else if (bulk.bulkMode) {
                                                          bulk.toggleItem(task.id);
                                                        } else {
                                                          taskSelection.toggleTask(task.id);
                                                        }
                                                      }}
                                                    >
                                                      <div className="flex min-w-0 items-center gap-2">
                                                        {bulk.bulkMode ? (
                                                          <label className="flex items-center justify-center flex-shrink-0 cursor-pointer min-w-8 min-h-8">
                                                            <input
                                                              type="checkbox"
                                                              checked={isBulkSelected}
                                                              onChange={() => bulk.toggleItem(task.id)}
                                                              onClick={(e) => e.stopPropagation()}
                                                              aria-label={`Select ${task.title}`}
                                                              className="w-4 h-4 rounded border-[var(--border-strong)] accent-[var(--accent-500)] cursor-pointer"
                                                            />
                                                          </label>
                                                        ) : (
                                                        <button
                                                          type="button"
                                                          {...taskDragHandleProps}
                                                          className="inline-flex min-h-8 min-w-8 cursor-grab items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] active:cursor-grabbing"
                                                          aria-label="Drag task to another phase"
                                                          onClick={(e) => e.stopPropagation()}
                                                        >
                                                          <GripVertical size={14} />
                                                        </button>
                                                        )}
                                                        <CompletionBurst celebrating={completingIds.has(task.id)}>
                                                          <button
                                                            type="button"
                                                            onClick={(e) => { e.stopPropagation(); void handleCompleteTask(task.id); }}
                                                            disabled={completingIds.has(task.id)}
                                                            className={cn(
                                                              'flex-shrink-0 h-[18px] w-[18px] rounded-full border-2 transition-[border-color,background-color,color,transform] duration-200',
                                                              isDone
                                                                ? 'bg-green-400 border-green-400 text-white'
                                                                : 'border-[var(--border-strong)] hover:border-green-500 hover:bg-green-900/30',
                                                            )}
                                                            aria-label={isDone ? 'Completed' : 'Mark complete'}
                                                          >
                                                            {isDone && <CheckCircle2 size={14} />}
                                                          </button>
                                                        </CompletionBurst>
                                                        <div className="min-w-0">
                                                          <div className="flex flex-wrap items-center gap-2">
                                                            <PriorityDot priority={task.priority} />
                                                            <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                                                            <p className={cn('truncate text-sm font-medium text-[var(--text-primary)]', isDone && 'line-through')}>{task.title}</p>
                                                            <TaskDisplayId task={task} />
                                                            <TaskInfoBadges task={task} />
                                                          </div>
                                                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)]">
                                                            <span>{PRIORITY_LABELS[task.priority]}</span>
                                                            <span>•</span>
                                                            <span>{task.sourceListName || task.connectorType}</span>
                                                            {task.dueDate ? (
                                                              <>
                                                                <span>•</span>
                                                                <span>Due {formatDateLabel(task.dueDate)}</span>
                                                              </>
                                                            ) : null}
                                                          </div>
                                                        </div>
                                                      </div>
                                                      <TaskStatusBadge status={task.status} statusReason={task.statusReason} />
                                                    </div>
                                                    </TaskContextMenu>
                                                  )}
                                                </DraggableTaskItem>
                                              );
                                            })}
                                            {/* Add task button at bottom of populated phase */}
                                            <div className="relative pt-1" data-phase-add-menu>
                                              <button
                                                type="button"
                                                onClick={() => setAddTaskMenuPhaseId(addTaskMenuPhaseId === phase.id ? null : phase.id)}
                                                aria-expanded={addTaskMenuPhaseId === phase.id}
                                                aria-haspopup="menu"
                                                className={cn('inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] bg-transparent px-3 py-2 text-xs text-[var(--text-tertiary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)] active:scale-[0.98]', BUTTON_TRANSITION)}
                                              >
                                                <Plus size={12} />
                                                Add task
                                              </button>
                                              <AnimatePresence>
                                                {addTaskMenuPhaseId === phase.id && (
                                                  <PhaseAddTaskMenu
                                                    onCreateNew={() => {
                                                      setAddTaskMenuPhaseId(null);
                                                      setShowCreateTaskForPhaseId(phase.id);
                                                    }}
                                                    onLinkExisting={() => {
                                                      setAddTaskMenuPhaseId(null);
                                                      setShowPickerForPhaseId(phase.id);
                                                    }}
                                                    onClose={() => setAddTaskMenuPhaseId(null)}
                                                  />
                                                )}
                                              </AnimatePresence>
                                            </div>
                                          </div>
                                          </SortableContext>
                                        </DroppablePhaseZone>
                                      )}
                                    </div>
                                ) : null}
                              </div>
                            )}
                          </SortablePhaseItem>
                        );
                      })}
                    </motion.div>
                  </SortableContext>

                  {/* ── Unassigned project tasks ────────────────────────── */}
                  {unassignedTasks.length > 0 && (
                    <div className="mt-6 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] shadow-[0_1px_0_rgba(255,255,255,0.04)]">
                      <button
                        type="button"
                        onClick={() => setUnassignedCollapsed((v) => !v)}
                        className={cn('flex w-full items-center gap-3 p-4 text-left hover:bg-[var(--surface-1)]/50 rounded-t-[var(--radius-lg)]', BUTTON_TRANSITION)}
                      >
                        {unassignedCollapsed ? <ChevronRight size={16} className="text-[var(--text-secondary)]" /> : <ChevronDown size={16} className="text-[var(--text-secondary)]" />}
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-[var(--text-secondary)]">Unassigned Tasks</h3>
                          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-0.5 text-xs text-[var(--text-tertiary)]">
                            {unassignedTasks.length}
                          </span>
                        </div>
                        <span className="ml-auto text-xs text-[var(--text-tertiary)]">Drag into a phase above</span>
                      </button>
                      {!unassignedCollapsed && (
                        <div className="border-t border-[var(--border)] p-4">
                          <SortableContext items={unassignedTasks.map((t) => `task:${t.id}`)} strategy={verticalListSortingStrategy}>
                            <div className="space-y-2">
                              {unassignedTasks.map((task) => {
                                const ConnectorIcon = getConnectorIcon(task.connectorType);
                                const isDone = task.status === 'done' || completingIds.has(task.id);
                                const isInactive = isInactiveTaskStatus(task.status) || completingIds.has(task.id);
                                const isBulkSelected = bulk.bulkSelected.has(task.id);
                                return (
                                  <DraggableTaskItem key={task.id} taskId={task.id}>
                                    {(taskDragHandleProps) => (
                                      <TaskContextMenu
                                       task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, connectorType: task.connectorType, sourceId: task.sourceId, dueDate: task.dueDate ?? null, localDisposition: task.localDisposition, taskSourceModel: task.taskSourceModel, editPolicy: task.editPolicy }}
                                        isInMyDay={myDayTaskIds.has(task.id)}
                                        projectPhases={phaseMenuItems}
                                        projects={allProjects}
                                        taskProjectIds={task.hubProjectIds}
                                        taskProjectPhaseMemberships={task.projectPhaseMemberships}
                                        actions={getTaskContextActions(task)}
                                      >
                                      <div
                                        className={cn(
                                          'flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                                          selectedTaskId === task.id && !bulk.bulkMode && 'ring-1 ring-[var(--accent-400)] border-[var(--accent-400)]',
                                          isBulkSelected && 'bg-blue-900/20 border-blue-500/30',
                                          isInactive && 'opacity-50',
                                        )}
                                        onMouseDown={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); }}
                                        onClick={(e) => {
                                          if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                            handleBulkModifierClick(task.id, e);
                                          } else if (bulk.bulkMode) {
                                            bulk.toggleItem(task.id);
                                          } else {
                                            taskSelection.toggleTask(task.id);
                                          }
                                        }}
                                      >
                                        <div className="flex min-w-0 items-center gap-2">
                                          {bulk.bulkMode ? (
                                            <label className="flex items-center justify-center flex-shrink-0 cursor-pointer min-w-8 min-h-8">
                                              <input
                                                type="checkbox"
                                                checked={isBulkSelected}
                                                onChange={() => bulk.toggleItem(task.id)}
                                                onClick={(e) => e.stopPropagation()}
                                                aria-label={`Select ${task.title}`}
                                                className="w-4 h-4 rounded border-[var(--border-strong)] accent-[var(--accent-500)] cursor-pointer"
                                              />
                                            </label>
                                          ) : (
                                          <button
                                            type="button"
                                            {...taskDragHandleProps}
                                            className="inline-flex min-h-8 min-w-8 cursor-grab items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] active:cursor-grabbing"
                                            aria-label="Drag task to a phase"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <GripVertical size={14} />
                                          </button>
                                          )}
                                          <CompletionBurst celebrating={completingIds.has(task.id)}>
                                            <button
                                              type="button"
                                              onClick={(e) => { e.stopPropagation(); void handleCompleteTask(task.id); }}
                                              disabled={completingIds.has(task.id)}
                                              className={cn(
                                                'flex-shrink-0 h-[18px] w-[18px] rounded-full border-2 transition-[border-color,background-color,color,transform] duration-200',
                                                isDone
                                                  ? 'bg-green-400 border-green-400 text-white'
                                                  : 'border-[var(--border-strong)] hover:border-green-500 hover:bg-green-900/30',
                                              )}
                                              aria-label={isDone ? 'Completed' : 'Mark complete'}
                                            >
                                              {isDone && <CheckCircle2 size={14} />}
                                            </button>
                                          </CompletionBurst>
                                          <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <PriorityDot priority={task.priority} />
                                              <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                                              <p className={cn('truncate text-sm font-medium text-[var(--text-primary)]', isDone && 'line-through')}>{task.title}</p>
                                              <TaskDisplayId task={task} />
                                              <TaskInfoBadges task={task} />
                                            </div>
                                            <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)]">
                                              <span>{PRIORITY_LABELS[task.priority]}</span>
                                              <span>•</span>
                                              <span>{task.sourceListName || task.connectorType}</span>
                                              {task.dueDate ? (
                                                <>
                                                  <span>•</span>
                                                  <span>Due {formatDateLabel(task.dueDate)}</span>
                                                </>
                                              ) : null}
                                            </div>
                                          </div>
                                        </div>
                                        <TaskStatusBadge status={task.status} statusReason={task.statusReason} />
                                      </div>
                                      </TaskContextMenu>
                                    )}
                                  </DraggableTaskItem>
                                );
                              })}
                            </div>
                          </SortableContext>
                        </div>
                      )}
                    </div>
                  )}

                  {portalContainer && createPortal(
                    <DragOverlay dropAnimation={null}>
                      {activeDragId?.startsWith('task:') ? (() => {
                        const dragTaskId = activeDragId.replace('task:', '');
                        const dragTask = tasks.find((t) => t.id === dragTaskId);
                        if (!dragTask) return null;
                        const ConnectorIcon = getConnectorIcon(dragTask.connectorType);
                        return (
                          <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--accent-500)] bg-[var(--surface-0)] px-4 py-3 opacity-90 shadow-lg sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 items-center gap-2">
                              <GripVertical size={14} className="text-[var(--text-tertiary)]" />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <PriorityDot priority={dragTask.priority} />
                                  <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                                  <p className="truncate text-sm font-medium text-[var(--text-primary)]">{dragTask.title}</p>
                                  <TaskDisplayId task={dragTask} />
                                </div>
                              </div>
                            </div>
                            <TaskStatusBadge status={dragTask.status} statusReason={dragTask.statusReason} />
                          </div>
                        );
                      })() : null}
                    </DragOverlay>,
                    portalContainer,
                  )}
                </DndContext>
              ) : phaseViewMode === 'assign' ? (
                <PhaseAssignView
                  phases={phases}
                  unassignedTasks={unassignedTasks}
                  phaseEntries={phaseEntries}
                  sensors={sensors}
                  collisionDetection={collisionDetection}
                  tasks={tasks}
                  myDayTaskIds={myDayTaskIds}
                  completingIds={completingIds}
                  selectedTaskId={selectedTaskId}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onSelectTask={(taskId) => taskId === null ? setSelectedTaskId(null) : taskSelection.toggleTask(taskId)}
                  onCompleteTask={handleCompleteTask}
                  onRenamePhase={renamePhase}
                  savingPhaseIds={savingPhaseIds}
                  phaseMutationPending={savingPhaseIds.size > 0}
                  createPhaseDisabled={creatingPhase || savingPhaseIds.size > 0}
                  onCreatePhase={handleAddPhase}
                  onCreateNewTask={() => setShowCreateTaskForPhaseId('__project__')}
                  onLinkExistingTask={() => setShowPickerForPhaseId('__project__')}
                  activeDragId={activeDragId}
                  getTaskContextActions={getTaskContextActions}
                  phaseMenuItems={phaseMenuItems}
                  projects={allProjects}
                />
              ) : (
                <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)]">
                  <div className="border-b border-[var(--border)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                    Zoom by {ganttZoom}. Bars use phase dates when available, otherwise fall back to estimates.
                  </div>
                  <div className="overflow-x-auto">
                    <div className="relative" style={{ minWidth: LEFT_GANTT_COLUMN_WIDTH + timelineWidth + 32 }}>
                      <div className="flex border-b border-[var(--border)] bg-[var(--surface-1)]">
                        <div className="sticky left-0 z-10 flex w-[220px] shrink-0 items-end border-r border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
                          <div>
                            <p className="text-sm font-medium text-[var(--text-primary)]">Phase timeline</p>
                            <p className="text-xs text-[var(--text-tertiary)]">Phases and nested task spans</p>
                          </div>
                        </div>
                        <div className="relative h-16" style={{ width: timelineWidth }}>
                          {timelineSegments.map((segment, index) => (
                            <div
                              key={`${segment.label}-${index}`}
                              className="absolute inset-y-0 border-l border-[var(--border-subtle)] px-2 py-2"
                              style={{ left: segment.offset, width: segment.width }}
                            >
                              <p className="text-xs font-medium text-[var(--text-primary)]">{segment.label}</p>
                              <p className="text-[12px] text-[var(--text-tertiary)]">{segment.sublabel}</p>
                            </div>
                          ))}
                          {todayMarkerOffset >= 0 && todayMarkerOffset <= timelineWidth ? (
                            <>
                              <div className="absolute inset-y-0 w-px bg-[var(--accent)]/60" style={{ left: todayMarkerOffset }} />
                              <div className="absolute top-1 -translate-x-1/2 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[12px] font-medium text-white" style={{ left: todayMarkerOffset }}>
                                Today
                              </div>
                            </>
                          ) : null}
                        </div>
                      </div>

                      {ganttRows.map((row) => {
                        const phaseStatusColor = getPhaseStatusColor(row.phase.status);
                        const phaseOffset = differenceInCalendarDays(row.start, timelineRange.start) * timelineCellWidth;
                        const phaseWidth = row.durationDays * timelineCellWidth;

                        return (
                          <div key={row.phase.id} className="flex border-b border-[var(--border-subtle)] last:border-b-0">
                            <div className="sticky left-0 z-10 w-[220px] shrink-0 border-r border-[var(--border)] bg-[var(--surface-0)] px-4 py-4">
                              <div className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: phaseStatusColor }} />
                                <p className="truncate text-sm font-medium text-[var(--text-primary)]">{row.phase.name}</p>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2 text-[12px] text-[var(--text-tertiary)]">
                                <span>{PHASE_STATUS_LABELS[row.phase.status]}</span>
                                <span>•</span>
                                <span className="tabular-nums">{row.durationDays}d</span>
                              </div>
                            </div>
                            <div
                              className="relative h-24 bg-[var(--surface-0)]"
                              style={{
                                width: timelineWidth,
                                backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${timelineCellWidth - 1}px, ${toRgba(project.color, 0.14)} ${timelineCellWidth - 1}px, ${toRgba(project.color, 0.14)} ${timelineCellWidth}px)`,
                              }}
                            >
                              <div
                                className="absolute top-4 flex h-8 cursor-pointer items-center rounded-full border px-3 text-xs font-medium text-[var(--text-primary)] shadow-[0_8px_18px_rgba(0,0,0,0.18)] transition-[filter] duration-150 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-[var(--accent-500)]"
                                style={{
                                  left: phaseOffset,
                                  width: Math.max(phaseWidth, 24),
                                  backgroundColor: toRgba(phaseStatusColor, 0.22),
                                  borderColor: toRgba(phaseStatusColor, 0.46),
                                }}
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                  setEditingPhaseId(row.phase.id);
                                  setEditingPhaseName(row.phase.name);
                                  setPhaseViewMode('list');
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setEditingPhaseId(row.phase.id);
                                    setEditingPhaseName(row.phase.name);
                                    setPhaseViewMode('list');
                                  }
                                }}
                                title={`${row.phase.name} — ${PHASE_STATUS_LABELS[row.phase.status]} (click to edit)`}
                                aria-label={`Phase: ${row.phase.name}, ${PHASE_STATUS_LABELS[row.phase.status]}`}
                              >
                                <span className="truncate">{row.phase.name}</span>
                              </div>
                              {row.tasks.map((taskBar, index) => {
                                const barOffset = differenceInCalendarDays(taskBar.start, timelineRange.start) * timelineCellWidth;
                                const barWidth = (differenceInCalendarDays(taskBar.end, taskBar.start) + 1) * timelineCellWidth;
                                const taskColor = getTaskStatusColor(taskBar.task.status);
                                return (
                                  <div
                                    key={taskBar.item.id}
                                    className="absolute flex h-3 cursor-pointer items-center rounded-full transition-[filter,transform] duration-150 hover:brightness-125 hover:scale-110 focus-visible:outline-2 focus-visible:outline-[var(--accent-500)]"
                                    style={{
                                      left: barOffset,
                                      top: 58 + (index % 2) * 10,
                                      width: Math.max(barWidth, 12),
                                      backgroundColor: toRgba(taskColor, 0.85),
                                      boxShadow: `0 0 0 1px ${toRgba(taskColor, 0.35)} inset`,
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    title={`${taskBar.task.title} — ${TASK_STATUS_LABELS[taskBar.task.status]}`}
                                    aria-label={`Task: ${taskBar.task.title}, ${TASK_STATUS_LABELS[taskBar.task.status]}`}
                                    onClick={() => taskSelection.toggleTask(taskBar.task.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        setSelectedTaskId(taskBar.task.id);
                                      }
                                    }}
                                  />
                                );
                              })}
                              {todayMarkerOffset >= 0 && todayMarkerOffset <= timelineWidth ? (
                                <div className="absolute inset-y-0 w-px bg-[var(--accent)]/40" style={{ left: todayMarkerOffset }} />
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      <DependencyArrows ganttRows={ganttRows} timelineRange={timelineRange} cellWidth={timelineCellWidth} />
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.section>
      ) : null}

      {activeTab === 'tasks' ? (
        <motion.section variants={fadeSlideUp} className="space-y-6">
          <Card>
            <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
              <div>
                <CardTitle>Project tasks</CardTitle>
                <CardDescription>
                  {!hasProjectTaskFilters
                    ? taskFilterContext.completion === 'all'
                      ? `${tasks.length} tasks assigned to this project, with their current phase mapping.`
                      : `${filteredTasks.length} open project tasks. Turn on Done to review inactive work.`
                    : `Showing ${filteredTasks.length} of ${tasks.length} project tasks.`}
                </CardDescription>
              </div>
              <div className="relative" data-phase-add-menu>
                <Button
                  onClick={() => setAddTaskMenuPhaseId((current) => (
                    current === '__project__' ? null : '__project__'
                  ))}
                  aria-expanded={addTaskMenuPhaseId === '__project__'}
                  aria-haspopup="menu"
                >
                  <Plus size={14} />
                  Add task
                  <ChevronDown size={14} />
                </Button>
                <AnimatePresence>
                  {addTaskMenuPhaseId === '__project__' && (
                    <PhaseAddTaskMenu
                      onCreateNew={() => {
                        setAddTaskMenuPhaseId(null);
                        setShowCreateTaskForPhaseId('__project__');
                      }}
                      onLinkExisting={() => {
                        setAddTaskMenuPhaseId(null);
                        setShowPickerForPhaseId('__project__');
                      }}
                      onClose={() => setAddTaskMenuPhaseId(null)}
                    />
                  )}
                </AnimatePresence>
              </div>
            </CardHeader>
            <CardContent>
              <TaskKeywordFilter
                filteredCount={filteredTasks.length}
                sources={projectTaskSources}
                sourceLists={projectTaskSourceLists}
                tags={projectTaskTags}
                assignees={projectTaskAssignees}
                projects={projectTaskFilterProjects}
                listGroups={[]}
                controller={{
                  context: taskFilterContext,
                  setContext: setTaskFilterContext,
                  clear: clearProjectTaskFilters,
                }}
                hiddenBuilderFilters={['project']}
                placeholder="Filter project tasks... (press / to focus, ? for help)"
                className="mb-4"
                secondaryContent={
                  <div className="flex items-center gap-1">
                    <ShowCompletedToggle
                      showCompleted={taskFilterContext.completion === 'all'}
                      onShowCompletedChange={(showCompleted) => {
                        setTaskFilterContext((current) => updateTaskFilterContext(current, {
                          completion: showCompleted ? 'all' : 'open',
                        }));
                      }}
                    />
                    <label className={cn(
                      'flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2 text-xs cursor-pointer',
                      BUTTON_TRANSITION,
                      taskEffortFilter !== 'all'
                        ? 'border-[var(--accent-500)]/40 bg-[var(--accent-900)]/30 text-[var(--accent-300)]'
                        : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)]',
                    )}>
                      <span className="hidden xl:inline">Effort</span>
                      <Select value={String(taskEffortFilter)} onValueChange={(value) => setTaskEffortFilter(value === 'all' ? 'all' : Number.parseInt(value, 10))}>
                        <SelectTrigger className="h-auto min-h-0 w-auto border-0 bg-transparent p-0 text-xs text-[var(--text-primary)] outline-none">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="1">XS</SelectItem>
                          <SelectItem value="2">S</SelectItem>
                          <SelectItem value="3">M</SelectItem>
                          <SelectItem value="4">L</SelectItem>
                          <SelectItem value="5">XL</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2 text-xs text-[var(--text-secondary)]">
                      <ArrowUpDown size={13} />
                      <Select value={taskSortBy} onValueChange={(value) => setTaskSortBy(value as typeof taskSortBy)}>
                        <SelectTrigger className="h-auto min-h-0 w-auto border-0 bg-transparent p-0 text-xs text-[var(--text-primary)] outline-none">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="priority">Priority</SelectItem>
                          <SelectItem value="dueDate">Due date</SelectItem>
                          <SelectItem value="updated">Recently updated</SelectItem>
                          <SelectItem value="title">Alphabetical</SelectItem>
                        </SelectContent>
                      </Select>
                      <button type="button" onClick={() => setTaskSortDir((direction) => direction === 'asc' ? 'desc' : 'asc')} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label={`Sort ${taskSortDir === 'asc' ? 'descending' : 'ascending'}`}>
                        {taskSortDir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                      </button>
                    </label>
                  </div>
                }
              />
              {filteredTasks.length === 0 ? (
                <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-8 text-center">
                  <Search size={24} className="mx-auto text-[var(--text-muted)] mb-3" />
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    {tasks.length > 0 && !hasProjectTaskFilters ? 'No open project tasks' : 'No tasks match the current filters'}
                  </p>
                  <p className="mt-1 text-sm text-[var(--text-tertiary)]">
                    {tasks.length > 0 && !hasProjectTaskFilters
                      ? 'Turn on Done to review completed and cancelled tasks.'
                      : 'Try adjusting your filter criteria or clear all filters.'}
                  </p>
                  {hasProjectTaskFilters && (
                    <button type="button" onClick={clearProjectTaskFilters} className="mt-3 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--accent-500)]/30 bg-[var(--accent-900)]/20 px-3 py-1.5 text-sm font-medium text-[var(--accent-400)] hover:bg-[var(--accent-900)]/40 transition-colors">
                      <X size={12} />
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredTasks.map((task) => {
                    const phase = taskToPhase.get(task.id);
                    const ConnectorIcon = getConnectorIcon(task.connectorType);
                    const isDone = task.status === 'done' || completingIds.has(task.id);
                    const isInactive = isInactiveTaskStatus(task.status) || completingIds.has(task.id);
                    return (
                      <TaskContextMenu
                        key={task.id}
                        task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, connectorType: task.connectorType, sourceId: task.sourceId, dueDate: task.dueDate ?? null, localDisposition: task.localDisposition, taskSourceModel: task.taskSourceModel, editPolicy: task.editPolicy }}
                        isInMyDay={myDayTaskIds.has(task.id)}
                        projectPhases={phaseMenuItems}
                        projects={allProjects}
                        taskProjectIds={task.hubProjectIds}
                        taskProjectPhaseMemberships={task.projectPhaseMemberships}
                        actions={getTaskContextActions(task)}
                      >
                      <div
                        className={cn(
                          'flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)] lg:flex-row lg:items-center lg:justify-between cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                          selectedTaskId === task.id && 'ring-1 ring-[var(--accent-400)] border-[var(--accent-400)]',
                          isInactive && 'opacity-50',
                        )}
                        onClick={() => taskSelection.toggleTask(task.id)}
                      >
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <CompletionBurst celebrating={completingIds.has(task.id)}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); void handleCompleteTask(task.id); }}
                                disabled={completingIds.has(task.id)}
                                className={cn(
                                  'flex-shrink-0 h-[18px] w-[18px] rounded-full border-2 transition-[border-color,background-color,color,transform] duration-200',
                                  isDone
                                    ? 'bg-green-400 border-green-400 text-white'
                                    : 'border-[var(--border-strong)] hover:border-green-500 hover:bg-green-900/30',
                                )}
                                aria-label={isDone ? 'Completed' : 'Mark complete'}
                              >
                                {isDone && <CheckCircle2 size={14} />}
                              </button>
                            </CompletionBurst>
                            <PriorityDot priority={task.priority} />
                            <ConnectorIcon size={14} className="text-[var(--text-tertiary)]" />
                            <p className={cn('truncate text-sm font-medium text-[var(--text-primary)]', isDone && 'line-through')}>{task.title}</p>
                            <TaskDisplayId task={task} />
                            <TaskInfoBadges task={task} />
                            {(task.tags ?? []).slice(0, 3).map((tag) => (
                              <Badge key={tag.id} variant="outline">{tag.name}</Badge>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)]">
                            <span>Phase: {phase?.name || 'Unassigned'}</span>
                            <span>•</span>
                            <span>{PRIORITY_LABELS[task.priority]}</span>
                            {task.sourceListName ? (
                              <>
                                <span>•</span>
                                <span>{task.sourceListName}</span>
                              </>
                            ) : null}
                            {task.dueDate ? (
                              <>
                                <span>•</span>
                                <span>Due {formatDateLabel(task.dueDate)}</span>
                              </>
                            ) : null}
                            <span>•</span>
                            <span>Updated {formatRelativeTime(task.updatedAt)}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {phase ? <Badge variant="outline">{phase.name}</Badge> : null}
                          <TaskStatusBadge status={task.status} statusReason={task.statusReason} />
                        </div>
                      </div>
                      </TaskContextMenu>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.section>
      ) : null}

      {activeTab === 'settings' ? (
        <motion.section variants={fadeSlideUp} className="space-y-6">
          {/* General */}
          <Card className="border-[var(--border-subtle)]">
            <CardHeader>
              <CardTitle className="text-base">General</CardTitle>
              <CardDescription>Project name, description, icon, and color.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Name</label>
                <div>
                  <input
                    key={`name-${project.name}`}
                    type="text"
                    className={cn(
                      "flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-full max-w-md",
                      project.metadata?.syncManaged ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--border-strong)]',
                    )}
                    defaultValue={project.name}
                    disabled={!!project.metadata?.syncManaged}
                    onBlur={async (e) => {
                      const val = e.target.value.trim();
                      if (!val || val === project.name) return;
                      try {
                        const res = await fetch(`/api/hub-projects/${projectId}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ name: val }),
                        });
                        if (!res.ok) throw new Error('Failed to update name');
                        setProject((prev) => prev ? { ...prev, name: val } : prev);
                        toast.success('Name updated');
                        window.dispatchEvent(new Event('projects-updated'));
                      } catch {
                        toast.error('Failed to update name');
                      }
                    }}
                  />
                  {!!project.metadata?.syncManaged && (
                    <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">Managed by GitHub sync</p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Description</label>
                <div>
                  <textarea
                    key={`desc-${project.description ?? ''}`}
                    className={cn(
                      "flex min-h-[80px] resize-y rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-full max-w-md",
                      project.metadata?.syncManaged ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--border-strong)]',
                    )}
                    placeholder="What is this project about?"
                    defaultValue={project.description || ''}
                    disabled={!!project.metadata?.syncManaged}
                    onBlur={async (e) => {
                      const val = e.target.value.trim() || null;
                      if (val === (project.description || null)) return;
                      try {
                        const res = await fetch(`/api/hub-projects/${projectId}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ description: val }),
                        });
                        if (!res.ok) throw new Error('Failed to update description');
                        setProject((prev) => prev ? { ...prev, description: val } : prev);
                        toast.success('Description updated');
                      } catch {
                        toast.error('Failed to update description');
                      }
                    }}
                  />
                  {!!project.metadata?.syncManaged && (
                    <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">Managed by GitHub sync</p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Icon</label>
                <IconPickerButton
                  value={project.icon || null}
                  onChange={async (val) => {
                    const icon = val.trim() || null;
                    if (icon === (project.icon || null)) return;
                    try {
                      const res = await fetch(`/api/hub-projects/${projectId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          icon,
                          iconColor: resolveProjectIconColor(project.iconColor, project.color),
                        }),
                      });
                      if (!res.ok) throw new Error('Failed to update icon');
                      setProject((prev) => prev ? { ...prev, icon } : prev);
                      toast.success('Icon updated');
                      window.dispatchEvent(new Event('projects-updated'));
                    } catch {
                      toast.error('Failed to update icon');
                    }
                  }}
                  size="md"
                  color={resolveProjectIconColor(project.iconColor, project.color)}
                  onColorChange={async (iconColor) => {
                    try {
                      // Sync icon color → project color when the chosen color exists in presets
                      const matchingPreset = COLOR_PRESETS.find((p) => p === iconColor);
                      const patchBody: Record<string, string> = { iconColor };
                      if (matchingPreset) patchBody.color = matchingPreset;
                      const res = await fetch(`/api/hub-projects/${projectId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(patchBody),
                      });
                      if (!res.ok) throw new Error('Failed to update icon color');
                      setProject((prev) => prev ? { ...prev, iconColor, ...(matchingPreset ? { color: matchingPreset } : {}) } : prev);
                      if (matchingPreset) window.dispatchEvent(new Event('projects-updated'));
                    } catch {
                      toast.error('Failed to update icon color');
                    }
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">
                  <span className="inline-flex items-center gap-1"><Palette size={13} /> Color</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={async () => {
                        if (preset === project.color) return;
                        try {
                          // Sync project color → icon color
                          const patchBody: Record<string, string> = { color: preset, iconColor: preset };
                          const res = await fetch(`/api/hub-projects/${projectId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(patchBody),
                          });
                          if (!res.ok) throw new Error('Failed to update color');
                          setProject((prev) => prev ? { ...prev, color: preset, iconColor: preset } : prev);
                          toast.success('Color updated');
                          window.dispatchEvent(new Event('projects-updated'));
                        } catch {
                          toast.error('Failed to update color');
                        }
                      }}
                      className={`flex h-8 w-8 items-center justify-center rounded-full border transition-transform hover:scale-110 ${
                        project.color === preset ? 'border-white/90' : 'border-white/20'
                      }`}
                      style={{
                        backgroundColor: preset,
                        boxShadow: project.color === preset ? `0 0 0 2px ${preset}55` : undefined,
                      }}
                      aria-label={`Select ${preset} color`}
                    >
                      {project.color === preset && <span className="h-2 w-2 rounded-full bg-white/90" />}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Auto-Include Rules */}
          <Card className="border-[var(--border-subtle)]">
            <CardHeader>
              <CardTitle className="text-base">Auto-Include Rules</CardTitle>
              <CardDescription>Automatically add tasks matching these rules to this project.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(project.autoIncludeRules as AutoIncludeRule[]).map((rule, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-0)] text-[var(--text-muted)]">
                    {rule.type === 'tag' && <Tag size={14} />}
                    {rule.type === 'title_contains' && <Type size={14} />}
                    {rule.type === 'source_list' && <List size={14} />}
                    {rule.type === 'connector' && <Plug size={14} />}
                  </div>
                  <Select
                    value={rule.type}
                    disabled={savingRules}
                    onValueChange={async (value) => {
                      const updated = [...(project.autoIncludeRules as AutoIncludeRule[])];
                      updated[index] = { ...rule, type: value as AutoIncludeRule['type'] };
                      try {
                        await updateAutoIncludeRules(updated, 'Rule updated');
                      } catch { /* handled by updateAutoIncludeRules */ }
                    }}
                  >
                    <SelectTrigger
                      className="h-9 min-h-0 w-[160px] shrink-0"
                      aria-label={`Rule ${index + 1} type`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tag">Label / Tag</SelectItem>
                      <SelectItem value="title_contains">Title contains</SelectItem>
                      <SelectItem value="source_list">Source list</SelectItem>
                      <SelectItem value="connector">Connector</SelectItem>
                    </SelectContent>
                  </Select>
                  <input
                    type="text"
                    defaultValue={rule.value}
                    key={`rule-${index}-${rule.type}`}
                    placeholder={
                      rule.type === 'tag' ? 'e.g. di-mc-integration' :
                      rule.type === 'title_contains' ? 'e.g. [Phase 0]' :
                      rule.type === 'source_list' ? 'e.g. octo-org/ideation' :
                      'Connector instance ID'
                    }
                    className="flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] flex-1"
                    disabled={savingRules}
                    onBlur={async (e) => {
                      const val = e.target.value;
                      if (val === rule.value) return;
                      const updated = [...(project.autoIncludeRules as AutoIncludeRule[])];
                      updated[index] = { ...rule, value: val };
                      try {
                        await updateAutoIncludeRules(updated, 'Rule updated');
                      } catch { /* handled by updateAutoIncludeRules */ }
                    }}
                  />
                  <button
                    type="button"
                    disabled={savingRules}
                    onClick={async () => {
                      const updated = (project.autoIncludeRules as AutoIncludeRule[]).filter((_, i) => i !== index);
                      try {
                        await updateAutoIncludeRules(updated, 'Rule removed');
                      } catch { /* handled by updateAutoIncludeRules */ }
                    }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                    aria-label="Remove rule"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const updated = [...(project.autoIncludeRules as AutoIncludeRule[]), { type: 'tag' as const, value: '' }];
                  setProject((prev) => prev ? { ...prev, autoIncludeRules: updated } : prev);
                }}
                disabled={savingRules}
                className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                <Plus size={12} />
                Add Rule
              </button>
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      Qualifying tasks{ruleMatches.length > 0 ? ` (${ruleMatches.length})` : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                      A task qualifies when it matches any rule. Tag names ignore a leading # and letter case.
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                      Rules add matching tasks; removing a rule does not unlink tasks already in the project.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {ruleMatches.some((match) => !match.alreadyAssigned && !match.excluded) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={savingRules}
                        onClick={() => void updateAutoIncludeRules(
                          project.autoIncludeRules as AutoIncludeRule[],
                          'Matching tasks added',
                        )}
                      >
                        Retry include
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void loadRuleMatches()}
                      disabled={ruleMatchesLoading}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)] disabled:opacity-50"
                      aria-label="Refresh qualifying tasks"
                    >
                      <RefreshCw size={14} className={ruleMatchesLoading ? 'animate-spin' : ''} />
                    </button>
                  </div>
                </div>
                {ruleMatchesLoading ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                    <LoaderCircle size={13} className="animate-spin" />
                    Checking tasks…
                  </div>
                ) : ruleMatches.length === 0 ? (
                  <p className="mt-3 text-xs text-[var(--text-tertiary)]">
                    No tasks currently match these rules.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {excludedRuleMatches.length > 0 ? (
                      <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                        <div className="mb-2">
                          <p className="text-sm font-medium text-[var(--text-primary)]">
                            Excluded from auto-include ({excludedRuleMatches.length})
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                            These tasks still match, but manual removal prevents rules and syncs from adding them back.
                          </p>
                        </div>
                        <div className="space-y-2">
                          {excludedRuleMatches.map((match) => (
                            <div key={match.taskId} className="flex items-start justify-between gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm text-[var(--text-primary)]">{match.title}</p>
                                <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                                  {match.reasons.join(' · ')}
                                  {match.excludedAt ? ` · Excluded ${formatRelativeTime(match.excludedAt)}` : ''}
                                </p>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={savingRules}
                                onClick={() => void restoreAutoIncludedTask(match.taskId)}
                              >
                                Restore
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {activeRuleMatches.slice(0, 10).map((match) => (
                      <div key={match.taskId} className="flex items-start justify-between gap-3 rounded-md border border-[var(--border-subtle)] px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-[var(--text-primary)]">{match.title}</p>
                          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{match.reasons.join(' · ')}</p>
                        </div>
                        <Badge variant="outline" className="shrink-0">
                          {match.alreadyAssigned ? 'Included' : 'Not added'}
                        </Badge>
                      </div>
                    ))}
                    {activeRuleMatches.length > 10 ? (
                      <p className="text-xs text-[var(--text-tertiary)]">
                        And {activeRuleMatches.length - 10} more in the All Tasks tab.
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Status */}
          <Card className="border-[var(--border-subtle)]">
            <CardHeader>
              <CardTitle className="text-base">Project Status</CardTitle>
              <CardDescription>Control the lifecycle status of this project.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Status</label>
                <Select
                  value={getProjectStatus(project)}
                  onValueChange={async (value: string) => {
                    try {
                      const res = await fetch(`/api/hub-projects/${projectId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ statusOverride: value }),
                      });
                      if (!res.ok) throw new Error('Failed to update status');
                      setProject((prev) => prev ? { ...prev, statusOverride: value as ProjectStatus } : prev);
                      toast.success(`Status updated to ${STATUS_LABELS[value as ProjectStatus]}`);
                    } catch {
                      toast.error('Failed to update project status');
                    }
                  }}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Category</label>
                <div className="relative">
                  <input
                    key={`category-${project.category ?? ''}`}
                    type="text"
                    list="project-category-options"
                    className="flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-48"
                    placeholder="e.g. Personal, Work"
                    defaultValue={project.category || ''}
                    onBlur={async (e) => {
                      const val = e.target.value.trim() || null;
                      if (val === (project.category || null)) return;
                      try {
                        const res = await fetch(`/api/hub-projects/${projectId}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ category: val }),
                        });
                        if (!res.ok) throw new Error('Failed to update category');
                        setProject((prev) => prev ? { ...prev, category: val } : prev);
                        setCategorySaved(true);
                        setTimeout(() => setCategorySaved(false), 2000);
                        window.dispatchEvent(new Event('projects-updated'));
                      } catch {
                        toast.error('Failed to update category');
                      }
                    }}
                  />
                  {categorySaved && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-green-400">
                      <CheckCircle2 size={14} />
                    </span>
                  )}
                  <datalist id="project-category-options">
                    {existingCategories.map((cat) => (
                      <option key={cat} value={cat} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Target date</label>
                <input
                  key={`target-date-${project.targetDate ?? ''}`}
                  type="date"
                  className="flex h-9 rounded-[var(--radius-md)] px-3 py-2 text-sm bg-[var(--surface-0)] text-[var(--text-primary)] border border-[var(--border)] transition-[border-color,box-shadow] duration-75 hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-0)] w-48"
                  defaultValue={project.targetDate ? project.targetDate.split('T')[0] : ''}
                  onBlur={async (e) => {
                    const val = e.target.value || null;
                    if (val === (project.targetDate ? project.targetDate.split('T')[0] : null)) return;
                    try {
                      const res = await fetch(`/api/hub-projects/${projectId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ targetDate: val }),
                      });
                      if (!res.ok) throw new Error('Failed to update target date');
                      setProject((prev) => prev ? { ...prev, targetDate: val } : prev);
                      toast.success('Target date updated');
                    } catch {
                      toast.error('Failed to update target date');
                    }
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Source Bindings */}
          <Card className="border-[var(--border-subtle)]">
            <CardHeader>
              <CardTitle className="text-base">Source bindings</CardTitle>
              <CardDescription>Connected inputs that feed the project automatically.</CardDescription>
            </CardHeader>
            <CardContent>
              {Array.isArray(project.sourceBindings) && project.sourceBindings.length ? (
                <div className="space-y-3">
                  {project.sourceBindings.map((binding, index) => {
                    const listMode = connectorListModes[binding.connectorInstanceId];
                    const needsListWarning = !binding.sourceListId && listMode === 'required';
                    return (
                    <div key={`${binding.connectorInstanceId}-${binding.sourceListId ?? index}`} className={`rounded-[var(--radius-lg)] border bg-[var(--surface-0)] p-4 ${needsListWarning ? 'border-amber-400/60' : 'border-[var(--border)]'}`}>
                      <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                        <Link2 size={14} className="text-[var(--text-tertiary)]" />
                        {binding.connectorInstanceId}
                      </div>
                      {needsListWarning && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                          <TriangleAlert size={13} className="mt-0.5 flex-shrink-0" />
                          <span>No default list set — new tasks will go to the first configured list. Consider picking a specific target list.</span>
                        </div>
                      )}
                      <div className="mt-2 grid gap-1 text-xs text-[var(--text-secondary)]">
                        <p>Source list: {binding.sourceListId || 'All lists'}</p>
                        {binding.defaultSourceListId && (
                          <p>Default write target: {binding.defaultSourceListId}</p>
                        )}
                        <p>Filter: {binding.filter || 'No additional filter'}</p>
                      </div>
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-4 text-sm text-[var(--text-tertiary)]">
                  No source bindings configured for this project.
                </div>
              )}
            </CardContent>
          </Card>

          <ProjectActionsCard
            syncManaged={Boolean(project.metadata?.syncManaged)}
            onHide={() => {
              setConfirmDialog({
                open: true,
                title: 'Hide project?',
                message: `Hide "${project.name}"? It will be removed from project navigation and portfolio views. You can unhide it from All Projects.`,
                confirmLabel: 'Hide project',
                variant: 'warning',
                onConfirm: async () => {
                  try {
                    const res = await fetch(`/api/hub-projects/${projectId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ hidden: true }),
                    });
                    if (!res.ok) throw new Error('Failed to hide project');
                    toast.success('Project hidden');
                    window.dispatchEvent(new Event('projects-updated'));
                    router.push('/projects');
                  } catch {
                    toast.error('Failed to hide project');
                  } finally {
                    setConfirmDialog((d) => ({ ...d, open: false }));
                  }
                },
              });
            }}
            onDelete={() => {
              setConfirmDialog({
                open: true,
                title: 'Delete project',
                message: `Are you sure you want to delete "${project.name}"? This cannot be undone. Tasks assigned to this project will not be deleted.`,
                confirmLabel: 'Delete project',
                variant: 'danger',
                onConfirm: async () => {
                  try {
                    const res = await fetch(`/api/hub-projects/${projectId}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error('Failed to delete project');
                    toast.success('Project deleted');
                    window.dispatchEvent(new Event('projects-updated'));
                    router.push('/projects');
                  } catch {
                    toast.error('Failed to delete project');
                  } finally {
                    setConfirmDialog((d) => ({ ...d, open: false }));
                  }
                },
              });
            }}
          />
        </motion.section>
      ) : null}

      {proposal ? (
        <PhaseProposalReview
          proposal={proposal}
          projectId={projectId}
          taskMap={proposalTaskMap}
          isOpen={isProposalOpen}
          onAccept={() => {
            setIsProposalOpen(false);
            setProposal(null);
            void loadProjectDetail({ background: true });
          }}
          onReject={() => {
            setIsProposalOpen(false);
            setProposal(null);
            toast('Phase proposal dismissed');
          }}
        />
      ) : null}

      {/* ── Create task modal (scoped to a phase) ─────────────────────────── */}
      <AnimatePresence>
        {showCreateTaskForPhaseId !== null && (
          <AddTaskModal
            initialInput=""
            initialParsed={null}
            initialDestination={addTaskDestinations[0]}
            destinations={addTaskDestinations}
            initialProjectId={projectId}
            onTaskCreated={(taskId) => {
              const phaseId = showCreateTaskForPhaseId === '__project__' ? null : showCreateTaskForPhaseId;
              void handleNewTaskCreated(taskId, phaseId);
            }}
            onClose={() => setShowCreateTaskForPhaseId(null)}
            onSubmit={() => setShowCreateTaskForPhaseId(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Task picker dialog (link existing tasks to a phase) ────────── */}
      <AnimatePresence>
        {showPickerForPhaseId !== null && (
          <TaskPickerDialog
            excludeTaskIds={tasks.map((t) => t.id)}
            title={showPickerForPhaseId === '__project__'
              ? `Add tasks to ${project?.name || 'project'}`
              : `Add tasks to ${phases.find((p) => p.id === showPickerForPhaseId)?.name || 'phase'}`}
            onClose={() => setShowPickerForPhaseId(null)}
            onConfirm={(taskIds) => {
              const phaseId = showPickerForPhaseId === '__project__' ? null : showPickerForPhaseId;
              void handleAddExistingTasksToPhase(taskIds, phaseId);
              setShowPickerForPhaseId(null);
            }}
          />
        )}
      </AnimatePresence>
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
    </motion.div>

    {/* Task detail panel */}
    <AnimatePresence initial={false}>
      {selectedTaskId ? (
        <motion.div
          className="absolute inset-y-0 right-0 z-30 flex sm:relative sm:inset-auto sm:z-auto sm:h-full sm:min-w-0 sm:shrink"
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0.35, x: '100%' }}
          animate={{ opacity: 1, x: 0 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0.35, x: '100%' }}
          transition={{ duration: prefersReducedMotion ? 0.14 : 0.26, ease: [0.22, 1, 0.36, 1] }}
        >
          <TaskDetailPanel
            taskId={selectedTaskId}
            onClose={() => setSelectedTaskId(null)}
            onUpdate={(fields) => {
              if (fields && selectedTaskId) {
                setTasks((current) =>
                  current.map((t) =>
                    t.id === selectedTaskId ? { ...t, ...fields } as ProjectTask : t
                  )
                );
              }
              void loadProjectDetail({ background: true });
            }}
            onSubtaskCountChange={(done, total) => {
              setTasks((current) =>
                current.map((task) =>
                  task.id === selectedTaskId ? { ...task, subtaskDone: done, subtaskTotal: total } : task
                )
              );
            }}
            isInMyDay={myDayTaskIds.has(selectedTaskId)}
            onToggleMyDay={() => myDayTaskIds.has(selectedTaskId)
              ? void handleRemoveFromMyDay(selectedTaskId)
              : void handleAddToMyDay(selectedTaskId)}
            animatePanel={false}
            portalDialog
            focusPanelOnMount
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
    </div>
  );
}