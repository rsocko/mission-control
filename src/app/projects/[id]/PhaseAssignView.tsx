'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  DndContext,
  DragOverlay,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  GripVertical,
Layers,
LoaderCircle,
Plus,
Search,
X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import { TaskContextMenu, type TaskContextMenuActions, type HubProject } from '@/components/task-list/TaskContextMenu';
import { cn } from '@/lib/utils';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { DraggableTaskItem, PhaseAddTaskMenu, PriorityDot, TaskDisplayId, TaskInfoBadges, TaskStatusBadge } from './components';
import { BUTTON_TRANSITION } from './constants';
import { getConnectorIcon, getPhaseColor } from './utils';
import type { PhaseTaskEntry, ProjectPhase, ProjectTask } from './types';

// ─── Droppable phase card with visible highlight ────────────────────

function AssignPhaseTarget({
  phase,
  entries,
  isExpanded,
  isDragging,
  onToggleExpand,
  onRenamePhase,
  isSaving,
  isRenameDisabled,
  onSelectTask,
  selectedTaskId,
  completingIds,
  myDayTaskIds,
  getTaskContextActions,
  phaseMenuItems,
  onCompleteTask,
  projects = [],
}: {
  phase: ProjectPhase;
  entries: PhaseTaskEntry[];
  isExpanded: boolean;
  isDragging: boolean;
  onToggleExpand: () => void;
  onRenamePhase: (phase: ProjectPhase, name: string) => void | Promise<void>;
  isSaving: boolean;
  isRenameDisabled: boolean;
  onSelectTask: (taskId: string | null) => void;
  selectedTaskId: string | null;
  completingIds: Set<string>;
  myDayTaskIds: Set<string>;
  getTaskContextActions: (task: ProjectTask) => TaskContextMenuActions;
  phaseMenuItems: { id: string; name: string }[];
  onCompleteTask: (taskId: string) => void;
  projects?: HubProject[];
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `phase-drop:${phase.id}`,
    data: { type: 'phase-drop' },
  });

  const phaseColor = getPhaseColor(phase);
  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(phase.name);

  function commitName() {
    const trimmed = draftName.trim();
    setIsEditing(false);
    if (!trimmed || trimmed === phase.name) {
      setDraftName(phase.name);
      return;
    }
    setDraftName(trimmed);
    void onRenamePhase(phase, trimmed);
  }

  return (
    <div ref={setNodeRef} className="rounded-[var(--radius-lg)] transition-all duration-150">
      <div
        className={cn(
          'rounded-[var(--radius-md)] border overflow-hidden transition-all duration-150',
          isOver
            ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/8 ring-2 ring-[var(--accent-500)]/40 shadow-[0_0_12px_rgba(var(--accent-rgb,99,102,241),0.15)]'
            : isDragging
              ? 'border-dashed border-[var(--border-strong)] bg-[var(--surface-0)]'
              : 'border-[var(--border)] bg-[var(--surface-0)]',
        )}
      >
        {/* Phase header */}
        <div
          className={cn(
            'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-1)]/50',
            BUTTON_TRANSITION,
          )}
        >
          <button
            type="button"
            onClick={onToggleExpand}
            className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            aria-label={isExpanded ? `Collapse ${phase.name}` : `Expand ${phase.name}`}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <span
            className="h-3 w-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: phaseColor }}
          />
          {isEditing ? (
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraftName(phase.name);
                  setIsEditing(false);
                }
              }}
              autoFocus
              className="min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--surface-1)] px-2 py-1 text-sm font-medium text-[var(--text-primary)] outline-none focus:border-[var(--accent-400)]"
              aria-label={`Rename ${phase.name}`}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftName(phase.name);
                setIsEditing(true);
              }}
              disabled={isRenameDisabled}
              className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent)] disabled:pointer-events-none"
              title="Click to rename"
            >
              {phase.name}
            </button>
          )}
          {isSaving ? <LoaderCircle size={14} className="animate-spin text-[var(--text-tertiary)]" /> : null}
          {isOver && (
            <span className="text-xs font-medium text-[var(--accent)] mr-1">Drop here</span>
          )}
          <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-0.5 text-xs text-[var(--text-tertiary)]">
            {entries.length} {entries.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>

        {/* Expanded: draggable tasks within this phase */}
        <AnimatePresence>
          {isExpanded && entries.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <div className="border-t border-[var(--border)] px-3 py-2 space-y-1">
                <SortableContext items={entries.map(({ task }) => `task:${task.id}`)} strategy={verticalListSortingStrategy}>
                  {entries.map(({ task }) => {
                    const ConnectorIcon = getConnectorIcon(task.connectorType);
                    const isDone = task.status === 'done' || completingIds.has(task.id);
                    const isInactive = isInactiveTaskStatus(task.status) || completingIds.has(task.id);
                    return (
                      <DraggableTaskItem key={task.id} taskId={task.id}>
                        {(dragHandleProps) => (
                          <TaskContextMenu
                            task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, connectorType: task.connectorType, dueDate: task.dueDate ?? null, localDisposition: task.localDisposition, taskSourceModel: task.taskSourceModel, editPolicy: task.editPolicy }}
                            isInMyDay={myDayTaskIds.has(task.id)}
                            projectPhases={phaseMenuItems}
                            projects={projects}
                            taskProjectIds={task.hubProjectIds}
                            taskProjectPhaseMemberships={task.projectPhaseMemberships}
                            actions={getTaskContextActions(task)}
                          >
                            <div
                              className={cn(
                                'flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                                selectedTaskId === task.id && 'ring-1 ring-[var(--accent-400)] bg-[var(--surface-1)]',
                                isInactive && 'opacity-50',
                              )}
                              onClick={() => onSelectTask(task.id)}
                            >
                              <button
                                type="button"
                                {...dragHandleProps}
                                className="inline-flex min-h-6 min-w-6 cursor-grab items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] active:cursor-grabbing"
                                aria-label="Drag task to another phase"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <GripVertical size={12} />
                              </button>
                              <CompletionBurst celebrating={completingIds.has(task.id)}>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); void onCompleteTask(task.id); }}
                                  disabled={completingIds.has(task.id)}
                                  className={cn(
                                    'flex-shrink-0 h-[14px] w-[14px] rounded-full border-2 transition-[border-color,background-color,color,transform] duration-200',
                                    isDone
                                      ? 'bg-green-400 border-green-400 text-white'
                                      : 'border-[var(--border-strong)] hover:border-green-500 hover:bg-green-900/30',
                                  )}
                                  aria-label={isDone ? 'Completed' : 'Mark complete'}
                                >
                                  {isDone && <CheckCircle2 size={10} />}
                                </button>
                              </CompletionBurst>
                              <PriorityDot priority={task.priority} />
                              <ConnectorIcon size={11} className="text-[var(--text-tertiary)]" />
                              <span className={cn('truncate text-xs text-[var(--text-secondary)]', isDone && 'line-through')}>{task.title}</span>
                              <TaskDisplayId task={task} />
                            </div>
                          </TaskContextMenu>
                        )}
                      </DraggableTaskItem>
                    );
                  })}
                </SortableContext>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Droppable unassigned panel ─────────────────────────────────────

