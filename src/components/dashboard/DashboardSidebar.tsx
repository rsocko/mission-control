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
  sourceHasLists: DashboardComputed['sourceHasLists'];
  getSourceListsForType: DashboardComputed['getSourceListsForType'];
  originHref: string;
  originLabel: string;
  taskFilterContext: TaskFilterContext;
}

export function DashboardSidebar({
  state,
  actions,
  sourceHasLists,
  getSourceListsForType,
  originHref,
  originLabel,
  taskFilterContext,
}: DashboardSidebarProps) {
  return (
    <SidebarFilters
      data={{
        taskResponse: state.taskResponse,
        enabledSources: state.enabledSources,
        sourceLists: state.sourceLists,
        listGroups: state.listGroups,
        allTags: state.allTags,
        projects: state.projects,
        savedViews: state.savedViews,
        allSourceCounts: state.allSourceCounts,
      }}
      filters={{
        sourceFilter: state.sourceFilter,
        listFilter: state.listFilter,
        listGroupFilter: state.listGroupFilter,
        tagFilter: state.tagFilter,
        quickFilter: state.quickFilter,
        projectFilter: state.projectFilter,
        priorityFilter: state.priorityFilter,
        statusFilter: state.statusFilter,
        hiddenQuickFilters: state.hiddenQuickFilters,
      }}
      sidebar={{
        sidebarExpanded: state.sidebarExpanded,
        sidebarMode: state.sidebarMode,
        collapsedSections: state.collapsedSections,
        expandedSourceLists: state.expandedSourceLists,
        collapsedListGroups: state.collapsedListGroups,
        listSearch: state.listSearch,
        tagSearch: state.tagSearch,
        tagsExpanded: state.tagsExpanded,
      }}
      actions={{
        setSourceFilter: actions.setSourceFilter,
        setListFilter: actions.setListFilter,
        setListGroupFilter: actions.setListGroupFilter,
        setTagFilter: actions.setTagFilter,
        setQuickFilter: actions.setQuickFilter,
        setProjectFilter: actions.setProjectFilter,
        setPriorityFilter: actions.setPriorityFilter,
        setStatusFilter: actions.setStatusFilter,
        setSidebarExpanded: actions.setSidebarExpanded,
        setSidebarMode: actions.setSidebarMode,
        toggleSection: actions.toggleSection,
        setExpandedSourceLists: actions.setExpandedSourceLists,
        setCollapsedListGroups: actions.setCollapsedListGroups,
        setListSearch: actions.setListSearch,
        setTagSearch: actions.setTagSearch,
        setTagsExpanded: actions.setTagsExpanded,
        applyView: actions.applyView,
        deleteView: actions.deleteView,
        toggleQuickFilterVisibility: actions.toggleQuickFilterVisibility,
      }}
      computed={{
        sourceHasLists,
        getSourceListsForType,
        graphOrigin: {
          href: buildTaskCollectionOriginHref(originHref, taskFilterContext),
          label: originLabel,
        },
      }}
    />
  );
}
