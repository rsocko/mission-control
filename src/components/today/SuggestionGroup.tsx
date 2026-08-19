'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useListAnimate } from '@/lib/hooks/useListAnimate';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpDown, ChevronDown, ChevronRight, Plus, RotateCcw } from 'lucide-react';
import { TaskContextMenu, type HubProject, type TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type { ListGroup } from '@/types/dashboard';
import { Tooltip } from '@/components/ui/Tooltip';
import { formatDueDate } from '@/lib/utils/date-format';
import { extractRecurrenceFromMetadata } from '@/lib/utils/recurrence';
import { ConnectorIcon } from './SortableTaskRow';
import { TaskBlockedBadge, TaskStatusIndicator } from '@/components/task-list/TaskStatusIndicator';
import type { SourceList, SuggestionTask } from './types';

const PAGE_SIZE = 5;
const ITEM_HEIGHT = 40;

const COLOR_STYLES: Record<string, { header: string; border: string; bg: string }> = {
  red: { header: 'text-red-400', border: 'border-red-800/40', bg: 'bg-red-900/20' },
  orange: { header: 'text-orange-400', border: 'border-orange-800/40', bg: 'bg-orange-900/20' },
  amber: { header: 'text-amber-400', border: 'border-amber-800/40', bg: 'bg-amber-900/20' },
  blue: { header: 'text-blue-400', border: 'border-blue-800/40', bg: 'bg-blue-900/20' },
  cyan: { header: 'text-cyan-400', border: 'border-cyan-800/40', bg: 'bg-cyan-900/20' },
  purple: { header: 'text-purple-400', border: 'border-purple-800/40', bg: 'bg-purple-900/20' },
  emerald: { header: 'text-emerald-400', border: 'border-emerald-800/40', bg: 'bg-emerald-900/20' },
  rose: { header: 'text-rose-400', border: 'border-rose-800/40', bg: 'bg-rose-900/20' },
};

type SortDirection = 'asc' | 'desc';

interface SuggestionGroupProps {
  title: string;
  icon: ReactNode;
  tasks: SuggestionTask[];
  color: string;
  onAdd: (taskId: string) => void;
  onSelect: (taskId: string) => void;
  getContextMenuActions: (task: SuggestionTask) => TaskContextMenuActions;
  sourceLists: SourceList[];
  listGroups: ListGroup[];
  projects: HubProject[];
  sortable?: boolean;
}

export function SuggestionGroup({
  title,
  icon,
  tasks,
  color,
  onAdd,
  onSelect,
  getContextMenuActions,
  sourceLists,
  listGroups,
  projects,
  sortable = false,
}: SuggestionGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const parentRef = useRef<HTMLDivElement>(null);
  const [suggestionsRef] = useListAnimate({ duration: 150 });
  const styles = COLOR_STYLES[color] || COLOR_STYLES.blue;

  const sortedTasks = useMemo(() => {
    if (!sortable) return tasks;
    return [...tasks].sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      const cmp = a.dueDate.localeCompare(b.dueDate);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [tasks, sortable, sortDir]);

  const totalPages = Math.ceil(sortedTasks.length / PAGE_SIZE);

  useEffect(() => {
    if (totalPages > 0 && pageIndex >= totalPages) {
      setPageIndex(totalPages - 1);
    }
  }, [pageIndex, totalPages]);

  const clampedPageIndex = totalPages > 0 ? Math.min(pageIndex, totalPages - 1) : 0;
  const visibleTasks = useMemo(
    () => sortedTasks.slice(clampedPageIndex * PAGE_SIZE, (clampedPageIndex + 1) * PAGE_SIZE),
    [clampedPageIndex, sortedTasks],
  );
  const hasMore = clampedPageIndex < totalPages - 1;
  const hasPrev = clampedPageIndex > 0;
  const rowVirtualizer = useVirtualizer({
    count: visibleTasks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 3,
  });
  const useVirtual = visibleTasks.length > 15;

  if (tasks.length === 0) return null;

  return (
    <div className={`rounded-lg border ${styles.border} overflow-hidden`}>
      <div className={`flex items-center ${styles.bg}`}>
        <button onClick={() => setExpanded(!expanded)} className="flex-1 px-3 py-2 flex items-center gap-2 hover:brightness-110 transition-[filter]">
          <span className={styles.header}>{icon}</span>
          <span className={`text-xs font-semibold ${styles.header} flex-1 text-left`}>{title}</span>
          <span className={`text-xs ${styles.header} font-mono`}>{tasks.length}</span>
          <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.15 }} className={styles.header}>
            <ChevronRight size={12} />
          </motion.span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            {sortable && (
              <div className="px-3 py-1 border-b border-[var(--border-subtle)] flex items-center">
                <button onClick={() => setSortDir((dir) => dir === 'asc' ? 'desc' : 'asc')} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] flex items-center gap-1 transition-colors">
                  <ArrowUpDown size={9} />
                  Due date: {sortDir === 'asc' ? 'oldest first' : 'newest first'}
                </button>
              </div>
            )}
            {useVirtual ? (
              <div ref={parentRef} className="max-h-[320px] overflow-y-auto">
                <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const task = visibleTasks[virtualRow.index];
                    return (
                      <div key={task.id} className="absolute left-0 top-0 w-full" style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}>
                        <SuggestionRow task={task} styles={styles} onAdd={onAdd} onSelect={onSelect} getContextMenuActions={getContextMenuActions} sourceLists={sourceLists} listGroups={listGroups} projects={projects} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div ref={suggestionsRef} className="px-2 py-1.5 space-y-0.5">
                {visibleTasks.map((task) => <SuggestionRow key={task.id} task={task} styles={styles} onAdd={onAdd} onSelect={onSelect} getContextMenuActions={getContextMenuActions} sourceLists={sourceLists} listGroups={listGroups} projects={projects} />)}
              </div>
            )}
            {totalPages > 1 && (
              <div className="px-3 py-1.5 border-t border-[var(--border-subtle)] flex items-center justify-between">
                <button onClick={() => setPageIndex((prev) => Math.max(prev - 1, 0))} disabled={!hasPrev} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] py-1 px-2 rounded hover:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center gap-0.5">
                  <ChevronDown size={10} className="rotate-90" />
                  Prev
                </button>
                <span className="text-[9px] text-[var(--text-muted)]">{clampedPageIndex + 1} / {totalPages}</span>
                <button onClick={() => setPageIndex((prev) => Math.min(prev + 1, totalPages - 1))} disabled={!hasMore} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] py-1 px-2 rounded hover:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center gap-0.5">
                  Next
                  <ChevronDown size={10} className="-rotate-90" />
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SuggestionRow({
  task,
  styles,
  onAdd,
  onSelect,
  getContextMenuActions,
  sourceLists,
  listGroups,
  projects,
}: {
  task: SuggestionTask;
  styles: { header: string };
  onAdd: (taskId: string) => void;
  onSelect: (taskId: string) => void;
  getContextMenuActions: (task: SuggestionTask) => TaskContextMenuActions;
  sourceLists: SourceList[];
  listGroups: ListGroup[];
  projects: HubProject[];
}) {
  return (
    <TaskContextMenu
      task={{
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        connectorType: task.connectorType,
        connectorInstanceId: task.connectorInstanceId,
        sourceId: task.sourceId,
        dueDate: task.dueDate,
        recurrence: extractRecurrenceFromMetadata(task.metadata),
        localDisposition: task.localDisposition,
        taskSourceModel: task.taskSourceModel,
        editPolicy: task.editPolicy,
      }}
      actions={getContextMenuActions(task)}
      sourceLists={sourceLists}
      listGroups={listGroups}
      projects={projects}
    >
      <div
        className="flex items-center gap-2 rounded-md hover:bg-white/5 transition-colors group/item"
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-400)]"
          onClick={() => onSelect(task.id)}
        >
          <TaskStatusIndicator status={task.status} microStatus={task.microStatus} size="sm" />
          <ConnectorIcon type={task.connectorType} size={12} />
          <span className="min-w-0 flex-1">
            <span className="text-xs text-[var(--text-primary)] truncate block">{task.title}</span>
            <span className="flex items-center gap-2">
              {task.dueDate && <span className={`text-xs ${styles.header}`}>due {formatDueDate(task.dueDate)}</span>}
              <TaskBlockedBadge status={task.status} microStatus={task.microStatus} />
              {(task.pushCount ?? 0) >= 2 && (
                <span
                  className="inline-flex items-center gap-0.5 text-xs text-amber-400"
                  title={`Rescheduled ${task.pushCount ?? 0} times`}
                >
                  <RotateCcw size={9} aria-hidden="true" /> {task.pushCount ?? 0}
                </span>
              )}
            </span>
          </span>
        </button>
        <Tooltip content="Add to My Day">
          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            onClick={() => onAdd(task.id)}
            className="mr-2 text-xs w-5 h-5 flex items-center justify-center bg-[var(--surface-1)] border border-[var(--border)] rounded hover:bg-blue-900/30 hover:border-blue-400 transition-colors flex-shrink-0 opacity-0 group-hover/item:opacity-100 focus:opacity-100"
            aria-label={`Add "${task.title}" to My Day`}
          >
            <Plus size={10} />
          </motion.button>
        </Tooltip>
      </div>
    </TaskContextMenu>
  );
}
