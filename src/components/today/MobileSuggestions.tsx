'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertCircle, ArrowUpDown, Brain, Calendar, CalendarClock,
  ChevronDown, ChevronRight, ChevronUp,
  Flame, History, Plus, RotateCcw, Sparkles,
} from 'lucide-react';
import { ConnectorIcon } from './SortableTaskRow';
import { formatDueDate } from '@/lib/utils/date-format';
import { getLocalToday } from '@/lib/utils/client-date';
import type { SuggestionGroups, SuggestionTask } from './types';

interface MobileSuggestionsProps {
  suggestions: SuggestionGroups;
  onAddToDay: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  initialExpanded?: boolean;
}

interface GroupConfig {
  key: keyof SuggestionGroups;
  title: string;
  icon: React.ReactNode;
  color: string;
  sortable?: boolean;
}

const GROUPS: GroupConfig[] = [
  { key: 'yesterday', title: "Yesterday's Incomplete", icon: <History size={16} />, color: 'amber' },
  { key: 'overdue', title: 'Overdue', icon: <AlertCircle size={16} />, color: 'red', sortable: true },
  { key: 'dueToday', title: 'Due Today', icon: <CalendarClock size={16} />, color: 'blue' },
  { key: 'dueThisWeek', title: 'Due This Week', icon: <Calendar size={16} />, color: 'cyan', sortable: true },
  { key: 'highPriority', title: 'High Priority', icon: <Flame size={16} />, color: 'orange' },
  { key: 'aiRecommended', title: 'AI Recommended', icon: <Brain size={16} />, color: 'purple' },
  { key: 'recentlyAdded', title: 'Recently Added', icon: <Plus size={16} />, color: 'emerald' },
  { key: 'carriedForward', title: 'Carried Forward', icon: <RotateCcw size={16} />, color: 'rose' },
];

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

const PAGE_SIZE = 5;

/**
 * Accordion-style suggestions for mobile Today view.
 * Each group expands/collapses independently with pagination and optional sort.
 * Only one group is open at a time; expanding a group snaps it into view.
 */
