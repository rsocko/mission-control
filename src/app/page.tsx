'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Image from 'next/image';
import { Check, Loader2, FolderOpen, Sun, Trash2, List } from 'lucide-react';
import { IconRenderer } from '@/components/ui/icon-picker';
import { toast } from 'sonner';
import { pushUndoWithToast } from '@/lib/stores/undoStore';
import { TaskDetailPanel, type TaskNotesOpenRequest } from '@/components/task-detail/TaskDetailPanel';
import { TaskContextMenu } from '@/components/task-list/TaskContextMenu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { OneThingBanner } from '@/components/OneThingBanner';
import { ShowCompletedToggle } from '@/components/toolbar/ShowCompletedToggle';
import { GroupByDropdown } from '@/components/toolbar/GroupByDropdown';
import { SortDropdown } from '@/components/toolbar/SortDropdown';
import { ViewDensityToggle } from '@/components/toolbar/ViewDensityToggle';
import { RecentWins } from '@/components/RecentWins';
import { RoutineSnapshotWidget } from '@/components/routines/RoutineSnapshotWidget';
import { TriageQueueWidget } from '@/components/triage/TriageQueueWidget';
import { KpiBar } from '@/components/kpi/KpiBar';
import { InsightsBackLink } from '@/components/insights/InsightsBackLink';
import { extractRecurrenceFromMetadata } from '@/lib/utils/recurrence';
import { BulkDispositionButtons, BulkMoveDropdown, BulkMoveToSourceButton, BulkDueDateDropdown, BulkTagDropdown, BulkPriorityDropdown, BulkStatusDropdown, executeBulkOperation, resolveSelectionAnchorIndex } from '@/components/bulk-actions';
import { AddTaskModal, SaveTemplateModal } from '@/components/add-task';
import { CONNECTOR_ICONS, PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS, STATUS_LABELS } from '@/types/dashboard';
import { getTagPillStyle } from '@/lib/constants/colors';
import {
  selectedTaskFieldBlockedReason,
  selectedTaskRemovalBlockedReason,
} from '@/lib/tasks/client-edit-policy';

import { useDashboardData } from '@/lib/hooks/useDashboardData';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';
import { useTaskListVirtualization } from '@/lib/hooks/useTaskListVirtualization';
import { useVirtualFlip } from '@/lib/hooks/useVirtualFlip';
import { TaskRow } from '@/components/task-list/TaskRow';
import { NotificationsPanel, CollapsedNotificationsRail } from '@/components/notifications';
import { useNotifications } from '@/lib/hooks/useNotifications';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { TaskViewSwitcher } from '@/components/dashboard/TaskViewSwitcher';
import { DashboardSkeleton, TaskRowSkeleton } from '@/components/ui/Skeleton';
import { useDashboardSections } from '@/lib/hooks/useDashboardSections';
import { useTaskContextMenuActionFactory } from '@/lib/hooks/useTaskContextMenuActionFactory';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import dynamic from 'next/dynamic';
import Link from 'next/link';

const MobileDashboard = dynamic(
  () => import('@/components/dashboard/mobile/MobileDashboard').then(mod => mod.MobileDashboard),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-4 animate-pulse px-1">
        <div className="h-8 w-40 rounded-lg bg-[var(--surface-2)]" />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-[var(--surface-1)] border border-[var(--border)]" />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 rounded-xl bg-[var(--surface-1)] border border-[var(--border)]" />
          ))}
        </div>
      </div>
    ),
  },
);

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardPageInner />
    </Suspense>
  );
}

