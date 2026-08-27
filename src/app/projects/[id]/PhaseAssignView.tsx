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
  GripVertical,
Layers,
LoaderCircle,
Plus,
Search,
X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type TaskContextMenuActions, type HubProject } from '@/components/task-list/TaskContextMenu';
import { cn } from '@/lib/utils';
import { DraggableTaskItem, PhaseAddTaskMenu, PriorityDot, TaskStatusBadge } from './components';
import { BUTTON_TRANSITION } from './constants';
import { getConnectorIcon, getPhaseColor } from './utils';
import { PlanTaskRow } from './PlanTaskRow';
import type {
  PhaseTaskEntry,
  ProjectPhaseViewModel as ProjectPhase,
  ProjectTaskViewModel as ProjectTask,
} from './types';

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
  onDoubleClickTask,
  onOpenTaskNotes,
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
  onDoubleClickTask: (taskId: string) => void;
  onOpenTaskNotes: (taskId: string, mode: 'read' | 'edit') => void;
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
                    return (
                      <DraggableTaskItem key={task.id} taskId={task.id}>
                        {(dragHandleProps) => (
                          <PlanTaskRow
                            task={task}
                            variant="compact"
                            dragHandleProps={dragHandleProps}
                            dragLabel="Drag task to another phase"
                            isSelected={selectedTaskId === task.id}
                            isCompleting={completingIds.has(task.id)}
                            onSelect={onSelectTask}
                            onDoubleClick={onDoubleClickTask}
                            onOpenNotes={onOpenTaskNotes}
                            onComplete={onCompleteTask}
                            isInMyDay={myDayTaskIds.has(task.id)}
                            contextMenuActions={getTaskContextActions(task)}
                            phaseMenuItems={phaseMenuItems}
                            projects={projects}
                          />
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
  onDoubleClickTask: (taskId: string) => void;
  onOpenTaskNotes: (taskId: string, mode: 'read' | 'edit') => void;
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
  onDoubleClickTask,
  onOpenTaskNotes,
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
              <PhaseAddTaskMenu
                open={addTaskMenuOpen}
                onOpenChange={setAddTaskMenuOpen}
                trigger={(
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)]',
                      BUTTON_TRANSITION,
                    )}
                  >
                    <Plus size={14} />
                    Add task
                  </Button>
                )}
                onCreateNew={onCreateNewTask}
                onLinkExisting={onLinkExistingTask}
              />
              <div className={cn(
                'input-glow flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1',
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
                    return (
                      <DraggableTaskItem key={task.id} taskId={task.id}>
                        {(dragHandleProps) => (
                          <PlanTaskRow
                            task={task}
                            dragHandleProps={dragHandleProps}
                            dragLabel="Drag task to a phase"
                            dragEnabled={hasPhases}
                            isSelected={selectedTaskId === task.id}
                            isCompleting={completingIds.has(task.id)}
                            onSelect={onSelectTask}
                            onDoubleClick={onDoubleClickTask}
                            onOpenNotes={onOpenTaskNotes}
                            onComplete={onCompleteTask}
                            isInMyDay={myDayTaskIds.has(task.id)}
                            contextMenuActions={getTaskContextActions(task)}
                            phaseMenuItems={phaseMenuItems}
                            projects={projects}
                          />
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
                  onDoubleClickTask={onDoubleClickTask}
                  onOpenTaskNotes={onOpenTaskNotes}
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
