'use client';

import { useMemo, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, CircleDot, Loader2, Plus } from 'lucide-react';
import { ViewInGraphLink } from '@/components/graph/ViewInGraphLink';
import { taskFilterContextForToday } from '@/lib/task-filter-context';
import { MobileSwipeTaskRow } from './MobileSwipeTaskRow';
import { MobileTodayEmptyState } from './MobileTodayEmptyState';
import { MobileSuggestions } from './MobileSuggestions';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { getLocalToday, getLocalTomorrow } from '@/lib/utils/client-date';
import { partitionMyDayItems } from '@/lib/utils/my-day-view';
import type { MyDayItem, SuggestionGroups } from './types';
import type { LocalDisposition } from '@/types';

interface HubProject {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  phases?: { id: string; name: string }[];
}

interface TaskGroup {
  key: string;
  label: string;
  items: MyDayItem[];
}

interface MobileTodayListProps {
  items: MyDayItem[];
  loading: boolean;
  completingIds: Set<string>;
  suggestions: SuggestionGroups;
  onCompleteTask: (taskId: string) => Promise<boolean>;
  onRemoveFromDay: (taskId: string) => Promise<void>;
  onSetTaskDueDate: (taskId: string, date: string) => Promise<void>;
  onSetTaskLocalDisposition: (taskId: string, disposition: LocalDisposition) => Promise<boolean>;
  onAddToDay: (taskId: string) => void;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  fetchData: () => Promise<void>;
  projects?: HubProject[];
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

/**
 * Mobile-optimized Today screen with priority-sorted, grouped task list.
 *
 * Covers:
 * - F-16: Replace timeline-based layout with compact priority-sorted task list
 * - F-17: Group tasks: Overdue > Due Today > Scheduled > Unscheduled
 */
export function MobileTodayList({
  items,
  loading,
  completingIds,
  suggestions,
  onCompleteTask,
  onRemoveFromDay,
  onSetTaskDueDate,
  onSetTaskLocalDisposition,
  onAddToDay,
  selectedTaskId,
  onSelectTask,
  fetchData,
  projects = [],
}: MobileTodayListProps) {
  const [activeScheduleTrayId, setActiveScheduleTrayId] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  // Pull-to-refresh (disabled when detail sheet is open to prevent background scroll)
  const isSheetOpen = selectedTaskId !== null;
  const onRefresh = useCallback(async () => { await fetchData(); }, [fetchData]);
  const { containerRef, isRefreshing, pullDistance, containerProps, contentStyle } = usePullToRefresh({ onRefresh, enabled: !isSheetOpen });

  const today = getLocalToday();
  const tomorrow = getLocalTomorrow();

  const statusBuckets = useMemo(() => partitionMyDayItems(items), [items]);

  // Active items grouped by schedule category
  const groups: TaskGroup[] = useMemo(() => {
    const active = statusBuckets.open;

    // Sort within each group by priority
    const sortByPriority = (a: MyDayItem, b: MyDayItem) =>
      (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4);

    const overdue: MyDayItem[] = [];
    const dueToday: MyDayItem[] = [];
    const scheduled: MyDayItem[] = [];
    const unscheduled: MyDayItem[] = [];

    for (const item of active) {
      const dueDateStr = item.dueDate?.split('T')[0] ?? null;
      if (dueDateStr && dueDateStr < today) {
        overdue.push(item);
      } else if (dueDateStr === today) {
        dueToday.push(item);
      } else if (dueDateStr && dueDateStr > today) {
        scheduled.push(item);
      } else {
        unscheduled.push(item);
      }
    }

    overdue.sort(sortByPriority);
    dueToday.sort(sortByPriority);
    scheduled.sort(sortByPriority);
    unscheduled.sort(sortByPriority);

    const result: TaskGroup[] = [];
    if (overdue.length > 0) result.push({ key: 'overdue', label: 'Overdue', items: overdue });
    if (dueToday.length > 0) result.push({ key: 'due-today', label: 'Due Today', items: dueToday });
    if (scheduled.length > 0) result.push({ key: 'scheduled', label: 'Scheduled', items: scheduled });
    if (unscheduled.length > 0) result.push({ key: 'unscheduled', label: 'Unscheduled', items: unscheduled });
    return result;
  }, [statusBuckets.open, today]);

  const totalActive = statusBuckets.open.length;
  const cancelledItems = statusBuckets.cancelled;

  // Scheduling actions for swipe tray (F-26)
  const handleScheduleTomorrow = useCallback((taskId: string) => {
    void onSetTaskDueDate(taskId, tomorrow);
  }, [onSetTaskDueDate, tomorrow]);

  const handleSchedulePickDay = useCallback((taskId: string) => {
    // Dispatch event to open the schedule modal
    window.dispatchEvent(new CustomEvent('mission-control:open-schedule-modal', { detail: { taskId } }));
  }, []);

  const handleSnooze = useCallback((taskId: string) => {
    // TODO: Implement true snooze with timed re-appearance once backend supports it.
    // For now, snooze removes from My Day (same as "Not Today"). The task remains in
    // the source system and will reappear if it has a due date or is re-added.
    void onRemoveFromDay(taskId);
  }, [onRemoveFromDay]);

  // AI suggestions for high-priority items (F-19)
  const getAiSuggestion = useCallback((item: MyDayItem): string | undefined => {
    if (item.priority === 'critical') return 'Focus on this first';
    if (item.priority === 'high' && item.dueDate) {
      const dueDateStr = item.dueDate.split('T')[0];
      if (dueDateStr === today) return 'Due today — prioritize';
      if (dueDateStr && dueDateStr < today) return 'Overdue — needs attention';
    }
    return undefined;
  }, [today]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12 sm:hidden" role="status" aria-label="Loading tasks">
        <Loader2 size={24} className="animate-spin text-[var(--accent-400)]" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={`relative flex-1 sm:hidden overscroll-y-contain ${isSheetOpen ? 'overflow-hidden' : 'overflow-y-auto'}`} ref={containerRef} {...containerProps}>
      {/* Pull-to-refresh indicator — absolutely positioned */}
      {(pullDistance > 0 || isRefreshing) && (
        <div className="absolute left-0 right-0 top-0 z-50 flex items-center justify-center pointer-events-none" style={{ height: `${pullDistance}px` }}>
          <Loader2
            size={18}
            className={`text-[var(--accent-400)] ${isRefreshing ? 'animate-spin' : ''}`}
            style={{ opacity: Math.min(pullDistance / 32, 1), transform: `rotate(${pullDistance * 3}deg)` }}
          />
        </div>
      )}

      <div style={contentStyle}>
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">My Day</span>
          <ViewInGraphLink
            context={taskFilterContextForToday(today)}
            origin={{ href: '/today', label: 'My Day' }}
            compact
          />
        </div>
        {totalActive === 0 ? (
          <MobileTodayEmptyState />
        ) : (
          <div className="pb-24">
          {groups.map((group) => (
            <section key={group.key} className="mb-1">
              {/* Section header */}
              <div className="sticky top-0 z-10 bg-[var(--surface-0)]/95 backdrop-blur-sm px-4 py-2 border-b border-[var(--border-subtle)]">
                <h3 className={`text-xs font-semibold uppercase tracking-wide ${
                  group.key === 'overdue' ? 'text-red-400' :
                  group.key === 'due-today' ? 'text-amber-400' :
                  group.key === 'scheduled' ? 'text-blue-400' :
                  'text-[var(--text-muted)]'
                }`}>
                  {group.label}
                  <span className="ml-1.5 text-[var(--text-muted)] font-normal">({group.items.length})</span>
                </h3>
              </div>

              {/* Task rows */}
              {group.items.map((item) => (
                <MobileSwipeTaskRow
                  key={item.id}
                  item={item}
                  onComplete={(taskId) => { void onCompleteTask(taskId); }}
                  onRemoveFromDay={(taskId) => { void onRemoveFromDay(taskId); }}
                  onSetLocalDisposition={(taskId, disposition) => {
                    void onSetTaskLocalDisposition(taskId, disposition);
                  }}
                  onTap={(tappedItem) => {
                    setActiveScheduleTrayId(null);
                    onSelectTask(tappedItem.taskId);
                  }}
                  onScheduleTomorrow={handleScheduleTomorrow}
                  onSchedulePickDay={handleSchedulePickDay}
                  onSnooze={handleSnooze}
                  isCompleting={completingIds.has(item.taskId)}
                  showAiChip={item.priority === 'critical' || item.priority === 'high'}
                  aiSuggestion={getAiSuggestion(item)}
                  projects={projects}
                  scheduleTrayOpen={activeScheduleTrayId === item.taskId}
                  onScheduleTrayChange={(open) => setActiveScheduleTrayId(open ? item.taskId : null)}
                />
              ))}
            </section>
          ))}

          {/* Inline add task button */}
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('mission-control:open-quick-add'));
            }}
            className="w-full flex items-center gap-2 px-4 py-3 mt-2 text-sm text-[var(--text-muted)] active:bg-[var(--surface-2)] transition-colors"
            aria-label="Add a new task to today"
          >
            <Plus size={16} className="text-[var(--accent-400)]" />
            <span className="text-[var(--accent-400)] font-medium">Add task</span>
          </button>

          {/* Inline suggestions below task list */}
          <div>
            <MobileSuggestions
              suggestions={suggestions}
              onAddToDay={onAddToDay}
              onSelectTask={onSelectTask}
            />
          </div>
        </div>
      )}
      {cancelledItems.length > 0 && (
        <section className="border-t border-[var(--border-subtle)]">
          <button
            type="button"
            aria-expanded={showCancelled}
            aria-controls="mobile-my-day-cancelled-tasks"
            onClick={() => setShowCancelled((current) => !current)}
            className="flex w-full items-center gap-1 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"
          >
            {showCancelled ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Cancelled ({cancelledItems.length})
          </button>
          {showCancelled && (
            <div id="mobile-my-day-cancelled-tasks" className="divide-y divide-[var(--border-subtle)]">
              {cancelledItems.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => onSelectTask(item.taskId)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-[var(--text-secondary)] active:bg-[var(--surface-2)]"
                >
                  <CircleDot size={14} className="text-[var(--text-tertiary)]" />
                  {item.title}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      </div>
    </div>
  );
}