function UnassignedDropTarget({ isDragging, children }: { isDragging: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'unassigned-drop',
    data: { type: 'unassigned-drop' },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-[var(--radius-lg)] border bg-[var(--surface-0)] shadow-[0_1px_0_rgba(255,255,255,0.04)] transition-all duration-150',
        isOver
          ? 'border-[var(--accent-500)] ring-2 ring-[var(--accent-500)]/40 shadow-[0_0_12px_rgba(var(--accent-rgb,99,102,241),0.15)]'
          : isDragging
            ? 'border-dashed border-[var(--border-strong)]'
            : 'border-[var(--border)]',
      )}
    >
      {children}
    </div>
  );
}

// ─── Main assign view ───────────────────────────────────────────────

interface PhaseAssignViewProps {
  phases: ProjectPhase[];
  unassignedTasks: ProjectTask[];
  phaseEntries: Record<string, PhaseTaskEntry[]>;
  sensors: ReturnType<typeof import('@dnd-kit/core').useSensors>;
  collisionDetection: CollisionDetection;
  tasks: ProjectTask[];
  myDayTaskIds: Set<string>;
  completingIds: Set<string>;
  selectedTaskId: string | null;
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onSelectTask: (taskId: string | null) => void;
  onCompleteTask: (taskId: string) => void;
  onRenamePhase: (phase: ProjectPhase, name: string) => void | Promise<void>;
  savingPhaseIds: Set<string>;
  phaseMutationPending: boolean;
  createPhaseDisabled: boolean;
  onCreatePhase: () => void;
  onCreateNewTask: () => void;
  onLinkExistingTask: () => void;
  activeDragId: string | null;
  getTaskContextActions: (task: ProjectTask) => TaskContextMenuActions;
  phaseMenuItems: { id: string; name: string }[];
  projects?: HubProject[];
}

