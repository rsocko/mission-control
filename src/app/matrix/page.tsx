'use client';

import { Suspense, useEffect, useRef, type ComponentProps } from 'react';
import { Loader2 } from 'lucide-react';
import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { MatrixScatter } from '@/components/dashboard/matrix/MatrixScatter';
import { TaskViewSwitcher } from '@/components/dashboard/TaskViewSwitcher';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { ShowCompletedToggle } from '@/components/toolbar/ShowCompletedToggle';
import { MobileSheet } from '@/components/ui/MobileSheet';
import { DashboardSkeleton } from '@/components/ui/Skeleton';
import { useDashboardData } from '@/lib/hooks/useDashboardData';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { getMatrixPaginationDecision } from '@/lib/matrix/scales';

export default function MatrixPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <MatrixPageInner />
    </Suspense>
  );
}

function MatrixPageInner() {
  const { state, actions, computed } = useDashboardData({ includeScoreBreakdown: true });
  const lastAutoLoad = useRef({ signature: '', count: -1 });
  const textFilter = useDashboardViewStore((store) => store.textFilter);
  const isMobile = useIsMobile(639);
  const fetchData = actions.fetchData;
  const selectedTaskId = state.selectedTaskId;
  const taskSelection = useTaskSelection({
    selectedTaskId,
    onSelectionChange: (taskId) => {
      actions.setDetailMode('panel');
      actions.setSelectedTaskId(taskId);
    },
  });
  const filterSignature = JSON.stringify([
    state.sourceFilter,
    state.listFilter,
    state.listGroupFilter,
    state.tagFilter,
    state.quickFilter,
    state.projectFilter,
    state.priorityFilter,
    state.statusFilter,
    state.showCompleted,
    textFilter,
  ]);

  useEffect(() => {
    const loadedCount = state.taskResponse.tasks.length;
    const decision = getMatrixPaginationDecision(
      lastAutoLoad.current,
      filterSignature,
      loadedCount,
      state.loading || state.loadingMore || state.refreshing,
      state.taskResponse.hasMore,
    );
    lastAutoLoad.current = decision.cursor;
    if (decision.shouldLoad) {
      void fetchData(true);
    }
  }, [
    fetchData,
    filterSignature,
    state.loading,
    state.loadingMore,
    state.refreshing,
    state.taskResponse.hasMore,
    state.taskResponse.tasks.length,
  ]);

  const closeTaskDetail = () => actions.setSelectedTaskId(null);
  const taskDetailProps: Omit<
    ComponentProps<typeof TaskDetailPanel>,
    'mode' | 'onModeChange' | 'portalDialog' | 'minPanelWidth'
  > | null = selectedTaskId ? {
    taskId: selectedTaskId,
    onClose: closeTaskDetail,
    onUpdate: (fields) => {
      if (fields) actions.patchTaskInList(selectedTaskId, fields);
      else actions.setRefreshTrigger((value) => value + 1);
    },
    onSubtaskCountChange: (done, total) => {
      actions.updateSubtaskCount(selectedTaskId, done, total);
    },
    availableTags: state.allTags,
    isInMyDay: state.myDayTaskIds.has(selectedTaskId),
    onToggleMyDay: () => {
      if (state.myDayTaskIds.has(selectedTaskId)) {
        void actions.removeFromMyDay(selectedTaskId);
      } else {
        void actions.addToMyDay(selectedTaskId);
      }
    },
    sourceLists: state.sourceLists,
    onMoveToList: (listId) => void actions.moveTaskToList(selectedTaskId, listId),
  } : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="hidden sm:flex">
        <DashboardSidebar
          state={state}
          actions={actions}
          sourceHasLists={computed.sourceHasLists}
          getSourceListsForType={computed.getSourceListsForType}
          originHref="/matrix"
          originLabel="Priority Matrix"
          taskFilterContext={computed.taskFilterContext}
        />
      </div>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden p-3 sm:p-6">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Priority Matrix</h1>
            <p className="text-xs text-[var(--text-muted)]">
              Current dashboard filters · {state.taskResponse.total} tasks
            </p>
          </div>
          <div className="flex items-center gap-1">
            <TaskViewSwitcher
              context={computed.taskFilterContext}
              originHref="/matrix"
              originLabel="Priority Matrix"
            />
            <ShowCompletedToggle />
          </div>
        </header>

        <TaskKeywordFilter
          filteredCount={state.taskResponse.total}
          sources={state.enabledSources}
          sourceLists={state.sourceLists}
          tags={state.allTags}
          assignees={state.allAssignees}
          projects={state.projects}
          listGroups={state.listGroups}
        />

        {state.loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
            <Loader2 size={16} className="mr-2 animate-spin" />
            Loading matrix…
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            <MatrixScatter
              tasks={state.taskResponse.tasks}
              projects={state.projects}
              onSelectTask={(task) => taskSelection.toggleTask(task.id)}
            />
            {state.loadingMore && (
              <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-xs text-[var(--text-muted)] shadow-lg">
                <Loader2 size={12} className="animate-spin" />
                Loading all filtered tasks ({state.taskResponse.tasks.length} of {state.taskResponse.total})
              </div>
            )}
            {!state.loadingMore && state.taskResponse.hasMore && (
              <button
                type="button"
                onClick={() => void fetchData(true)}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-xs text-[var(--accent-300)] shadow-lg"
              >
                Load remaining tasks
              </button>
            )}
          </div>
        )}
      </main>

      {taskDetailProps && !isMobile && (
        <div className="hidden min-w-0 shrink sm:flex">
          <TaskDetailPanel
            {...taskDetailProps}
            mode={state.detailMode}
            onModeChange={actions.setDetailMode}
            portalDialog
            minPanelWidth={320}
          />
        </div>
      )}

      <MobileSheet
        isOpen={Boolean(selectedTaskId && isMobile)}
        onClose={closeTaskDetail}
        ariaLabel="Task details"
        height="full"
        className="sm:hidden"
      >
        {taskDetailProps && isMobile && (
          <TaskDetailPanel
            {...taskDetailProps}
            mode="mobile"
          />
        )}
      </MobileSheet>
    </div>
  );
}
