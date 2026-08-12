'use client';

import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip } from '@/components/ui/Tooltip';
import { kanbanColumn, staggerContainer } from '@/lib/motion';
import type { SwimlaneMode } from './BoardControls';
import { ColumnHeader } from './ColumnHeader';
import { KanbanCard } from './KanbanCard';
import { QuickAddInput } from './QuickAddInput';
import { VISIBLE_LIMIT } from './constants';
import type { KanbanColumn as KanbanColumnType, Task } from './types';

interface BulkBoardState {
  bulkMode: boolean;
  bulkSelected: Set<string>;
  toggleItem: (id: string) => void;
}

interface KanbanBoardProps {
  loading: boolean;
  tasks: Task[];
  columns: KanbanColumnType[];
  globalColumns: KanbanColumnType[];
  unmappedColumns: KanbanColumnType[];
  isProjectView: boolean;
  editingColumns: boolean;
  renamingColumn: string | null;
  renameValue: string;
  quickAddColumn: string | null;
  quickAddTitle: string;
  expandedColumns: Set<string>;
  showSources: boolean;
  showDueDates: boolean;
  searchQuery: string;
  swimlaneMode: SwimlaneMode;
  showScores: boolean;
  dragging: string | null;
  bulk: BulkBoardState;
  getTasksForColumn: (column: KanbanColumnType) => Task[];
  getSwimlaneGroups: (swimlaneMode: SwimlaneMode) => Array<{ key: string; label: string; color?: string }>;
  getTasksForSwimlane: (columnTasks: Task[], swimlaneMode: SwimlaneMode, groupKey: string) => Task[];
  taskMatchesSearch: (task: Task, searchQuery: string) => boolean;
  onFixMappings: () => void;
  onDragStart: (taskId: string) => void;
  onDrop: (columnId: string) => void;
  onTaskClick: (task: Task) => void;
  onStartRename: (id: string, name: string) => void;
  onRenameChange: (value: string) => void;
  onConfirmRename: (columnId: string) => void;
  onCancelRename: () => void;
  onReorder: (columnId: string, direction: 'left' | 'right') => void;
  onRemoveColumn: (columnId: string) => void;
  onToggleQuickAdd: (columnId: string) => void;
  onWipLimitChange: (columnId: string, limit: number | undefined) => void;
  onUpdateColumnMapping: (columnId: string, mappingValue: string) => void;
  onExpandColumn: (columnId: string) => void;
  onCollapseColumn: (columnId: string) => void;
  onQuickAddChange: (value: string) => void;
  onQuickAddSubmit: (columnId: string) => Promise<void>;
  onQuickAddCancel: () => void;
  onSnoozeTask: (taskId: string, until: string) => Promise<void>;
}

// ─── Sortable Card Wrapper ──────────────────────────────────────────────────

interface SortableCardProps {
  task: Task;
  searchQuery: string;
  taskMatchesSearch: (task: Task, searchQuery: string) => boolean;
  bulk: BulkBoardState;
  showSources: boolean;
  showDueDates: boolean;
  showScores: boolean;
  onTaskClick: (task: Task) => void;
  onSnooze: (taskId: string, until: string) => Promise<void>;
  compact?: boolean;
}

function SortableCard({
  task,
  searchQuery,
  taskMatchesSearch,
  bulk,
  showSources,
  showDueDates,
  showScores,
  onTaskClick,
  onSnooze,
  compact = false,
}: SortableCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: bulk.bulkMode });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`transition-opacity duration-200 ease-in-out ${
        searchQuery && !taskMatchesSearch(task, searchQuery) ? (compact ? 'opacity-30' : 'opacity-30 blur-[1px]') : ''
      } ${bulk.bulkMode ? 'relative' : ''}`}
    >
      {bulk.bulkMode && (
        <input
          type="checkbox"
          checked={bulk.bulkSelected.has(task.id)}
          onChange={() => bulk.toggleItem(task.id)}
          aria-label={`Select ${task.title}`}
          className="absolute top-2 left-2 z-10 w-4 h-4 rounded border-[var(--border-strong)] accent-[var(--accent-500)] cursor-pointer"
        />
      )}
      <KanbanCard
        task={task}
        dragHandleProps={bulk.bulkMode ? undefined : { ...attributes, ...listeners }}
        onClick={() => bulk.bulkMode ? bulk.toggleItem(task.id) : onTaskClick(task)}
        showSources={showSources}
        showDueDates={showDueDates}
        showScores={showScores}
        onSnooze={onSnooze}
      />
    </div>
  );
}

// ─── Droppable Column Body ──────────────────────────────────────────────────

interface DroppableColumnProps {
  columnId: string;
  isOver: boolean;
  isOverWip: boolean;
  children: React.ReactNode;
}