function DashboardPageInner() {
  const { state, actions, computed } = useDashboardData();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const { toggleSection, isCollapsed } = useDashboardSections();
  const notificationsHook = useNotifications();
  const textFilter = useDashboardViewStore((s) => s.textFilter);
  const [pendingMoveDialogTaskId, setPendingMoveDialogTaskId] = useState<string | null>(null);
  const [notesOpenRequest, setNotesOpenRequest] = useState<TaskNotesOpenRequest | null>(null);
  const getTaskContextMenuActions = useTaskContextMenuActionFactory({
    complete: actions.completeTask,
    addToMyDay: actions.addToMyDay,
    removeFromMyDay: actions.removeFromMyDay,
    setPriority: actions.setTaskPriority,
    setStatus: actions.setTaskStatus,
    setDueDate: actions.setTaskDueDate,
    setLocalDisposition: actions.setTaskLocalDisposition,
    moveToList: actions.moveTaskToList,
    moveToSource: (taskId) => {
      setPendingMoveDialogTaskId(taskId);
      actions.setSelectedTaskId(taskId);
    },
    addToProject: actions.addTaskToProject,
    deleteTask: actions.deleteTask,
    saveAsTemplate: actions.setSaveTemplateTask,
  });
  const taskSelection = useTaskSelection({
    selectedTaskId: state.selectedTaskId,
    onSelectionChange: (taskId) => {
      setNotesOpenRequest(null);
      actions.setDetailMode('panel');
      actions.setSelectedTaskId(taskId);
    },
    onDoubleClick: () => {
      actions.setDetailMode('dialog');
    },
  });

  // Text filter is now handled server-side via the `search` API param.
  // Use the server response directly (no client-side re-filtering needed).
  const filteredTaskResponse = state.taskResponse;

  const { virtualRows, rowVirtualizer, virtualItems } = useTaskListVirtualization({
    taskResponse: filteredTaskResponse,
    groupBy: state.groupBy,
    collapsedGroups: state.collapsedGroups,
    viewDensity: state.viewDensity,
    listRef: computed.listRef,
    groupTotalCounts: state.groupTotalCounts,
  });

  // FLIP animation: track virtual item positions to animate reorders
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const flipItems = useMemo(
    () =>
      virtualItems.map((vi) => {
        const row = virtualRows[vi.index];
        const key =
          row?.type === 'task'
            ? row.task.id
            : row?.type === 'header'
              ? `header-${row.label}`
              : row?.type === 'load-more-group'
                ? `load-more-group-${row.label}`
                : 'load-more';
        return { key, start: vi.start };
      }),
    [virtualItems, virtualRows],
  );
  const { handleTransitionEnd } = useVirtualFlip(flipItems, {
    containerRef: listContainerRef,
  });

  return (
    <>
      {/* Mobile Dashboard (F-83, F-84, F-85) */}
      <div className="sm:hidden px-4 pt-3 pb-2 overflow-y-auto h-full">
        <InsightsBackLink />
        <MobileDashboard />
      </div>

      {/* Desktop Dashboard */}
      <div className="hidden min-w-0 sm:flex h-full">
      <div aria-live="polite" aria-atomic="true" className="sr-only" id="task-announcements" />

      <DashboardSidebar
        state={state}
        actions={actions}
        sourceHasLists={computed.sourceHasLists}
        getSourceListsForType={computed.getSourceListsForType}
        originHref="/"
        originLabel="Dashboard"
        taskFilterContext={computed.taskFilterContext}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-6">
        {/* Dashboard sections: collapsed items flow inline, expanded take full width */}
        <div className="flex flex-wrap gap-2 mb-4 items-start">
          <div className={isCollapsed('one-thing') ? 'flex-shrink-0' : 'w-full'}>
            <OneThingBanner
              onTaskClick={taskSelection.toggleTask}
              onRefresh={() => actions.setRefreshTrigger((n) => n + 1)}
              collapsed={isCollapsed('one-thing')}
              onToggleCollapse={() => toggleSection('one-thing')}
            />
          </div>

          <div className={isCollapsed('kpis') ? 'flex-shrink-0' : 'w-full'}>
            <KpiBar
              quickFilter={state.quickFilter}
              onFilterClick={actions.setQuickFilter}
              unreadNotificationsCount={notificationsHook.stats.unread}
              collapsed={isCollapsed('kpis')}
              onToggleCollapse={() => toggleSection('kpis')}
            />
          </div>

          <div className={isCollapsed('recent-wins') ? 'flex-shrink-0' : 'w-full'}>
            <RecentWins
              onTaskClick={taskSelection.toggleTask}
              collapsed={isCollapsed('recent-wins')}
              onToggleCollapse={() => toggleSection('recent-wins')}
            />
          </div>

          <div className={isCollapsed('routines') ? 'flex-shrink-0' : 'w-full'}>
            <RoutineSnapshotWidget
              collapsed={isCollapsed('routines')}
              onToggleCollapse={() => toggleSection('routines')}
            />
          </div>

          <div className={isCollapsed('triage-queue') ? 'flex-shrink-0' : 'w-full'}>
            <TriageQueueWidget
              collapsed={isCollapsed('triage-queue')}
              onToggleCollapse={() => toggleSection('triage-queue')}
            />
          </div>
        </div>

        <InsightsBackLink />

        {/* Unified applied-filter input */}
        <TaskKeywordFilter
          filteredCount={filteredTaskResponse.total}
          sources={state.enabledSources}
          sourceLists={state.sourceLists}
          tags={state.allTags}
          assignees={state.allAssignees}
          projects={state.projects}
          listGroups={state.listGroups}
          onSaveView={() => actions.setSavingView(true)}
        />
        {state.savingView && (
          <div className="mb-4 p-2 bg-blue-900/30 border border-blue-800/30 rounded-md max-w-sm">
            <input
              type="text"
              value={state.viewName}
              onChange={(e) => actions.setViewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') actions.saveCurrentView(); if (e.key === 'Escape') actions.setSavingView(false); }}
              placeholder="View name..."
              className="w-full text-xs bg-[var(--surface-1)] border border-[var(--border)] rounded px-2 py-1 mb-1.5 outline-none focus:border-blue-400"
              autoFocus
            />
            <div className="flex gap-1">
              <button onClick={actions.saveCurrentView} className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded font-medium">Save</button>
              <button onClick={() => actions.setSavingView(false)} className="text-xs text-[var(--text-tertiary)] px-2 py-0.5">Cancel</button>
            </div>
          </div>
        )}

        <div className={`flex min-h-0 flex-col bg-[var(--surface-1)] rounded-lg border border-[var(--border)] ${
          state.loading || filteredTaskResponse.total > 0 ? 'flex-1' : 'flex-none'
        }`}>
          {/* Task list header */}
          <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
            <h2 className="font-semibold text-[var(--text-primary)] flex-shrink-0">
              {state.sourceFilter || state.projectFilter || state.tagFilter.length > 0 || state.quickFilter || state.priorityFilter.length > 0 || state.statusFilter.length > 0 || textFilter ? 'Filtered Tasks' : 'All Tasks'}
              <span className="text-sm font-normal text-[var(--text-muted)] ml-2">({filteredTaskResponse.total})</span>
            </h2>
            <div className="flex items-center gap-1 flex-shrink-0">
              <TaskViewSwitcher
                context={computed.taskFilterContext}
                originHref="/"
                originLabel="Dashboard"
              />
              <ShowCompletedToggle />
              <ViewDensityToggle />
              <GroupByDropdown />
              <SortDropdown />
            </div>
            <button onClick={() => {
              if (state.listFilter || state.sourceFilter) {
                const listInfo = state.listFilter
                  ? state.sourceLists.find(sl => sl.sourceId === state.listFilter)
                  : null;
                const connType = listInfo
                  ? (state.syncStatus.find(s => s.id === listInfo.connectorInstanceId)?.type || state.sourceFilter)
                  : state.sourceFilter;
                if (connType) {
                  const sourceDest = state.addTaskDestinations.find(d => d.connectorType === connType);
                  if (sourceDest) {
                    actions.setAddTaskInitialDest(sourceDest);
                    actions.setAddTaskInitialListId(state.listFilter || undefined);
                    actions.setShowAddTaskModal(true);
                    return;
                  }
                }
              }
              actions.setAddTaskInitialDest(state.addTaskDestinations[0]);
              actions.setAddTaskInitialListId(undefined);
              actions.setShowAddTaskModal(true);
            }} className="text-xs text-[var(--accent-400)] hover:text-[var(--accent-300)] font-medium px-2 py-1 flex-shrink-0">
              + Add Task
            </button>
          </div>

          {/* Bulk Action Bar */}
          {state.bulkMode && (
            <BulkActionBarSection state={state} actions={actions} />
          )}

          {state.refreshing && (
            <div className="h-0.5 w-full bg-[var(--surface-2)] overflow-hidden">
              <div className="refresh-progress-indicator h-full w-1/3 rounded-full bg-[var(--accent)]" />
            </div>
          )}

          {state.loading ? (
            <div role="status" aria-busy="true" aria-label="Loading tasks">
              <span className="sr-only">Loading tasks...</span>
              {Array.from({ length: 8 }).map((_, i) => (
                <TaskRowSkeleton key={i} />
              ))}
            </div>
          ) : filteredTaskResponse.total === 0 ? (
            <div className="p-5 text-center text-[var(--text-muted)]">
              <p className="mb-1 text-base font-medium text-[var(--text-secondary)]">No tasks found</p>
              {state.sourceFilter || state.listFilter || state.listGroupFilter || state.tagFilter.length > 0 || state.quickFilter || state.projectFilter || state.priorityFilter.length > 0 || state.statusFilter.length > 0 || textFilter ? (
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm">{textFilter ? `No tasks match "${textFilter}"` : 'No tasks match these filters'}</p>
                  <div className="flex items-center gap-2 flex-wrap justify-center">
                    {state.sourceFilter && (
                      <span className="bg-blue-900/30 text-blue-300 px-2 py-0.5 rounded-full text-xs border border-blue-800/40 flex items-center gap-1">
                        {CONNECTOR_ICONS[state.sourceFilter] && <Image src={CONNECTOR_ICONS[state.sourceFilter]} alt="" width={10} height={10} />}
                        {state.sourceFilter}
                        <button onClick={() => { actions.setSourceFilter(null); actions.setListFilter(null); actions.setListGroupFilter(null); }} className="ml-1 hover:text-white">×</button>
                      </span>
                    )}
                    {state.listGroupFilter && (
                      <span className="bg-emerald-900/30 text-emerald-300 px-2 py-0.5 rounded-full text-xs border border-emerald-800/40 flex items-center gap-1">
                        <FolderOpen size={10} className="inline" />
                        {state.listGroups.find((g) => g.id === state.listGroupFilter)?.name || 'Group'}
                        <button onClick={() => actions.setListGroupFilter(null)} className="ml-1 hover:text-white">×</button>
                      </span>
                    )}
                    {state.listFilter && (() => {
                      const matchedList = state.sourceLists.find((list) => list.sourceId === state.listFilter);
                      return (
                        <span className="bg-slate-800/50 text-slate-200 px-2 py-0.5 rounded-full text-xs border border-slate-600/40 flex items-center gap-1">
                          {matchedList?.icon ? <IconRenderer value={matchedList.icon} size={10} color={matchedList.iconColor || undefined} /> : <List size={10} />}
                          {matchedList?.name || 'List'}
                          <button onClick={() => actions.setListFilter(null)} className="ml-1 hover:text-white">×</button>
                        </span>
                      );
                    })()}
                    {state.priorityFilter.map((p) => (
                      <span key={`priority-${p}`} className={`px-2 py-0.5 rounded-full text-xs border flex items-center gap-1 ${PRIORITY_COLORS[p] || ''}`}>
                        {PRIORITY_LABELS[p] !== '—' ? `${PRIORITY_LABELS[p]} ${p}` : 'No priority'}
                        <button onClick={() => actions.setPriorityFilter((prev) => prev.filter((x) => x !== p))} className="ml-1 hover:text-white">×</button>
                      </span>
                    ))}
                    {state.statusFilter.map((s) => (
                      <span key={`status-${s}`} className={`px-2 py-0.5 rounded-full text-xs border flex items-center gap-1 ${STATUS_COLORS[s] || ''}`}>
                        {STATUS_LABELS[s] || s}
                        <button onClick={() => actions.setStatusFilter((prev) => prev.filter((x) => x !== s))} className="ml-1 hover:text-white">×</button>
                      </span>
                    ))}
                    {state.tagFilter.map((slug) => {
                      const tagColor = state.allTags.find((t) => t.slug === slug)?.color;
                      const pillStyle = getTagPillStyle(tagColor);
                      return (
                        <span key={slug} className="px-2 py-0.5 rounded-full text-xs border border-white/10 flex items-center gap-1" style={pillStyle}>
                          {slug}
                          <button onClick={() => actions.setTagFilter((prev) => prev.filter((t) => t !== slug))} className="ml-1 hover:text-white">×</button>
                        </span>
                      );
                    })}
                    {state.quickFilter && (
                      <span className="bg-amber-900/30 text-amber-300 px-2 py-0.5 rounded-full text-xs border border-amber-800/40 flex items-center gap-1">
                        {state.quickFilter}
                        <button onClick={() => actions.setQuickFilter(null)} className="ml-1 hover:text-white">×</button>
                      </span>
                    )}
                    {state.projectFilter && (
                      <span className="bg-green-900/30 text-green-700 px-2 py-0.5 rounded-full text-xs border border-green-200 flex items-center gap-1">
                        {state.projects.find((project) => project.id === state.projectFilter)?.name}
                        <button onClick={() => actions.setProjectFilter(null)} className="ml-1 hover:text-white">×</button>
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => { actions.setSourceFilter(null); actions.setListFilter(null); actions.setListGroupFilter(null); actions.setTagFilter([]); actions.setQuickFilter(null); actions.setProjectFilter(null); actions.setPriorityFilter([]); actions.setStatusFilter([]); }}
                    className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  >
                    Clear all filters
                  </button>
                </div>
              ) : (
                <p className="text-sm">
                  Configure a connector in <Link href="/settings" className="text-blue-400 hover:underline">Settings</Link> to start syncing tasks.
                </p>
              )}
            </div>
          ) : (
            <div ref={computed.listRef} className="min-h-0 flex-1 overflow-y-auto relative">
              {/* Exit animation overlay */}
              <AnimatePresence>
                {state.exitingTasks.map((exitTask) => (
                  <motion.div
                    key={`exit-${exitTask.id}`}
                    initial={{ opacity: 1, x: 0, height: 'auto' }}
                    animate={{ opacity: 0, x: 20, height: 0 }}
                    transition={{
                      opacity: { duration: 0.25, ease: 'easeOut' },
                      x: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] },
                      height: { duration: 0.2, delay: 0.15, ease: [0.25, 0.1, 0.25, 1] },
                    }}
                    className="absolute left-0 right-0 z-10 pointer-events-none overflow-hidden"
                    style={{ top: exitTask.yOffset }}
                  >
                    <div className={`px-4 py-3 flex items-center gap-3 ${exitTask.reason === 'complete' ? 'bg-green-900/10' : 'bg-[var(--surface-1)]/80'}`}>
                      {exitTask.reason === 'complete' ? (
                        <div className="w-5 h-5 rounded-full border-2 border-green-400 bg-green-400 flex items-center justify-center flex-shrink-0">
                          <span className="text-xs text-white"><Check size={10} /></span>
                        </div>
                      ) : (
                        <div className="w-5 h-5 rounded-full border-2 border-[var(--border-strong)] flex-shrink-0" />
                      )}
                      <span className={`text-sm font-medium truncate ${exitTask.reason === 'complete' ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)]'}`}>{exitTask.title}</span>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              <div role="list" aria-label="Task list" className="relative" ref={listContainerRef} onTransitionEnd={handleTransitionEnd} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                {virtualItems.map((virtualItem) => {
                  const row = virtualRows[virtualItem.index];
                  if (!row) return null;

                  if (row.type === 'header') {
                    const isCollapsed = state.collapsedGroups.has(row.label);
                    return (
                      <div
                        key={`header-${row.label}`}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualItem.index}
                        data-flip-key={`header-${row.label}`}
                        className="absolute left-0 top-0 w-full px-4 py-2 bg-[var(--surface-0)] border-b border-[var(--border-subtle)] flex items-center gap-2 cursor-pointer hover:bg-[var(--surface-1)] transition-colors duration-75 select-none"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                        onClick={() => {
                          actions.setCollapsedGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.label)) next.delete(row.label);
                            else next.add(row.label);
                            return next;
                          });
                        }}
                      >
                        <span className={`text-xs text-[var(--text-muted)] transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                        <span className="text-sm font-bold text-[var(--accent-400)] uppercase tracking-wide">{row.label}</span>
                        <span className="text-xs text-[var(--text-muted)]">
                          ({row.totalCount && row.totalCount > row.count
                            ? `${row.count} of ${row.totalCount}`
                            : row.count})
                        </span>
                      </div>
                    );
                  }

                  if (row.type === 'load-more-group') {
                    const isLoadingGroup = state.loadingMoreGroups.has(row.label);
                    return (
                      <div
                        key={`load-more-group-${row.label}`}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualItem.index}
                        className="absolute left-0 top-0 w-full flex items-center px-4 py-2"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        <button
                          onClick={(e) => { e.stopPropagation(); void actions.loadMoreForGroup(row.label); }}
                          disabled={isLoadingGroup}
                          className="inline-flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-0)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition-[background-color,color,border-color] duration-150 hover:bg-[var(--surface-1)] hover:text-[var(--text-secondary)] hover:border-[var(--border)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isLoadingGroup ? <Loader2 size={12} className="animate-spin" /> : null}
                          {isLoadingGroup ? 'Loading…' : `Load more (${row.remaining} remaining)`}
                        </button>
                      </div>
                    );
                  }

                  if (row.type === 'load-more') {
                    return (
                      <div
                        key="load-more"
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualItem.index}
                        className="absolute left-0 top-0 w-full flex items-center justify-center px-4 py-4 border-t border-[var(--border-subtle)]"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        <button
                          onClick={() => void actions.fetchData(true)}
                          disabled={state.loadingMore}
                          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-[background-color,color,border-color,transform] duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {state.loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}
                          {state.loadingMore ? 'Loading…' : `Load More (${state.taskResponse.total - state.taskResponse.tasks.length} remaining)`}
                        </button>
                      </div>
                    );
                  }

                  const task = row.task;
                  const taskRecurrence = extractRecurrenceFromMetadata(task.metadata);
                  return (
                    <TaskContextMenu
                      key={task.id}
                      task={{ ...task, recurrence: taskRecurrence }}
                      sourceLists={state.sourceLists}
                      listGroups={state.listGroups}
                      projects={state.projects}
                      taskProjectIds={task.hubProjectIds}
                      taskProjectPhaseMemberships={task.projectPhaseMemberships}
                      isInMyDay={state.myDayTaskIds.has(task.id)}
                      actions={getTaskContextMenuActions({
                        id: task.id,
                        title: task.title,
                        dueDate: task.dueDate,
                        metadata: task.metadata,
                        isInMyDay: state.myDayTaskIds.has(task.id),
                      })}
                    >
                    <div
                      role="listitem"
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualItem.index}
                      data-task-id={task.id}
                      data-flip-key={task.id}
                      className={`absolute left-0 top-0 w-full ${state.bulkMode ? 'select-none' : ''}`}
                      key={task.id}
                      style={{ transform: `translateY(${virtualItem.start}px)` }}
                      onMouseDown={(e) => {
                        if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
                      }}
                      onClick={(e) => {
                        taskSelection.cancelPendingDeselect();
                        if (e.shiftKey) {
                          e.preventDefault();
                          const enteringBulk = !state.bulkMode;
                          if (enteringBulk) actions.setBulkMode(true);
                          const currentIndex = virtualItem.index;
                          const lastIndex = resolveSelectionAnchorIndex(
                            virtualRows.map((row) => row.type === 'task' ? row.task.id : null),
                            computed.lastClickedIndexRef.current,
                            enteringBulk ? state.selectedTaskId : null,
                          );
                          if (lastIndex !== null && lastIndex !== currentIndex) {
                            const start = Math.min(lastIndex, currentIndex);
                            const end = Math.max(lastIndex, currentIndex);
                            actions.setBulkSelected((prev) => {
                              const next = new Set(prev);
                              if (enteringBulk && state.selectedTaskId) next.add(state.selectedTaskId);
                              for (let i = start; i <= end; i++) {
                                const r = virtualRows[i];
                                if (r && r.type === 'task') next.add(r.task.id);
                              }
                              return next;
                            });
                          } else {
                            actions.setBulkSelected((prev) => {
                              const next = new Set(prev);
                              if (enteringBulk && state.selectedTaskId) next.add(state.selectedTaskId);
                              next.add(task.id);
                              return next;
                            });
                          }
                          computed.lastClickedIndexRef.current = currentIndex;
                        } else if (e.ctrlKey || e.metaKey) {
                          e.preventDefault();
                          const enteringBulk = !state.bulkMode;
                          if (enteringBulk) actions.setBulkMode(true);
                          actions.setBulkSelected((prev) => {
                            const next = new Set(prev);
                            if (enteringBulk && state.selectedTaskId) next.add(state.selectedTaskId);
                            if (next.has(task.id)) next.delete(task.id);
                            else next.add(task.id);
                            return next;
                          });
                          computed.lastClickedIndexRef.current = virtualItem.index;
                        } else if (state.bulkMode) {
                          computed.lastClickedIndexRef.current = virtualItem.index;
                        } else {
                          taskSelection.handleTaskClick(task.id);
                        }
                      }}
                      onDoubleClick={(e) => {
                        if (!state.bulkMode) {
                          e.stopPropagation();
                          taskSelection.handleTaskDoubleClick(task.id);
                        }
                      }}
                    >
                      <TaskRow
                        task={task}
                        projects={state.projects}
                        onComplete={() => actions.completeTask(task.id)}
                        onSnoozeUntil={(until) => actions.snoozeTask(task.id, until)}
                        onSetDueDate={(date) => actions.setTaskDueDate(task.id, date)}
                        onSetPriority={(priority) => actions.setTaskPriority(task.id, priority)}
                        onSetStatus={(status) => actions.setTaskStatus(task.id, status)}
                        onSetLocalDisposition={(disposition) =>
                          actions.setTaskLocalDisposition(task.id, disposition)}
                        onOpenNotes={(mode) => {
                          actions.setSelectedTaskId(task.id);
                          setNotesOpenRequest((current) => ({
                            requestId: (current?.requestId ?? 0) + 1,
                            taskId: task.id,
                            mode,
                          }));
                        }}
                        onAddToMyDay={() => actions.addToMyDay(task.id)}
                        onRemoveFromMyDay={() => actions.removeFromMyDay(task.id)}
                        isInMyDay={state.myDayTaskIds.has(task.id)}
                        hideSourceListName={!!state.listFilter || state.groupBy === 'list'}
                        showDivider={virtualItem.index < virtualRows.length - 1}
                        compact={state.viewDensity === 'compact'}
                        bulkMode={state.bulkMode}
                        bulkSelected={state.bulkSelected.has(task.id)}
                        isCompleting={state.completingIds.has(task.id)}
                        isSelected={state.selectedTaskId === task.id}
                        onBulkToggle={() => {
                          actions.setBulkSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(task.id)) next.delete(task.id);
                            else next.add(task.id);
                            return next;
                          });
                        }}
                      />
                    </div>
                    </TaskContextMenu>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Notifications stay mounted behind task details so their state is preserved. */}
      <div className="relative flex h-full flex-shrink-0">
        <div
          className={state.selectedTaskId ? 'invisible absolute inset-y-0 right-0 flex h-full' : 'flex h-full'}
          aria-hidden={state.selectedTaskId ? true : undefined}
          inert={state.selectedTaskId ? true : undefined}
        >
          {notificationsHook.panelVisible && (notificationsHook.isLoading || notificationsHook.stats.total > 0 || notificationsHook.error) ? (
            <NotificationsPanel hook={notificationsHook} />
          ) : (
            <CollapsedNotificationsRail
              attentionCount={notificationsHook.stats.attention}
              urgentCount={notificationsHook.stats.urgent}
              actionCount={notificationsHook.stats.actionNeeded}
              headsUpCount={notificationsHook.stats.headsUp}
              fyiCount={notificationsHook.stats.fyi}
              onExpand={notificationsHook.togglePanel}
            />
          )}
        </div>

        <AnimatePresence initial={false} mode="popLayout">
          {state.selectedTaskId && (
          <motion.div
            key="detail-panel"
            className="relative z-20 flex h-full min-w-0 shrink"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0.35, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0.35, x: '100%' }}
            transition={{ duration: prefersReducedMotion ? 0.14 : 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <TaskDetailPanel
              taskId={state.selectedTaskId}
              onClose={() => {
                actions.setSelectedTaskId(null);
                setPendingMoveDialogTaskId(null);
                setNotesOpenRequest(null);
              }}
              onUpdate={(fields) => {
                if (fields && state.selectedTaskId) {
                  actions.patchTaskInList(state.selectedTaskId, fields);
                }
                actions.fetchData(false, true, true);
              }}
              onSubtaskCountChange={(done, total) => actions.updateSubtaskCount(state.selectedTaskId!, done, total)}
              availableTags={state.taskResponse.availableTags}
              mode={state.detailMode}
              onModeChange={actions.setDetailMode}
              isInMyDay={state.myDayTaskIds.has(state.selectedTaskId)}
              onToggleMyDay={() => state.myDayTaskIds.has(state.selectedTaskId!) ? actions.removeFromMyDay(state.selectedTaskId!) : actions.addToMyDay(state.selectedTaskId!)}
              sourceLists={state.sourceLists}
              onMoveToList={(targetListId) => actions.moveTaskToList(state.selectedTaskId!, targetListId)}
              autoOpenMoveDialog={pendingMoveDialogTaskId === state.selectedTaskId}
              onMoveDialogDismissed={() => setPendingMoveDialogTaskId(null)}
              animatePanel={false}
              portalDialog
              minPanelWidth={320}
              notesOpenRequest={notesOpenRequest}
            />
          </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {state.showAddTaskModal && (
          <AddTaskModal
            initialInput=""
            initialParsed={null}
            initialDestination={state.addTaskInitialDest || state.addTaskDestinations[0]}
            destinations={state.addTaskDestinations}
            initialListId={state.addTaskInitialListId}
            initialProjectId={state.projectFilter || undefined}
            onTaskCreated={() => { void actions.fetchData(false, true); }}
            onClose={() => actions.setShowAddTaskModal(false)}
            onSubmit={() => actions.setShowAddTaskModal(false)}
          />
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={state.confirmDialog.open}
        title={state.confirmDialog.title}
        message={state.confirmDialog.message}
        confirmLabel={state.confirmDialog.confirmLabel}
        confirmVariant={state.confirmDialog.variant}
        onConfirm={state.confirmDialog.onConfirm}
        onCancel={() => actions.setConfirmDialog((d) => ({ ...d, open: false }))}
      />

      {state.saveTemplateTask && (
        <SaveTemplateModal
          tasks={[state.saveTemplateTask]}
          onClose={() => actions.setSaveTemplateTask(null)}
          onSaved={() => { actions.setSaveTemplateTask(null); toast.success('Template saved'); }}
        />
      )}
    </div>
    </>
  );
}

// ─── Sub-sections to keep the main component readable ─────────────────────

function BulkActionBarSection({ state, actions }: { state: ReturnType<typeof useDashboardData>['state']; actions: ReturnType<typeof useDashboardData>['actions'] }) {
  const selectedTasks = state.taskResponse.tasks.filter((task) => state.bulkSelected.has(task.id));
  const policies = selectedTasks.map((task) => task.editPolicy);
  const statusBlockedReason = selectedTaskFieldBlockedReason(policies, 'status');
  const priorityBlockedReason = selectedTaskFieldBlockedReason(policies, 'priority');
  const dueDateBlockedReason = selectedTaskFieldBlockedReason(policies, 'dueDate');
  const tagsBlockedReason = selectedTaskFieldBlockedReason(policies, 'tags');
  const moveBlockedReason = selectedTasks.find((task) => !task.editPolicy.sourceMoveSupported)?.editPolicy.sourceMoveReason;
  const removalBlockedReason = selectedTaskRemovalBlockedReason(policies);
  const updateBulkSelection = (failedIds: string[]) => {
    actions.setBulkSelected(new Set(failedIds));
    if (failedIds.length === 0) actions.setBulkMode(false);
  };
  const refreshBulkTasks = () => {
    actions.setRefreshTrigger((count) => count + 1);
  };

  return (
    <div className="px-4 py-2 border-b border-[var(--border-subtle)] bg-blue-900/20 flex items-center gap-2 flex-wrap">
      <span className="text-xs font-medium text-blue-300">{state.bulkSelected.size} selected</span>
      <button
        onClick={() => {
          const count = state.bulkSelected.size;
          actions.setConfirmDialog({
            open: true,
            title: `Complete ${count} task${count > 1 ? 's' : ''}?`,
            message: `This will mark ${count} task${count > 1 ? 's' : ''} as completed.`,
            confirmLabel: 'Complete All',
            variant: 'warning',
            onConfirm: () => {
              actions.setConfirmDialog((d) => ({ ...d, open: false }));
              requestAnimationFrame(async () => {
                const ids = Array.from(state.bulkSelected);
                for (const id of ids) { await actions.completeTask(id); }
                actions.setBulkSelected(new Set());
                actions.setBulkMode(false);
              });
            },
          });
        }}
        disabled={Boolean(statusBlockedReason)}
        title={statusBlockedReason}
        className="text-xs px-2 py-1 bg-green-900/30 text-green-300 border border-green-800/40 rounded-[var(--radius-sm)] hover:bg-green-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Check size={12} className="inline" /> Complete
      </button>
      <BulkStatusDropdown
        disabled={Boolean(statusBlockedReason)}
        disabledReason={statusBlockedReason}
        onSetStatus={async (status) => {
          const ids = Array.from(state.bulkSelected);
          const previousStatuses: Record<string, string> = {};
          for (const id of ids) {
            const task = state.taskResponse.tasks.find(t => t.id === id);
            if (task) previousStatuses[id] = task.status || 'todo';
          }
          await executeBulkOperation(
            ids,
            (id) => fetch(`/api/tasks/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status }),
            }),
            `Status set on ${ids.length} task${ids.length > 1 ? 's' : ''}`,
            {
              onSelectionChange: updateBulkSelection,
              onRefresh: refreshBulkTasks,
              undo: {
                label: `Status set on ${ids.length} task${ids.length > 1 ? 's' : ''}`,
                operation: (id) => fetch(`/api/tasks/${id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: previousStatuses[id] }),
                }),
              },
            },
          );
        }}
      />
      <BulkDispositionButtons
        tasks={selectedTasks}
        onSetDisposition={async (localDisposition) => {
          const ids = Array.from(state.bulkSelected);
          await executeBulkOperation(
            ids,
            (id) => fetch(`/api/tasks/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ localDisposition }),
            }),
            localDisposition === 'handled'
              ? `Marked ${ids.length} task${ids.length > 1 ? 's' : ''} handled in Mission Control`
              : `Dismissed ${ids.length} task${ids.length > 1 ? 's' : ''} in Mission Control`,
            {
              onSelectionChange: updateBulkSelection,
              onRefresh: refreshBulkTasks,
            },
          );
        }}
      />
      <BulkMoveDropdown
        sourceLists={state.sourceLists}
        disabled={Boolean(moveBlockedReason)}
        disabledReason={moveBlockedReason}
        onMove={async (targetListId) => {
          const ids = Array.from(state.bulkSelected);
          const previousListIds: Record<string, string> = {};
          for (const id of ids) {
            const res = await fetch(`/api/tasks/${id}/move-to-list`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ targetListId }),
            });
            if (res.ok) { const data = await res.json(); if (data.previousListId) previousListIds[id] = data.previousListId; }
          }
          const targetList = state.sourceLists.find((l) => l.id === targetListId);
          const moveLabel = `Moved ${ids.length} task${ids.length > 1 ? 's' : ''} to ${targetList?.name || 'list'}`;
          if (Object.keys(previousListIds).length > 0) {
            pushUndoWithToast(moveLabel, async () => {
              for (const [id, prevListId] of Object.entries(previousListIds)) {
                await fetch(`/api/tasks/${id}/move-to-list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetListId: prevListId }) });
              }
              actions.setRefreshTrigger((n) => n + 1);
            });
          } else {
            toast.success(moveLabel);
          }
          actions.setBulkSelected(new Set()); actions.setBulkMode(false); actions.setRefreshTrigger((n) => n + 1);
        }}
      />
      <BulkMoveToSourceButton
        selectedTaskIds={Array.from(state.bulkSelected)}
        onComplete={() => {
          actions.setBulkSelected(new Set()); actions.setBulkMode(false); actions.setRefreshTrigger((n) => n + 1);
        }}
      />
      <BulkDueDateDropdown
        disabled={Boolean(dueDateBlockedReason)}
        disabledReason={dueDateBlockedReason}
        onSetDate={async (date) => {
          const ids = Array.from(state.bulkSelected);
          const previousDates: Record<string, string | null> = {};
          for (const id of ids) {
            const task = state.taskResponse.tasks.find(t => t.id === id);
            if (task) previousDates[id] = task.dueDate || null;
          }
          const label = date ? `Due date set on ${ids.length} task${ids.length > 1 ? 's' : ''}` : `Due date cleared on ${ids.length} task${ids.length > 1 ? 's' : ''}`;
          await executeBulkOperation(
            ids,
            (id) => fetch(`/api/tasks/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dueDate: date || null }),
            }),
            label,
            {
              onSelectionChange: updateBulkSelection,
              onRefresh: refreshBulkTasks,
              undo: {
                label,
                operation: (id) => fetch(`/api/tasks/${id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ dueDate: previousDates[id] }),
                }),
              },
            },
          );
        }}
      />
      <BulkTagDropdown
        availableTags={state.taskResponse.availableTags}
        disabled={Boolean(tagsBlockedReason)}
        disabledReason={tagsBlockedReason}
        onAddTag={async (tagId) => {
          const ids = Array.from(state.bulkSelected);
          const tagName = state.taskResponse.availableTags.find(t => t.id === tagId)?.name;
          const label = `Tagged ${ids.length} task${ids.length > 1 ? 's' : ''}`;
          await executeBulkOperation(
            ids,
            (id) => fetch(`/api/tasks/${id}/tags`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tags: [tagName].filter(Boolean) }),
            }),
            label,
            {
              onSelectionChange: updateBulkSelection,
              onRefresh: refreshBulkTasks,
              undo: {
                label,
                operation: (id) => fetch(`/api/tasks/${id}/tags`, {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tagId }),
                }),
              },
            },
          );
        }}
      />
      <BulkPriorityDropdown
        disabled={Boolean(priorityBlockedReason)}
        disabledReason={priorityBlockedReason}
        onSetPriority={async (priority) => {
          const ids = Array.from(state.bulkSelected);
          const previousPriorities: Record<string, string> = {};
          for (const id of ids) {
            const task = state.taskResponse.tasks.find(t => t.id === id);
            if (task) previousPriorities[id] = task.priority || 'none';
          }
          const label = `Priority set on ${ids.length} task${ids.length > 1 ? 's' : ''}`;
          await executeBulkOperation(
            ids,
            (id) => fetch(`/api/tasks/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ priority }),
            }),
            label,
            {
              onSelectionChange: updateBulkSelection,
              onRefresh: refreshBulkTasks,
              undo: {
                label,
                operation: (id) => fetch(`/api/tasks/${id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ priority: previousPriorities[id] }),
                }),
              },
            },
          );
        }}
      />
      <button
        onClick={async () => {
          const ids = Array.from(state.bulkSelected);
          for (const id of ids) { await actions.addToMyDay(id); }
          toast.success(`Added ${ids.length} task${ids.length > 1 ? 's' : ''} to My Day`);
          actions.setBulkSelected(new Set()); actions.setBulkMode(false);
        }}
        className="text-xs px-2 py-1 bg-amber-900/30 text-amber-300 border border-amber-800/40 rounded-[var(--radius-sm)] hover:bg-amber-900/50 transition-colors duration-100"
      >
        <Sun size={12} className="inline" /> My Day
      </button>
      <button
        onClick={() => {
          const count = state.bulkSelected.size;
          actions.setConfirmDialog({
            open: true,
            title: `Delete ${count} task${count > 1 ? 's' : ''}?`,
            message: 'Each selected task will be deleted locally, cancelled locally, closed, or deleted at its source according to its task policy.',
            confirmLabel: 'Remove tasks',
            variant: 'danger',
            onConfirm: () => {
              actions.setConfirmDialog((d) => ({ ...d, open: false }));
              requestAnimationFrame(() => {
                const ids = Array.from(state.bulkSelected);
                actions.setBulkSelected(new Set()); actions.setBulkMode(false);
                // Optimistically remove tasks from state
                const previousTasks = state.taskResponse.tasks.filter(t => ids.includes(t.id));
                actions.setRefreshTrigger((n) => n + 1);
                // Deferred delete with undo window
                let undone = false;
                pushUndoWithToast(`${ids.length} task${ids.length > 1 ? 's' : ''} deleted`, () => {
                  undone = true;
                  // Restore is handled by refresh since tasks weren't deleted server-side yet
                  actions.setRefreshTrigger((n) => n + 1);
                });
                setTimeout(async () => {
                  if (!undone) {
                    const failedIds: string[] = [];
                    for (const id of ids) {
                      try { const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' }); if (!res.ok) failedIds.push(id); } catch { failedIds.push(id); }
                    }
                    if (failedIds.length > 0) toast.error(`Failed to delete ${failedIds.length} task${failedIds.length > 1 ? 's' : ''}`);
                  }
                  actions.setRefreshTrigger((n) => n + 1);
                }, 5500);
              });
            },
          });
        }}
        disabled={Boolean(removalBlockedReason)}
        title={removalBlockedReason}
        className="text-xs px-2 py-1 bg-red-900/30 text-red-300 border border-red-800/40 rounded-[var(--radius-sm)] hover:bg-red-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 size={12} className="inline" /> Delete
      </button>
      <button
        onClick={() => { actions.setBulkSelected(new Set()); actions.setBulkMode(false); }}
        className="text-xs px-2 py-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors duration-100 ml-auto"
      >
        Cancel
      </button>
    </div>
  );
}
