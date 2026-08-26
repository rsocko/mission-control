'use client';

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { differenceInCalendarDays, startOfDay } from 'date-fns';
import {
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock3,
  GripVertical,
  Layers3,
  Lightbulb,
  Link2,
  LoaderCircle,
  Network,
  NotepadText,
  PencilLine,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  BulkActionBar,
  BulkDispositionButtons,
  BulkDueDateDropdown,
  BulkMoveToPhaseDropdown,
  BulkPriorityDropdown,
  BulkStatusDropdown,
  executeBulkOperation,
  resolveSelectionAnchorIndex,
  useBulkSelection,
} from '@/components/bulk-actions';
import { BurnReportCard } from '@/components/projects/BurnReportCard';
import { TaskContextMenu } from '@/components/task-list/TaskContextMenu';
import { ShowCompletedToggle } from '@/components/toolbar/ShowCompletedToggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TaskStatusIndicator } from '@/components/task-list/TaskStatusIndicator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip } from '@/components/ui/Tooltip';
import { fadeSlideUp, staggerContainer } from '@/lib/motion';
import { ProjectHierarchyClientError } from '@/lib/projects/hierarchy-client';
import {
  filterCompletedTasks,
  getPhaseTaskStatusSummary,
  shouldCompactCompletedPhase,
} from '@/lib/projects/phase-task-status';
import {
  canEditTaskField,
  selectedTaskFieldBlockedReason,
  selectedTaskRemovalBlockedReason,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import { cn } from '@/lib/utils';
import type { TaskPriority, TaskStatus } from '@/types';
import {
  DependencyArrows,
  DraggableTaskItem,
  DroppablePhaseZone,
  PhaseAddTaskMenu,
  PhaseStatusBadge,
  PriorityDot,
  SortablePhaseItem,
  TaskDisplayId,
  TaskStatusBadge,
} from '../components';
import {
  BUTTON_TRANSITION,
  LEFT_GANTT_COLUMN_WIDTH,
  PHASE_STATUS_LABELS,
  PHASE_STATUS_ORDER,
  PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  ZOOM_CELL_WIDTH,
} from '../constants';
import {
  useProjectPageData,
  useProjectPageMutations,
  useProjectPageTaskInteractions,
} from '../context';
import { PhaseAssignView } from '../PhaseAssignView';
import type {
  GanttZoom,
  PhaseViewMode,
  ProjectPhaseItemViewModel as PhaseItem,
  ProjectPhaseViewModel as ProjectPhase,
} from '../types';
import {
  buildGanttRows,
  buildTimelineSegments,
  formatDateLabel,
  getConnectorIcon,
  getPhaseColor,
  getPhaseStatusColor,
  getTaskStatusColor,
  getTimelineRange,
  toRgba,
} from '../utils';
import type {
  ProjectProposalActions,
  ProjectTaskOverlayActions,
  RequestConfirmation,
} from './contracts';
import { AIPlanControl } from './AIPlanControl';
import { PlanTaskRow } from '../PlanTaskRow';

const ProjectStructureGraph = dynamic(
  () => import('@/components/graph/ProjectStructureGraph'),
  {
    ssr: false,
    loading: () => <div className="h-full min-h-0 animate-pulse rounded-xl bg-[var(--surface-0)]" />,
  },
);

const ALLOWED_PHASE_FIELDS = new Set(['name', 'description', 'status', 'color', 'estimatedDays', 'targetStart', 'targetEnd', 'startAfterPhaseId', 'sortOrder']);

interface ProjectPhasesTabProps {
  /** True while this tab is the visible Activity boundary. */
  active: boolean;
  /** Measured height of the shell's sticky project header. */
  stickyHeaderHeight: number;
  /** Phase the Overview tab asked the Plan to reveal, if any. */
  revealPhaseId: string | null;
  /** Clears the shell's pending reveal request once it has been consumed. */
  onRevealComplete: () => void;
  /** Reports whether the Plan is showing the full-height graph layout. */
  onGraphLayoutChange: (isGraphView: boolean) => void;
  /** Shared create/link overlays owned by the shell. */
  taskOverlayActions: ProjectTaskOverlayActions;
  /** Opens the shared confirmation dialog owned by the shell. */
  requestConfirmation: RequestConfirmation;
  /** Route-level AI proposal controller owned by the shell. */
  proposalActions: ProjectProposalActions;
}

export function ProjectPhasesTab({
  active,
  onGraphLayoutChange,
  onRevealComplete,
  proposalActions,
  requestConfirmation,
  revealPhaseId,
  stickyHeaderHeight,
  taskOverlayActions,
}: ProjectPhasesTabProps) {
  const {
    phaseEntries,
    phaseItemsByPhase,
    phaseMenuItems,
    phases,
    project,
    projectId,
    reportRefreshKey,
    tasks,
    taskToPhase,
  } = useProjectPageData();
  const {
    hierarchyAnnouncement,
    refreshProjectHierarchy,
    runHierarchyCommand,
    setPhaseItemsByPhase,
    setPhases,
    setTasks,
  } = useProjectPageMutations();
  const {
    allProjects,
    completingIds,
    getTaskContextActions,
    handleCompleteTask,
    handleGraphTaskSelect,
    handleTaskDoubleClick,
    myDayTaskIds,
    selectedTaskId,
    setSelectedTaskId,
    toggleTask,
  } = useProjectPageTaskInteractions();
  const prefersReducedMotion = useReducedMotion() ?? false;

  const [phaseViewMode, setPhaseViewMode] = useState<PhaseViewMode>('list');
  const [reportingPhaseId, setReportingPhaseId] = useState<string | null>(null);
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>('week');
  const [collapsedPhaseIds, setCollapsedPhaseIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem(`project-phases-collapsed:${projectId}`);
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [phaseToRevealId, setPhaseToRevealId] = useState<string | null>(null);
  const phaseCardRefs = useRef(new Map<string, HTMLDivElement>());
  const planToolbarRef = useRef<HTMLDivElement>(null);
  const [editingPhaseId, setEditingPhaseId] = useState<string | null>(null);
  const [editingPhaseName, setEditingPhaseName] = useState('');
  const [editingPhaseDescId, setEditingPhaseDescId] = useState<string | null>(null);
  const [editingPhaseDesc, setEditingPhaseDesc] = useState('');
  const [creatingPhase, setCreatingPhase] = useState(false);
  const savingPhaseCountsRef = useRef(new Map<string, number>());
  const [savingPhaseIds, setSavingPhaseIds] = useState<Set<string>>(new Set());
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [addTaskMenuPhaseId, setAddTaskMenuPhaseId] = useState<string | null>(null);
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false);
  const [phaseTaskSearch, setPhaseTaskSearch] = useState('');
  const [showCompletedTasks, setShowCompletedTasks] = useState(true);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const bulk = useBulkSelection();
  const visiblePhaseViewMode = revealPhaseId ? 'list' : phaseViewMode;
  const normalizedPhaseTaskSearch = phaseTaskSearch.trim().toLowerCase();

  useEffect(() => { setPortalContainer(document.body); }, []);

  // Keep the shell's scroll container in step with the full-height graph view.
  useLayoutEffect(() => {
    onGraphLayoutChange(visiblePhaseViewMode === 'graph');
  }, [onGraphLayoutChange, visiblePhaseViewMode]);

  const persistCollapsedPhaseIds = useCallback((next: string[]) => {
    try { localStorage.setItem(`project-phases-collapsed:${projectId}`, JSON.stringify(next)); } catch { /* ignore */ }
  }, [projectId]);

  // Consume the Overview → Plan reveal request: expand the phase, return to the
  // list view, and hand the scroll/focus work to the effect below.
  useEffect(() => {
    if (!revealPhaseId) return;
    setPhaseViewMode('list');
    setShowCompletedTasks(true);
    setCollapsedPhaseIds((current) => {
      const next = current.filter((entry) => entry !== revealPhaseId);
      persistCollapsedPhaseIds(next);
      return next;
    });
    setPhaseToRevealId(revealPhaseId);
    onRevealComplete();
  }, [onRevealComplete, persistCollapsedPhaseIds, revealPhaseId]);

  useEffect(() => {
    if (
      !phaseToRevealId
      || visiblePhaseViewMode !== 'list'
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
  }, [collapsedPhaseIds, phaseToRevealId, prefersReducedMotion, stickyHeaderHeight, visiblePhaseViewMode]);

  const selectedBulkTasks = tasks.filter((task) => bulk.bulkSelected.has(task.id));
  const selectedBulkPolicies = selectedBulkTasks.map((task) => task.editPolicy);
  const bulkStatusBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'status');
  const bulkPriorityBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'priority');
  const bulkDueDateBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'dueDate');
  const bulkRemovalBlockedReason = selectedTaskRemovalBlockedReason(selectedBulkPolicies);

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

  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task] as const)), [tasks]);

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

  // Tasks in the project that are not assigned to any phase
  const unassignedTasks = useMemo(() => {
    if (phases.length === 0) return [];
    return tasks.filter((t) => !taskToPhase.has(t.id));
  }, [tasks, taskToPhase, phases]);

  const visibleUnassignedTasks = useMemo(() => {
    const completionFiltered = filterCompletedTasks(
      unassignedTasks,
      showCompletedTasks,
      (task) => task.status,
    );
    return normalizedPhaseTaskSearch
      ? completionFiltered.filter((task) => task.title.toLowerCase().includes(normalizedPhaseTaskSearch))
      : completionFiltered;
  }, [normalizedPhaseTaskSearch, showCompletedTasks, unassignedTasks]);

  // Flat ordered list of all task IDs shown in the Plan list view (for shift-click range selection)
  const planListTaskIds = useMemo(() => {
    const ids: string[] = [];
    for (const phase of phases) {
      const entries = filterCompletedTasks(
        phaseEntries[phase.id] ?? [],
        showCompletedTasks,
        ({ task }) => task.status,
      ).filter(({ task }) => (
        !normalizedPhaseTaskSearch || task.title.toLowerCase().includes(normalizedPhaseTaskSearch)
      ));
      for (const { task } of entries) ids.push(task.id);
    }
    for (const task of visibleUnassignedTasks) ids.push(task.id);
    return ids;
  }, [normalizedPhaseTaskSearch, phaseEntries, phases, showCompletedTasks, visibleUnassignedTasks]);

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

  const handlePhaseDependencyRemoved = useCallback((phaseId: string) => {
    setPhases((current) => current.map((phase) => (
      phase.id === phaseId ? { ...phase, startAfterPhaseId: null } : phase
    )));
  }, [setPhases]);

  const ganttRows = useMemo(() => buildGanttRows(phases, phaseEntries, project), [phaseEntries, phases, project]);
  const timelineRange = useMemo(() => getTimelineRange(ganttRows), [ganttRows]);
  const timelineCellWidth = ZOOM_CELL_WIDTH[ganttZoom];
  const timelineWidth = (differenceInCalendarDays(timelineRange.end, timelineRange.start) + 1) * timelineCellWidth;
  const timelineSegments = useMemo(
    () => buildTimelineSegments(timelineRange.start, timelineRange.end, ganttZoom, timelineCellWidth),
    [ganttZoom, timelineCellWidth, timelineRange.end, timelineRange.start],
  );
  const todayMarkerOffset = differenceInCalendarDays(startOfDay(new Date()), timelineRange.start) * timelineCellWidth;

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

  async function handleDragEnd(event: DragEndEvent) {
    const { active: dragged, over } = event;
    setActiveDragId(null);

    if (!over || dragged.id === over.id) return;

    const activeType = dragged.data.current?.type;
    if (activeType === 'phase') {
      await handlePhaseDragEnd(event);
    } else if (activeType === 'task') {
      await handleTaskDragEnd(event);
    }
  }

  async function handlePhaseDragEnd(event: DragEndEvent) {
    const { active: dragged, over } = event;

    if (!over || dragged.id === over.id) return;

    const activeId = String(dragged.id).replace('phase:', '');
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
    const { active: dragged, over } = event;

    if (!over) return;

    const taskId = String(dragged.id).replace('task:', '');
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

  function handleDeletePhase(phase: ProjectPhase) {
    requestConfirmation({
      title: 'Delete phase?',
      message: `Delete "${phase.name}"? Tasks in this phase will be unassigned. This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async (close) => {
        close();
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
      persistCollapsedPhaseIds(next);
      return next;
    });
  }

  function collapseAllPhases() {
    const allIds = phases.map((p) => p.id);
    setCollapsedPhaseIds(allIds);
    persistCollapsedPhaseIds(allIds);
  }

  function expandAllPhases() {
    setCollapsedPhaseIds([]);
    persistCollapsedPhaseIds([]);
  }

  const isGraphView = visiblePhaseViewMode === 'graph';

  // The Activity boundary keeps plan view, collapse, and drag state alive while
  // the user works in another tab; only the active tab contributes markup.
  if (!active || !project) return null;

  return (
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
            {visiblePhaseViewMode !== 'assign' && visiblePhaseViewMode !== 'graph' && (
            <div className="input-glow flex items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-3 h-9">
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
                    visiblePhaseViewMode === viewMode
                      ? 'bg-[var(--accent-600)] text-white shadow-[var(--shadow-sm)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] active:scale-[0.96]',
                  )}
                >
                  {viewMode === 'graph' ? <Network size={14} className="mr-1.5 inline" /> : null}
                  {viewMode}
                </button>
              ))}
            </div>
            {visiblePhaseViewMode === 'gantt' ? (
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
            {visiblePhaseViewMode !== 'assign' && (
            <>
            {visiblePhaseViewMode === 'list' && phases.length > 0 && (
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
            {visiblePhaseViewMode === 'list' && !bulk.bulkMode && tasks.some((task) => task.status === 'done') && (
              <ShowCompletedToggle
                showCompleted={showCompletedTasks}
                onShowCompletedChange={setShowCompletedTasks}
              />
            )}
            {visiblePhaseViewMode === 'list' && tasks.length > 0 && !bulk.bulkMode && (
              <button
                type="button"
                onClick={bulk.enterBulkMode}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              >
                Select
              </button>
            )}
            {phases.length > 0 ? (
              <AIPlanControl hasPhases proposalActions={proposalActions} />
            ) : null}
            <Button onClick={handleAddPhase} disabled={creatingPhase || savingPhaseIds.size > 0}>
              {creatingPhase ? <LoaderCircle className="animate-spin" /> : <Plus />}
              Add phase
            </Button>
            </>
            )}
          </div>
          {/* Bulk action bar inside sticky header so it stays visible when scrolled */}
          {bulk.bulkMode && visiblePhaseViewMode === 'list' && (
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
                    requestConfirmation({
                      title: `Delete ${count} task${count > 1 ? 's' : ''}?`,
                      message: 'Each selected task will be deleted locally, cancelled locally, closed, or deleted at its source according to its task policy.',
                      confirmLabel: 'Remove tasks',
                      variant: 'danger',
                      onConfirm: async (close) => {
                        close();
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
          {phases.length === 0 && visiblePhaseViewMode !== 'graph' ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] p-8 text-center">
              <p className="text-sm font-medium text-[var(--text-primary)]">No phases yet</p>
              <p className="mt-2 text-sm text-[var(--text-tertiary)]">Create the first phase to start shaping delivery.</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <AIPlanControl
                  hasPhases={false}
                  proposalActions={proposalActions}
                  variant="secondary"
                />
                <Button onClick={handleAddPhase} disabled={creatingPhase || savingPhaseIds.size > 0}>
                  <Plus />
                  Add first phase
                </Button>
              </div>
            </div>
          ) : visiblePhaseViewMode === 'graph' ? (
            <ProjectStructureGraph
              projectId={projectId}
              refreshKey={graphRefreshKey}
              selectedTaskId={selectedTaskId}
              onTaskSelect={handleGraphTaskSelect}
              onPhaseDependencyRemoved={handlePhaseDependencyRemoved}
            />
          ) : visiblePhaseViewMode === 'list' ? (
            <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              <SortableContext items={phases.map((p) => `phase:${p.id}`)} strategy={verticalListSortingStrategy}>
                <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-4">
                  {phases.map((phase) => {
                    const allEntries = phaseEntries[phase.id] ?? [];
                    const completionFilteredEntries = filterCompletedTasks(
                      allEntries,
                      showCompletedTasks,
                      ({ task }) => task.status,
                    );
                    const entries = normalizedPhaseTaskSearch
                      ? completionFilteredEntries.filter(({ task }) => task.title.toLowerCase().includes(normalizedPhaseTaskSearch))
                      : completionFilteredEntries;
                    const isCollapsed = collapsedPhaseIds.includes(phase.id);
                    const isEditing = editingPhaseId === phase.id;
                    const isSaving = savingPhaseIds.has(phase.id);
                    const isPhaseMutationDisabled = savingPhaseIds.size > 0;
                    const phaseColor = getPhaseColor(phase, project);

                    // Progress for this phase
                    const statusSummary = getPhaseTaskStatusSummary(
                      phase.status,
                      allEntries.map(({ task }) => task.status),
                    );
                    const { doneCount, totalCount } = statusSummary;
                    const pctComplete = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
                    const compactCompletedPhase = shouldCompactCompletedPhase(
                      phase.status,
                      completionFilteredEntries.length,
                      showCompletedTasks,
                    );

                    if (compactCompletedPhase) {
                      return (
                        <SortablePhaseItem key={phase.id} phaseId={phase.id}>
                          {(dragHandleProps) => (
                            <div
                              ref={(node) => {
                                if (node) phaseCardRefs.current.set(phase.id, node);
                                else phaseCardRefs.current.delete(phase.id);
                              }}
                              tabIndex={-1}
                              role="region"
                              aria-label={`${phase.name} phase`}
                              className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                              style={{ scrollMarginTop: stickyHeaderHeight + 24 }}
                            >
                              <button
                                type="button"
                                {...dragHandleProps}
                                className="inline-flex min-h-8 min-w-8 cursor-grab items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
                                aria-label="Drag to reorder phase"
                              >
                                <GripVertical size={14} />
                              </button>
                              <CheckCircle2 size={16} className="shrink-0 text-[var(--success)]" />
                              <span className="min-w-0 truncate text-sm font-medium text-[var(--text-secondary)]">
                                {phase.name}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleCyclePhaseStatus(phase)}
                                disabled={isPhaseMutationDisabled}
                                title="Click to cycle status"
                              >
                                <PhaseStatusBadge status={phase.status} />
                              </button>
                              <span className="text-xs text-[var(--text-tertiary)]">
                                {totalCount === 0
                                  ? 'No tasks'
                                  : `${doneCount} ${doneCount === 1 ? 'task' : 'tasks'} complete`}
                              </span>
                              <button
                                type="button"
                                onClick={() => setShowCompletedTasks(true)}
                                className="ml-auto text-xs font-medium text-[var(--accent-400)] hover:text-[var(--accent-300)]"
                              >
                                Show tasks
                              </button>
                            </div>
                          )}
                        </SortablePhaseItem>
                      );
                    }

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
                            <div className="relative rounded-t-[var(--radius-lg)] bg-[var(--surface-1)]">
                              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                                <div className="flex min-w-0 gap-3">
                                  <span className="mt-4 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: phaseColor }} aria-hidden="true" />
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
                                      {statusSummary.mismatchMessage ? (
                                        <Tooltip content={statusSummary.mismatchMessage} placement="bottom">
                                          <span
                                            role="img"
                                            tabIndex={0}
                                            title={statusSummary.mismatchMessage}
                                            aria-label={`Phase status warning: ${statusSummary.mismatchMessage}`}
                                            className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--warning)]/60"
                                          >
                                            <CircleAlert size={13} />
                                          </span>
                                        </Tooltip>
                                      ) : null}
                                      {/* Task count — read-only pill, visually distinct */}
                                      <span className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]">
                                        <Layers3 size={11} />
                                        {normalizedPhaseTaskSearch || !showCompletedTasks ? `${entries.length}/${allEntries.length}` : entries.length} {allEntries.length === 1 ? 'task' : 'tasks'}
                                      </span>
                                      {/* Progress indicator */}
                                      {totalCount > 0 && (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                                          <span className="font-medium text-[var(--text-secondary)]">{doneCount}/{totalCount}</span>
                                          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-[var(--surface-2)]">
                                            <span
                                              className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
                                              style={{ width: `${pctComplete}%`, backgroundColor: pctComplete === 100 ? 'var(--success)' : phaseColor }}
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
                                      <label className="input-glow inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border-strong)] bg-[var(--surface-1)] px-2 py-1 cursor-pointer hover:bg-[var(--surface-2)] hover:border-[var(--accent-500)]/40" title="Click to edit estimated days">
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
                                    onClick={() => handleDeletePhase(phase)}
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
                                        <p className="text-sm text-[var(--text-tertiary)]">
                                          {!showCompletedTasks && allEntries.length > 0 && completionFilteredEntries.length === 0
                                            ? 'Completed tasks are hidden.'
                                            : normalizedPhaseTaskSearch && completionFilteredEntries.length > 0
                                              ? 'No tasks match this filter.'
                                              : 'No tasks in this phase yet.'}
                                        </p>
                                        {!showCompletedTasks && completionFilteredEntries.length === 0 && allEntries.length > 0 ? (
                                          <button
                                            type="button"
                                            onClick={() => setShowCompletedTasks(true)}
                                            className="mt-2 text-xs font-medium text-[var(--accent-400)] hover:text-[var(--accent-300)]"
                                          >
                                            Show completed tasks
                                          </button>
                                        ) : null}
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
                                                  taskOverlayActions.requestCreateTask({ phaseId: phase.id });
                                                }}
                                                onLinkExisting={() => {
                                                  setAddTaskMenuPhaseId(null);
                                                  taskOverlayActions.requestLinkTasks({ phaseId: phase.id });
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
                                          const isBulkSelected = bulk.bulkSelected.has(task.id);
                                          return (
                                            <DraggableTaskItem key={item.id} taskId={task.id}>
                                              {(taskDragHandleProps) => (
                                                <PlanTaskRow
                                                  task={task}
                                                  dragHandleProps={taskDragHandleProps}
                                                  dragLabel="Drag task to another phase"
                                                  isSelected={selectedTaskId === task.id}
                                                  isCompleting={completingIds.has(task.id)}
                                                  bulkMode={bulk.bulkMode}
                                                  bulkSelected={isBulkSelected}
                                                  onBulkToggle={() => bulk.toggleItem(task.id)}
                                                  onSelect={toggleTask}
                                                  onDoubleClick={handleTaskDoubleClick}
                                                  onModifierClick={handleBulkModifierClick}
                                                  onComplete={handleCompleteTask}
                                                  isInMyDay={myDayTaskIds.has(task.id)}
                                                  contextMenuActions={getTaskContextActions(task)}
                                                  phaseMenuItems={phaseMenuItems}
                                                  projects={allProjects}
                                                />
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
                                                  taskOverlayActions.requestCreateTask({ phaseId: phase.id });
                                                }}
                                                onLinkExisting={() => {
                                                  setAddTaskMenuPhaseId(null);
                                                  taskOverlayActions.requestLinkTasks({ phaseId: phase.id });
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
              {visibleUnassignedTasks.length > 0 && (
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
                        {visibleUnassignedTasks.length}
                      </span>
                    </div>
                    <span className="ml-auto text-xs text-[var(--text-tertiary)]">Drag into a phase above</span>
                  </button>
                  {!unassignedCollapsed && (
                    <div className="border-t border-[var(--border)] p-4">
                      <SortableContext items={visibleUnassignedTasks.map((t) => `task:${t.id}`)} strategy={verticalListSortingStrategy}>
                        <div className="space-y-2">
                          {visibleUnassignedTasks.map((task) => {
                            const isBulkSelected = bulk.bulkSelected.has(task.id);
                            return (
                              <DraggableTaskItem key={task.id} taskId={task.id}>
                                {(taskDragHandleProps) => (
                                  <PlanTaskRow
                                    task={task}
                                    dragHandleProps={taskDragHandleProps}
                                    dragLabel="Drag task to a phase"
                                    isSelected={selectedTaskId === task.id}
                                    isCompleting={completingIds.has(task.id)}
                                    bulkMode={bulk.bulkMode}
                                    bulkSelected={isBulkSelected}
                                    onBulkToggle={() => bulk.toggleItem(task.id)}
                                    onSelect={toggleTask}
                                    onDoubleClick={handleTaskDoubleClick}
                                    onModifierClick={handleBulkModifierClick}
                                    onComplete={handleCompleteTask}
                                    isInMyDay={myDayTaskIds.has(task.id)}
                                    contextMenuActions={getTaskContextActions(task)}
                                    phaseMenuItems={phaseMenuItems}
                                    projects={allProjects}
                                  />
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
          ) : visiblePhaseViewMode === 'assign' ? (
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
              onSelectTask={(taskId) => taskId === null ? setSelectedTaskId(null) : toggleTask(taskId)}
              onDoubleClickTask={handleTaskDoubleClick}
              onCompleteTask={handleCompleteTask}
              onRenamePhase={renamePhase}
              savingPhaseIds={savingPhaseIds}
              phaseMutationPending={savingPhaseIds.size > 0}
              createPhaseDisabled={creatingPhase || savingPhaseIds.size > 0}
              onCreatePhase={handleAddPhase}
              onCreateNewTask={() => taskOverlayActions.requestCreateTask({ phaseId: null })}
              onLinkExistingTask={() => taskOverlayActions.requestLinkTasks({ phaseId: null })}
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
                                onClick={() => toggleTask(taskBar.task.id)}
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
  );
}