function DroppableColumn({ columnId, isOver, isOverWip, children }: DroppableColumnProps) {
  const { setNodeRef } = useDroppable({ id: columnId });

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 rounded-lg border p-2 space-y-2 overflow-y-auto transition-colors ${
        isOverWip
          ? 'border-red-500/40 bg-red-900/10'
          : isOver ? 'border-blue-800/40 bg-blue-900/30' : 'border-[var(--border)] bg-[var(--surface-0)]'
      }`}
    >
      {children}
    </div>
  );
}

// ─── Main Board Component ───────────────────────────────────────────────────

export function KanbanBoard({
  loading,
  tasks,
  columns,
  globalColumns,
  unmappedColumns,
  isProjectView,
  editingColumns,
  renamingColumn,
  renameValue,
  quickAddColumn,
  quickAddTitle,
  expandedColumns,
  showSources,
  showDueDates,
  searchQuery,
  swimlaneMode,
  showScores,
  dragging,
  bulk,
  getTasksForColumn,
  getSwimlaneGroups,
  getTasksForSwimlane,
  taskMatchesSearch,
  onFixMappings,
  onDragStart,
  onDrop,
  onTaskClick,
  onStartRename,
  onRenameChange,
  onConfirmRename,
  onCancelRename,
  onReorder,
  onRemoveColumn,
  onToggleQuickAdd,
  onWipLimitChange,
  onUpdateColumnMapping,
  onExpandColumn,
  onCollapseColumn,
  onQuickAddChange,
  onQuickAddSubmit,
  onQuickAddCancel,
  onSnoozeTask,
}: KanbanBoardProps) {
  const [overColumnId, setOverColumnId] = useState<string | null>(null);

  // Pre-compute task→column mapping to avoid iterating all columns on every dragOver event
  const taskColumnMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of columns) {
      const colTasks = getTasksForColumn(col);
      for (const t of colTasks) {
        map.set(t.id, col.id);
      }
    }
    return map;
  }, [columns, getTasksForColumn]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const activeTask = useMemo(
    () => dragging ? tasks.find(t => t.id === dragging) ?? null : null,
    [dragging, tasks],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    onDragStart(event.active.id as string);
  }, [onDragStart]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over?.id as string | undefined;
    if (!overId) { setOverColumnId(null); return; }
    // overId is either a column ID or a task ID within a column
    const isColumn = columns.some(col => col.id === overId);
    if (isColumn) {
      setOverColumnId(overId);
    } else {
      setOverColumnId(taskColumnMap.get(overId) ?? null);
    }
  }, [columns, taskColumnMap]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const overId = event.over?.id as string | undefined;
    setOverColumnId(null);

    if (!overId) {
      onDrop('');
      return;
    }

    const isColumn = columns.some(col => col.id === overId);
    if (isColumn) {
      onDrop(overId);
    } else {
      const targetCol = taskColumnMap.get(overId);
      onDrop(targetCol || '');
    }
  }, [columns, taskColumnMap, onDrop]);

  const handleDragCancel = useCallback(() => {
    setOverColumnId(null);
    // Reset dragging state via a no-op drop
    onDrop('');
  }, [onDrop]);

  function renderTaskList(columnTasks: Task[], columnId: string, compact = false) {
    const taskIds = columnTasks.map(t => t.id);

    return (
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <AnimatePresence initial={false}>
          {columnTasks.map(task => (
            <motion.div
              key={task.id}
              layout="position"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
              transition={{ type: 'spring', stiffness: 500, damping: 35, mass: 0.8 }}
            >
              <SortableCard
                task={task}
                searchQuery={searchQuery}
                taskMatchesSearch={taskMatchesSearch}
                bulk={bulk}
                showSources={showSources}
                showDueDates={showDueDates}
                showScores={showScores}
                onTaskClick={onTaskClick}
                onSnooze={onSnoozeTask}
                compact={compact}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </SortableContext>
    );
  }

  if (loading) {
    return <div className="text-center text-[var(--text-muted)] py-12 animate-pulse">Loading board...</div>;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {unmappedColumns.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-amber-900/20 border border-amber-800/30 rounded-lg flex items-center gap-2 text-xs text-amber-400">
          <AlertTriangle size={12} />
          <span>
            {unmappedColumns.length} column{unmappedColumns.length > 1 ? 's' : ''} not mapped to a global column.
            Tasks in {unmappedColumns.map(column => `"${column.name}"`).join(', ')} won&apos;t appear in All Projects view.
          </span>
          <button onClick={onFixMappings} className="ml-auto text-amber-300 hover:text-amber-200 font-medium underline">
            Fix mapping
          </button>
        </div>
      )}

      {swimlaneMode !== 'none' ? (
        <div className="space-y-6 h-[calc(100%-60px)] overflow-y-auto">
          {getSwimlaneGroups(swimlaneMode).map(group => {
            const groupTasks = swimlaneMode === 'priority'
              ? tasks.filter(task => task.priority === group.key)
              : tasks;
            if (groupTasks.length === 0) return null;

            return (
              <div key={group.key}>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: group.color }} />
                  <h3 className="text-sm font-semibold text-[var(--text-secondary)]">{group.label}</h3>
                  <span className="text-xs text-[var(--text-muted)]">{groupTasks.length}</span>
                </div>
                <motion.div className="flex gap-4 min-w-max" variants={staggerContainer} initial="hidden" animate="show">
                  {columns.map(column => {
                    const swimlaneTasks = getTasksForSwimlane(getTasksForColumn(column), swimlaneMode, group.key);
                    return (
                      <motion.div
                        key={`${group.key}-${column.id}`}
                        className="w-72 flex-shrink-0"
                        variants={kanbanColumn}
                      >
                        <DroppableColumn
                          columnId={column.id}
                          isOver={overColumnId === column.id}
                          isOverWip={false}
                        >
                          {renderTaskList(swimlaneTasks, column.id, true)}
                        </DroppableColumn>
                      </motion.div>
                    );
                  })}
                </motion.div>
              </div>
            );
          })}
        </div>
      ) : (
        <motion.div className="flex gap-4 min-w-max h-[calc(100%-60px)]" variants={staggerContainer} initial="hidden" animate="show">
          {columns.map((column, index) => {
            const columnTasks = getTasksForColumn(column);
            const isExpanded = expandedColumns.has(column.id);
            const visibleTasks = isExpanded ? columnTasks : columnTasks.slice(0, VISIBLE_LIMIT);
            const hiddenCount = columnTasks.length - VISIBLE_LIMIT;
            const isOverWip = !!column.wipLimit && column.wipLimit > 0 && columnTasks.length > column.wipLimit;

            return (
              <motion.div
                key={column.id}
                className="w-72 flex-shrink-0 flex flex-col"
                variants={kanbanColumn}
              >
                <ColumnHeader
                  column={column}
                  colIdx={index}
                  totalColumns={columns.length}
                  taskCount={columnTasks.length}
                  editingColumns={editingColumns}
                  isProjectView={isProjectView}
                  globalColumns={globalColumns}
                  renamingColumn={renamingColumn}
                  renameValue={renameValue}
                  quickAddColumn={quickAddColumn}
                  wipLimit={column.wipLimit}
                  onStartRename={onStartRename}
                  onRenameChange={onRenameChange}
                  onConfirmRename={onConfirmRename}
                  onCancelRename={onCancelRename}
                  onReorder={onReorder}
                  onRemove={onRemoveColumn}
                  onToggleQuickAdd={onToggleQuickAdd}
                  onWipLimitChange={onWipLimitChange}
                />

                {editingColumns && isProjectView && (
                  <div className="mb-2 ml-4">
                    <Select value={column.globalColumnMapping || ''} onValueChange={value => onUpdateColumnMapping(column.id, value)}>
                      <Tooltip content="Maps to this global column in All Projects view">
                        <SelectTrigger className={`text-xs px-1.5 py-0.5 bg-[var(--surface-0)] border rounded text-[var(--text-muted)] w-full ${
                          !column.globalColumnMapping || !globalColumns.find(globalColumn => globalColumn.id === column.globalColumnMapping)
                            ? 'border-amber-500/50'
                            : 'border-[var(--border)]'
                        }`}>
                          <SelectValue />
                        </SelectTrigger>
                      </Tooltip>
                      <SelectContent>
                        <SelectItem value="">-- Select mapping --</SelectItem>
                        {globalColumns.map(globalColumn => (
                          <SelectItem key={globalColumn.id} value={globalColumn.id}>Maps to: {globalColumn.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <DroppableColumn
                  columnId={column.id}
                  isOver={overColumnId === column.id}
                  isOverWip={isOverWip}
                >
                  {columnTasks.length === 0 && quickAddColumn !== column.id ? (
                    <div className="flex items-center justify-center min-h-[100px]">
                      <p className="text-xs text-[var(--text-muted)]">Ready for tasks — drop one here</p>
                    </div>
                  ) : (
                    <>
                      {renderTaskList(visibleTasks, column.id)}
                      {hiddenCount > 0 && !isExpanded && (
                        <button
                          onClick={() => onExpandColumn(column.id)}
                          className="w-full text-center text-xs text-blue-400 hover:text-blue-300 py-2 rounded hover:bg-blue-900/10 transition-colors"
                        >
                          + {hiddenCount} more item{hiddenCount > 1 ? 's' : ''}
                        </button>
                      )}
                      {isExpanded && hiddenCount > 0 && (
                        <button
                          onClick={() => onCollapseColumn(column.id)}
                          className="w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] py-1.5 rounded hover:bg-[var(--surface-2)] transition-colors"
                        >
                          Show less
                        </button>
                      )}
                    </>
                  )}
                  <QuickAddInput
                    columnId={column.id}
                    isOpen={quickAddColumn === column.id}
                    value={quickAddTitle}
                    onChange={onQuickAddChange}
                    onSubmit={onQuickAddSubmit}
                    onCancel={onQuickAddCancel}
                  />
                </DroppableColumn>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      <DragOverlay dropAnimation={{ duration: 200, easing: 'ease' }}>
        {activeTask && (
          <div className="rotate-[2deg] scale-105 shadow-xl">
            <KanbanCard
              task={activeTask}
              onClick={() => {}}
              showSources={showSources}
              showDueDates={showDueDates}
              showScores={showScores}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
