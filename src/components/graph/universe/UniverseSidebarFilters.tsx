'use client';

import { useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { SidebarFilters } from '@/components/sidebar/SidebarFilters';
import { useSidebarExpanded } from '@/lib/hooks/useSidebarExpanded';
import {
  taskFilterContextFromSavedView,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { getLocalToday } from '@/lib/utils/client-date';
import { EMPTY_TASK_RESPONSE, type SourceList } from '@/types/dashboard';
import type { UniverseFilterOptions } from './UniverseTaskFilters';

type ContextPatch = Partial<Omit<TaskFilterContext, 'version'>>;

interface UniverseSidebarFiltersProps {
  context: TaskFilterContext;
  update: (patch: ContextPatch, mode?: 'push' | 'replace') => void;
  setContext: (context: TaskFilterContext, mode?: 'push' | 'replace') => void;
  options: UniverseFilterOptions;
  filteredTaskCount: number | null;
}

export function UniverseSidebarFilters({
  context,
  update,
  setContext,
  options,
  filteredTaskCount,
}: UniverseSidebarFiltersProps) {
  const {
    sidebarExpanded,
    sidebarMode,
    setSidebarExpanded,
    setSidebarMode,
  } = useSidebarExpanded();
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [expandedSourceLists, setExpandedSourceLists] = useState<Set<string>>(new Set());
  const [collapsedListGroups, setCollapsedListGroups] = useState<Set<string>>(new Set());
  const [listSearch, setListSearch] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [hiddenQuickFilters, setHiddenQuickFilters] = useState<string[]>([]);

  const sourceFilter = context.sources.length === 1 ? context.sources[0] : null;
  const selectedSourceRef = useRef(sourceFilter);
  useEffect(() => {
    selectedSourceRef.current = sourceFilter;
  }, [sourceFilter]);
  const selectedList = findSelectedList(options.sourceLists, context.listIds[0]);
  const allSourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const list of options.sourceLists) {
      if (!list.connectorType) continue;
      counts[list.connectorType] = (counts[list.connectorType] ?? 0) + list.taskCount;
    }
    return counts;
  }, [options.sourceLists]);
  const taskResponse = useMemo(() => ({
    ...EMPTY_TASK_RESPONSE,
    total: filteredTaskCount ?? 0,
    stats: {
      ...EMPTY_TASK_RESPONSE.stats,
      totalOpen: filteredTaskCount ?? 0,
    },
  }), [filteredTaskCount]);

  const resolveArrayUpdate = (
    action: SetStateAction<string[]>,
    current: string[],
  ): string[] => typeof action === 'function' ? action(current) : action;

  return (
    <div className="relative hidden shrink-0 sm:flex">
      <SidebarFilters
      taskResponse={taskResponse}
      enabledSources={options.sources}
      sourceLists={options.sourceLists}
      listGroups={options.listGroups}
      syncStatus={[]}
      allTags={options.tags}
      projects={options.projects}
      savedViews={options.savedViews}
      allSourceCounts={allSourceCounts}
      sourceFilter={sourceFilter}
      listFilter={selectedList?.sourceId ?? null}
      listGroupFilter={context.listGroupId}
      tagFilter={context.tagSlugs}
      quickFilter={context.quickFilter}
      projectFilter={context.projectId}
      priorityFilter={context.priorities}
      statusFilter={context.statuses}
      sidebarExpanded={sidebarExpanded}
      sidebarMode={sidebarMode}
      collapsedSections={collapsedSections}
      expandedSourceLists={expandedSourceLists}
      collapsedListGroups={collapsedListGroups}
      listSearch={listSearch}
      tagSearch={tagSearch}
      tagsExpanded={tagsExpanded}
      isSyncing={false}
      setSourceFilter={(value) => {
        const sourceChanged = value !== selectedSourceRef.current;
        selectedSourceRef.current = value;
        update({
          sources: value ? [value] : [],
          ...(sourceChanged || !value ? { listIds: [], listGroupId: null } : {}),
        });
      }}
      setListFilter={(value) => {
        const selectedSource = selectedSourceRef.current;
        const list = value
          ? options.sourceLists.find((candidate) =>
              candidate.sourceId === value
              && (!selectedSource || candidate.connectorType === selectedSource))
          : null;
        update({ listIds: list ? [exactListId(list)] : [] });
      }}
      setListGroupFilter={(value) => update({ listGroupId: value })}
      setTagFilter={(action) => update({
        tagSlugs: resolveArrayUpdate(action, context.tagSlugs),
      })}
      setQuickFilter={(value) => update({
        quickFilter: value,
        myDayDate: value === 'myDay' ? getLocalToday() : null,
        ...(value === 'myDay' ? { completion: 'all' as const } : {}),
      })}
      setProjectFilter={(value) => update({ projectId: value })}
      setPriorityFilter={(action) => update({
        priorities: resolveArrayUpdate(action, context.priorities),
      })}
      setStatusFilter={(action) => update({
        statuses: resolveArrayUpdate(action, context.statuses),
      })}
      setSidebarExpanded={setSidebarExpanded}
      setSidebarMode={setSidebarMode}
      toggleSection={(section) => setCollapsedSections((current) => {
        const next = new Set(current);
        if (next.has(section)) next.delete(section);
        else next.add(section);
        return next;
      })}
      setExpandedSourceLists={setExpandedSourceLists}
      setCollapsedListGroups={setCollapsedListGroups}
      setListSearch={setListSearch}
      setTagSearch={setTagSearch}
      setTagsExpanded={setTagsExpanded}
      applyView={(view) => setContext(
        view.filterContext ?? taskFilterContextFromSavedView(view.filters),
        'push',
      )}
      hiddenQuickFilters={hiddenQuickFilters}
      toggleQuickFilterVisibility={(filterId) => setHiddenQuickFilters((current) =>
        current.includes(filterId)
          ? current.filter((id) => id !== filterId)
          : [...current, filterId])}
      sourceHasLists={(sourceType) => options.sourceLists.some(
        (list) => list.connectorType === sourceType,
      )}
      getSourceListsForType={(sourceType) => options.sourceLists.filter(
        (list) => list.connectorType === sourceType,
      )}
      />
      {options.loading ? (
        <div
          role="status"
          className="absolute inset-x-2 top-2 z-10 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text-secondary)] shadow"
        >
          Loading filter choices…
        </div>
      ) : null}
      {options.error ? (
        <div
          role="alert"
          className="absolute inset-x-2 top-2 z-10 rounded-md border border-red-500/30 bg-red-950 px-2 py-1.5 text-xs text-red-200 shadow"
        >
          <span>{options.error}</span>
          <button
            type="button"
            onClick={options.retry}
            className="ml-2 font-semibold underline"
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

function findSelectedList(
  lists: Array<SourceList & { connectorType?: string }>,
  selectedId: string | undefined,
) {
  if (!selectedId) return undefined;
  return lists.find((list) =>
    exactListId(list) === selectedId || list.sourceId === selectedId);
}

function exactListId(list: SourceList): string {
  return `${list.connectorInstanceId}:${list.sourceId}`;
}