export function PhaseAssignView({
  phases,
  unassignedTasks,
  phaseEntries,
  sensors,
  collisionDetection,
  tasks,
  myDayTaskIds,
  completingIds,
  selectedTaskId,
  onDragStart,
  onDragEnd,
  onSelectTask,
  onCompleteTask,
  onRenamePhase,
  savingPhaseIds,
  phaseMutationPending,
  createPhaseDisabled,
  onCreatePhase,
  onCreateNewTask,
  onLinkExistingTask,
  activeDragId,
  getTaskContextActions,
  phaseMenuItems,
  projects = [],
}: PhaseAssignViewProps) {
  const [search, setSearch] = useState('');
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [addTaskMenuOpen, setAddTaskMenuOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  useEffect(() => { setPortalContainer(document.body); }, []);

  const isDragging = activeDragId !== null;

  // Freeze the sortable items list while a drag is active to prevent @dnd-kit instability
  const stableUnassigned = useMemo(() => unassignedTasks, [unassignedTasks]);
  const [dragStartItems, setDragStartItems] = useState<ProjectTask[] | null>(null);
  const sortableUnassigned = dragStartItems ?? stableUnassigned;

  const filteredUnassigned = search
    ? sortableUnassigned.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()))
    : sortableUnassigned;

  function handleDragStartWrapped(event: DragStartEvent) {
    setDragStartItems(stableUnassigned);
    onDragStart(event);
  }

  function handleDragEndWrapped(event: DragEndEvent) {
    setDragStartItems(null);
    onDragEnd(event);
  }

  function togglePhaseExpanded(phaseId: string) {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) next.delete(phaseId);
      else next.add(phaseId);
      return next;
    });
  }

  function collapseAll() {
    setExpandedPhases(new Set());
  }

  function expandAll() {
    setExpandedPhases(new Set(phases.map((p) => p.id)));
  }

  const hasPhases = phases.length > 0;

  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStartWrapped} onDragEnd={handleDragEndWrapped}>
      <div className={cn('grid grid-cols-1 gap-4', hasPhases && 'lg:grid-cols-2')}>
        {/* ── Left Panel: Tasks ── */}
        <UnassignedDropTarget isDragging={isDragging}>
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {hasPhases ? 'Unassigned Tasks' : 'All Tasks'}
              </h3>
              <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-0.5 text-xs text-[var(--text-tertiary)]">
                {filteredUnassigned.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative" data-phase-add-menu>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAddTaskMenuOpen((v) => !v)}
                  aria-expanded={addTaskMenuOpen}
                  aria-haspopup="menu"
                  className={cn(
                    'gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)]',
                    BUTTON_TRANSITION,
                  )}
                >
                  <Plus size={14} />
                  Add task
                </Button>
                <AnimatePresence>
                  {addTaskMenuOpen && (
                    <PhaseAddTaskMenu
                      onCreateNew={() => {
                        setAddTaskMenuOpen(false);
                        onCreateNewTask();
                      }}
                      onLinkExisting={() => {
                        setAddTaskMenuOpen(false);
                        onLinkExistingTask();
                      }}
                      onClose={() => setAddTaskMenuOpen(false)}
                    />
                  )}
                </AnimatePresence>
              </div>
              <div className={cn(
                'flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1',
                isDragging && 'opacity-50 pointer-events-none',
              )}>
                <Search size={12} className="text-[var(--text-tertiary)]" />
                <input
                  type="text"
                  placeholder="Filter…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={isDragging}
                  className="bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none w-24"
                />
                {search && !isDragging && (
                  <button type="button" onClick={() => setSearch('')} className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-3">
            {filteredUnassigned.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <CheckCircle2 size={32} className="text-emerald-500/60" />
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {unassignedTasks.length === 0
                    ? hasPhases ? 'All tasks assigned!' : 'No tasks yet'
                    : 'No matches'}
                </p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  {unassignedTasks.length === 0
                    ? hasPhases
                      ? 'Every task in this project belongs to a phase.'
                      : 'Add tasks to this project to get started.'
                    : 'Try a different search term.'}
                </p>
              </div>
            ) : (
              <SortableContext items={filteredUnassigned.map((t) => `task:${t.id}`)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {filteredUnassigned.map((task) => {
                    const ConnectorIcon = getConnectorIcon(task.connectorType);
                    const isDone = task.status === 'done' || completingIds.has(task.id);
                    const isInactive = isInactiveTaskStatus(task.status) || completingIds.has(task.id);
                    return (
                      <DraggableTaskItem key={task.id} taskId={task.id}>
                        {(dragHandleProps) => (
                          <TaskContextMenu
                            task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, connectorType: task.connectorType, dueDate: task.dueDate ?? null, localDisposition: task.localDisposition, taskSourceModel: task.taskSourceModel, editPolicy: task.editPolicy }}
                            isInMyDay={myDayTaskIds.has(task.id)}
                            projectPhases={phaseMenuItems}
                            projects={projects}
                            taskProjectIds={task.hubProjectIds}
                            taskProjectPhaseMemberships={task.projectPhaseMemberships}
                            actions={getTaskContextActions(task)}
                          >
                            <div
                              className={cn(
                                'flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 cursor-pointer hover:bg-[var(--surface-1)] transition-colors',
                                selectedTaskId === task.id && 'ring-1 ring-[var(--accent-400)] border-[var(--accent-400)]',
                                isInactive && 'opacity-50',
                              )}
                              onClick={() => onSelectTask(task.id)}
                            >
                              <button
                                type="button"
                                {...dragHandleProps}
                                className={cn(
                                  'inline-flex min-h-7 min-w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                                  hasPhases ? 'cursor-grab active:cursor-grabbing' : 'cursor-default opacity-0',
                                )}
                                aria-label="Drag task to a phase"
                                onClick={(e) => e.stopPropagation()}
                                tabIndex={hasPhases ? 0 : -1}
                              >
                                <GripVertical size={14} />
                              </button>
                              <CompletionBurst celebrating={completingIds.has(task.id)}>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); void onCompleteTask(task.id); }}
                                  disabled={completingIds.has(task.id)}
                                  className={cn(
                                    'flex-shrink-0 h-[16px] w-[16px] rounded-full border-2 transition-[border-color,background-color,color,transform] duration-200',
                                    isDone
                                      ? 'bg-green-400 border-green-400 text-white'
                                      : 'border-[var(--border-strong)] hover:border-green-500 hover:bg-green-900/30',
                                  )}
                                  aria-label={isDone ? 'Completed' : 'Mark complete'}
                                >
                                  {isDone && <CheckCircle2 size={12} />}
                                </button>
                              </CompletionBurst>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <PriorityDot priority={task.priority} />
                                  <ConnectorIcon size={12} className="text-[var(--text-tertiary)]" />
                                  <p className={cn('truncate text-sm text-[var(--text-primary)]', isDone && 'line-through')}>{task.title}</p>
                                  <TaskDisplayId task={task} />
                                  <TaskInfoBadges task={task} />
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
            )}

            {/* Inline CTA to create first phase when none exist */}
            {!hasPhases && (
              <div className="mt-4 flex flex-col items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border)] bg-[var(--surface-1)]/50 px-4 py-6 text-center">
                <Layers size={24} className="text-[var(--text-tertiary)]" />
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">No phases yet</p>
                  <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                    Create phases to organize and sequence your tasks.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCreatePhase}
                  disabled={createPhaseDisabled}
                  className="gap-2 border border-dashed border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent-400)] hover:text-[var(--accent)]"
                >
                  <Plus size={14} />
                  Create First Phase
                </Button>
              </div>
            )}
          </div>
        </UnassignedDropTarget>

        {/* ── Right Panel: Phase Drop Targets (only when phases exist) ── */}
        {hasPhases && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] shadow-[0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Phases</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={collapseAll}
                  disabled={expandedPhases.size === 0}
                  className={cn('text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] disabled:opacity-40 disabled:pointer-events-none', BUTTON_TRANSITION)}
                >
                  Collapse all
                </button>
                <span className="text-[var(--border)]">|</span>
                <button
                  type="button"
                  onClick={expandAll}
                  disabled={expandedPhases.size === phases.length}
                  className={cn('text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] disabled:opacity-40 disabled:pointer-events-none', BUTTON_TRANSITION)}
                >
                  Expand all
                </button>
              </div>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-3 space-y-2">
              {phases.map((phase) => (
                <AssignPhaseTarget
                  key={phase.id}
                  phase={phase}
                  entries={phaseEntries[phase.id] ?? []}
                  isExpanded={expandedPhases.has(phase.id)}
                  isDragging={isDragging}
                  onToggleExpand={() => togglePhaseExpanded(phase.id)}
                  onRenamePhase={onRenamePhase}
                  isSaving={savingPhaseIds.has(phase.id)}
                  isRenameDisabled={phaseMutationPending}
                  onSelectTask={onSelectTask}
                  selectedTaskId={selectedTaskId}
                  completingIds={completingIds}
                  myDayTaskIds={myDayTaskIds}
                  getTaskContextActions={getTaskContextActions}
                  phaseMenuItems={phaseMenuItems}
                  onCompleteTask={onCompleteTask}
                  projects={projects}
                />
              ))}

              {/* Create phase button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={onCreatePhase}
                disabled={createPhaseDisabled}
                className="w-full justify-center gap-2 border border-dashed border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent-400)] hover:text-[var(--accent)]"
              >
                <Plus size={14} />
                New Phase
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Drag overlay — portalled to document.body to escape transformed ancestors */}
      {portalContainer && createPortal(
        <DragOverlay dropAnimation={null}>
          {activeDragId?.startsWith('task:') ? (() => {
            const dragTaskId = activeDragId.replace('task:', '');
            const dragTask = tasks.find((t) => t.id === dragTaskId);
            if (!dragTask) return null;
            const ConnectorIcon = getConnectorIcon(dragTask.connectorType);
            return (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--accent-500)] bg-[var(--surface-0)] px-3 py-2 opacity-90 shadow-lg">
                <GripVertical size={14} className="text-[var(--text-tertiary)]" />
                <PriorityDot priority={dragTask.priority} />
                <ConnectorIcon size={12} className="text-[var(--text-tertiary)]" />
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">{dragTask.title}</p>
                <TaskStatusBadge status={dragTask.status} statusReason={dragTask.statusReason} />
              </div>
            );
          })() : null}
        </DragOverlay>,
        portalContainer,
      )}
    </DndContext>
  );
}