export function MobileSuggestions({ suggestions, onAddToDay, onSelectTask, initialExpanded = false }: MobileSuggestionsProps) {
  const [sectionExpanded, setSectionExpanded] = useState(initialExpanded);
  const [expandedGroup, setExpandedGroup] = useState<keyof SuggestionGroups | null>(null);
  const prefersReducedMotion = useReducedMotion();

  const totalSuggestions = Object.values(suggestions).reduce((sum, group) => sum + group.length, 0);

  const handleGroupToggle = useCallback((key: keyof SuggestionGroups) => {
    setExpandedGroup((prev) => (prev === key ? null : key));
  }, []);

  if (totalSuggestions === 0) return null;

  return (
    <div className="md:hidden border-t border-[var(--border)] mt-4">
      <button
        onClick={() => setSectionExpanded(!sectionExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 active:bg-[var(--surface-0)] transition-colors"
        aria-expanded={sectionExpanded}
        aria-label={`Suggestions (${totalSuggestions} available)`}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
          <Sparkles size={14} className="text-purple-400" />
          Suggestions
          <span className="text-xs text-[var(--text-muted)] bg-[var(--surface-2)] px-1.5 py-0.5 rounded-full">
            {totalSuggestions}
          </span>
        </span>
        {sectionExpanded ? <ChevronUp size={16} className="text-[var(--text-muted)]" /> : <ChevronDown size={16} className="text-[var(--text-muted)]" />}
      </button>

      <AnimatePresence>
        {sectionExpanded && (
          <motion.div
            initial={prefersReducedMotion ? undefined : { height: 0, opacity: 0 }}
            animate={prefersReducedMotion ? undefined : { height: 'auto', opacity: 1 }}
            exit={prefersReducedMotion ? undefined : { height: 0, opacity: 0 }}
            transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-2">
              {GROUPS.map(({ key, title, icon, color, sortable }) => {
                const tasks = suggestions[key];
                if (tasks.length === 0) return null;
                return (
                  <MobileSuggestionAccordion
                    key={key}
                    groupKey={key}
                    title={title}
                    icon={icon}
                    color={color}
                    tasks={tasks}
                    sortable={sortable}
                    expanded={expandedGroup === key}
                    onToggle={handleGroupToggle}
                    onAdd={onAddToDay}
                    onSelect={onSelectTask}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MobileSuggestionAccordion({
  groupKey,
  title,
  icon,
  color,
  tasks,
  sortable,
  expanded,
  onToggle,
  onAdd,
  onSelect,
}: {
  groupKey: keyof SuggestionGroups;
  title: string;
  icon: React.ReactNode;
  color: string;
  tasks: SuggestionTask[];
  sortable?: boolean;
  expanded: boolean;
  onToggle: (key: keyof SuggestionGroups) => void;
  onAdd: (taskId: string) => void;
  onSelect: (taskId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
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
  const clampedPage = Math.min(pageIndex, Math.max(0, totalPages - 1));
  const visibleTasks = sortedTasks.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  useEffect(() => {
    if (totalPages > 0 && pageIndex >= totalPages) {
      setPageIndex(totalPages - 1);
    }
  }, [pageIndex, totalPages]);

  const handleToggle = useCallback(() => {
    onToggle(groupKey);
    // Snap into view after expansion animation settles
    if (!expanded) {
      setTimeout(() => {
        containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 250);
    }
  }, [expanded, groupKey, onToggle]);

  const handlePageChange = useCallback((dir: 'prev' | 'next') => {
    setPageIndex((prev) => dir === 'prev' ? Math.max(0, prev - 1) : Math.min(totalPages - 1, prev + 1));
  }, [totalPages]);

  return (
    <div ref={containerRef} className={`rounded-lg border ${styles.border} overflow-hidden`}>
      {/* Group header — always visible */}
      <button
        onClick={handleToggle}
        className={`w-full flex items-center gap-3 px-4 py-3 min-h-[48px] ${styles.bg} active:brightness-110 transition-[filter]`}
        aria-expanded={expanded}
        aria-label={`${title} (${tasks.length})`}
      >
        <span className={styles.header}>{icon}</span>
        <span className={`text-sm font-semibold ${styles.header} flex-1 text-left uppercase`}>{title}</span>
        <span className={`text-sm font-mono ${styles.header}`}>{tasks.length}</span>
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className={styles.header}
        >
          <ChevronRight size={14} />
        </motion.span>
      </button>

      {/* Expanded content with tasks + pagination */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            {/* Sort control */}
            {sortable && (
              <div className="px-4 py-2 border-b border-[var(--border-subtle)] flex items-center">
                <button
                  onClick={() => {
                    setSortDir((dir) => dir === 'asc' ? 'desc' : 'asc');
                    setPageIndex(0);
                  }}
                  className="text-xs text-[var(--text-muted)] active:text-[var(--text-secondary)] flex items-center gap-1.5 min-h-[36px] transition-colors"
                >
                  <ArrowUpDown size={12} />
                  Due date: {sortDir === 'asc' ? 'oldest first' : 'newest first'}
                </button>
              </div>
            )}

            {/* Task list */}
            <div className="divide-y divide-[var(--border-subtle)]">
              {visibleTasks.map((task) => (
                <div key={task.id} className="flex items-center min-h-[52px]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                    onClick={() => onSelect(task.id)}
                  >
                    <ConnectorIcon type={task.connectorType} size={14} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-[var(--text-primary)] truncate">{task.title}</span>
                      {task.dueDate && (
                        <span className={`block text-xs mt-0.5 ${task.dueDate < getLocalToday() ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                          {formatDueDate(task.dueDate)}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onAdd(task.id)}
                    className="mr-4 flex-shrink-0 px-3 py-2 text-xs font-medium text-[var(--accent-400)] bg-[var(--accent-500)]/10 rounded-md active:bg-[var(--accent-500)]/20 transition-colors min-h-[44px] flex items-center"
                    aria-label={`Add "${task.title}" to My Day`}
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-4 py-2.5 border-t border-[var(--border-subtle)] flex items-center justify-between">
                <button
                  onClick={() => handlePageChange('prev')}
                  disabled={clampedPage === 0}
                  className="text-xs text-[var(--text-muted)] active:text-[var(--text-secondary)] py-2 px-3 rounded-md active:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none min-h-[40px] flex items-center gap-1"
                >
                  <ChevronDown size={12} className="rotate-90" />
                  Prev
                </button>
                <span className="text-xs text-[var(--text-muted)]">{clampedPage + 1} / {totalPages}</span>
                <button
                  onClick={() => handlePageChange('next')}
                  disabled={clampedPage >= totalPages - 1}
                  className="text-xs text-[var(--text-muted)] active:text-[var(--text-secondary)] py-2 px-3 rounded-md active:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none min-h-[40px] flex items-center gap-1"
                >
                  Next
                  <ChevronDown size={12} className="-rotate-90" />
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
