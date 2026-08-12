'use client';

import { SidebarFilters } from '@/components/sidebar/SidebarFilters';
import { buildTaskCollectionOriginHref } from '@/lib/graph/graph-navigation';
import type { TaskFilterContext } from '@/lib/task-filter-context';
import type {
  DashboardActions,
  DashboardComputed,
  DashboardState,
} from '@/lib/hooks/useDashboardData';

interface DashboardSidebarProps {
  state: DashboardState;
  actions: DashboardActions;
  isSyncing: boolean;
  sourceHasLists: DashboardComputed['sourceHasLists'];
  getSourceListsForType: DashboardComputed['getSourceListsForType'];
  originHref: string;
  originLabel: string;
  taskFilterContext: TaskFilterContext;
}

export function DashboardSidebar({
  state,
  actions,
  isSyncing,
  sourceHasLists,
  getSourceListsForType,
  originHref,
  originLabel,
  taskFilterContext,
}: DashboardSidebarProps) {
  return (
    <SidebarFilters
      taskResponse={state.taskResponse}
      enabledSources={state.enabledSources}
      sourceLists={state.sourceLists}
      listGroups={state.listGroups}
      syncStatus={state.syncStatus}
      allTags={state.allTags}
      projects={state.projects}
      savedViews={state.savedViews}
      allSourceCounts={state.allSourceCounts}
      sourceFilter={state.sourceFilter}
      listFilter={state.listFilter}
      listGroupFilter={state.listGroupFilter}
      tagFilter={state.tagFilter}
      quickFilter={state.quickFilter}
      projectFilter={state.projectFilter}
      priorityFilter={state.priorityFilter}
      statusFilter={state.statusFilter}
      sidebarExpanded={state.sidebarExpanded}
      sidebarMode={state.sidebarMode}
      collapsedSections={state.collapsedSections}
      expandedSourceLists={state.expandedSourceLists}
      collapsedListGroups={state.collapsedListGroups}
      listSearch={state.listSearch}
      tagSearch={state.tagSearch}
      tagsExpanded={state.tagsExpanded}
      isSyncing={isSyncing}
      setSourceFilter={actions.setSourceFilter}
      setListFilter={actions.setListFilter}
      setListGroupFilter={actions.setListGroupFilter}
      setTagFilter={actions.setTagFilter}
      setQuickFilter={actions.setQuickFilter}
      setProjectFilter={actions.setProjectFilter}
      setPriorityFilter={actions.setPriorityFilter}
      setStatusFilter={actions.setStatusFilter}
      setSidebarExpanded={actions.setSidebarExpanded}
      setSidebarMode={actions.setSidebarMode}
      toggleSection={actions.toggleSection}
      setExpandedSourceLists={actions.setExpandedSourceLists}
      setCollapsedListGroups={actions.setCollapsedListGroups}
      setListSearch={actions.setListSearch}
      setTagSearch={actions.setTagSearch}
      setTagsExpanded={actions.setTagsExpanded}
      applyView={actions.applyView}
      deleteView={actions.deleteView}
      hiddenQuickFilters={state.hiddenQuickFilters}
      toggleQuickFilterVisibility={actions.toggleQuickFilterVisibility}
      sourceHasLists={sourceHasLists}
      getSourceListsForType={getSourceListsForType}
      graphOrigin={{
        href: buildTaskCollectionOriginHref(originHref, taskFilterContext),
        label: originLabel,
      }}
    />
  );
}
