'use client';

import React from 'react';
import Image from 'next/image';
import { Check, Globe, CheckCircle2, AlertCircle, PanelLeftClose, PanelLeftOpen, Search, ChevronRight, Sun, RefreshCw, ChevronsUpDown, ChevronsDownUp, FolderOpen, List, Flame, Star, Clock, User, Tag, Bookmark, Sparkles, Settings2, Eye, EyeOff, X, Hourglass, Inbox } from 'lucide-react';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import { IconRenderer } from '@/components/ui/icon-picker';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { formatSyncTime } from '@/lib/utils/dashboard-helpers';
import type { TaskTag, TaskResponse, HubProject, ListGroup, SourceList, EnabledSource, SyncStatusEntry, SavedView } from '@/types/dashboard';
import { CONNECTOR_ICONS, PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS, STATUS_LABELS } from '@/types/dashboard';
import type { SidebarMode } from '@/lib/hooks/useSidebarExpanded';
import { ViewInGraphLink } from '@/components/graph/ViewInGraphLink';
import type { GraphOrigin } from '@/lib/graph/graph-navigation';
import { taskFilterContextFromSavedView } from '@/lib/task-filter-context';
import { SidebarNavItem } from './SidebarNavItem';

const TAG_DEFAULT_COUNT = 10;

function matchesSourceListFilter(sourceList: SourceList, listFilter: string | null): boolean {
  return listFilter === sourceList.sourceId
    || listFilter === `${sourceList.connectorInstanceId}:${sourceList.sourceId}`;
}

interface SidebarFiltersProps {
  // Data
  taskResponse: TaskResponse;
  enabledSources: EnabledSource[];
  sourceLists: SourceList[];
  listGroups: ListGroup[];
  syncStatus: SyncStatusEntry[];
  allTags: TaskTag[];
  projects: HubProject[];
  savedViews: SavedView[];
  allSourceCounts: Record<string, number>;

  // Filter state
  sourceFilter: string | null;
  listFilter: string | null;
  listGroupFilter: string | null;
  tagFilter: string[];
  quickFilter: string | null;
  projectFilter: string | null;
  priorityFilter: string[];
  statusFilter: string[];

  // Sidebar UI state
  sidebarExpanded: boolean;
  sidebarMode: SidebarMode;
  collapsedSections: Set<string>;
  expandedSourceLists: Set<string>;
  collapsedListGroups: Set<string>;
  listSearch: string;
  tagSearch: string;
  tagsExpanded: boolean;
  isSyncing: boolean;

  // Actions
  setSourceFilter: (v: string | null) => void;
  setListFilter: (v: string | null) => void;
  setListGroupFilter: (v: string | null) => void;
  setTagFilter: React.Dispatch<React.SetStateAction<string[]>>;
  setQuickFilter: (v: string | null) => void;
  setProjectFilter: (v: string | null) => void;
  setPriorityFilter: React.Dispatch<React.SetStateAction<string[]>>;
  setStatusFilter: React.Dispatch<React.SetStateAction<string[]>>;
  setSidebarExpanded: (v: boolean) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  toggleSection: (section: string) => void;
  setExpandedSourceLists: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCollapsedListGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  setListSearch: (v: string) => void;
  setTagSearch: (v: string) => void;
  setTagsExpanded: (v: boolean) => void;
  applyView: (view: SavedView) => void;
  deleteView?: (id: string) => void;

  // Quick filter visibility
  hiddenQuickFilters: string[];
  toggleQuickFilterVisibility: (filterId: string) => void;

  // Computed
  sourceHasLists: (sourceType: string) => boolean;
  getSourceListsForType: (sourceType: string) => SourceList[];
  graphOrigin?: GraphOrigin;
}

export function SidebarFilters(props: SidebarFiltersProps) {
  const {
    taskResponse, enabledSources, sourceLists, listGroups, syncStatus, allTags,
    projects, savedViews, allSourceCounts,
    sourceFilter, listFilter, listGroupFilter, tagFilter, quickFilter, projectFilter,
    priorityFilter, statusFilter,
    sidebarExpanded, sidebarMode, collapsedSections, expandedSourceLists, collapsedListGroups,
    listSearch, tagSearch, tagsExpanded, isSyncing,
    setSourceFilter, setListFilter, setListGroupFilter, setTagFilter, setQuickFilter, setProjectFilter,
    setPriorityFilter, setStatusFilter,
    setSidebarExpanded, setSidebarMode, toggleSection, setExpandedSourceLists, setCollapsedListGroups,
    setListSearch, setTagSearch, setTagsExpanded, applyView, deleteView,
    hiddenQuickFilters, toggleQuickFilterVisibility,
    sourceHasLists, getSourceListsForType,
    graphOrigin,
  } = props;

  const [showFilterSettings, setShowFilterSettings] = React.useState(false);
  const selectedSourceList = sourceLists.find(sourceList =>
    matchesSourceListFilter(sourceList, listFilter)
  );

  // Collapsed mini rail: show only icons for quick navigation
  if (sidebarMode === 'collapsed') {
    return (
      <aside
        aria-label="Task filters (collapsed)"
        className="hidden sm:flex w-12 bg-[var(--surface-1)] border-r border-[var(--border)] py-3 flex-col items-center gap-1 flex-shrink-0 transition-[width] duration-200 overflow-hidden"
      >
        {/* Expand button */}
        <button
          onClick={() => setSidebarMode('normal')}
          className="p-2 rounded-[var(--radius-md)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100 mb-2"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen size={16} />
        </button>

        <div className="w-6 h-px bg-[var(--border)] mb-2" />

        {/* Quick filter icons */}
        <button
          onClick={() => setSourceFilter(null)}
          className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
            !sourceFilter ? 'text-[var(--accent)] bg-[var(--accent)]/10' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
          }`}
          title="All Sources"
          aria-label="All Sources"
        >
          <Globe size={16} />
        </button>

        {enabledSources.filter(s => !s.notificationOnly).slice(0, 5).map(src => (
          <button
            key={src.type}
            onClick={() => setSourceFilter(sourceFilter === src.type ? null : src.type)}
            className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
              sourceFilter === src.type ? 'text-[var(--accent)] bg-[var(--accent)]/10' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
            }`}
            title={src.type}
            aria-label={`Filter by ${src.type}`}
          >
            {CONNECTOR_ICONS[src.type] ? (
              <Image src={CONNECTOR_ICONS[src.type]} alt="" width={16} height={16} />
            ) : (
              <Globe size={16} />
            )}
          </button>
        ))}

        <div className="w-6 h-px bg-[var(--border)] my-2" />

        {/* Quick filter shortcuts */}
        <button
          onClick={() => setQuickFilter(quickFilter === 'today' ? null : 'today')}
          className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
            quickFilter === 'today' ? 'text-amber-400 bg-amber-900/30' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
          }`}
          title="Due Today"
          aria-label="Due Today"
        >
          <Sun size={16} />
        </button>
        <button
          onClick={() => setQuickFilter(quickFilter === 'overdue' ? null : 'overdue')}
          className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
            quickFilter === 'overdue' ? 'text-red-400 bg-red-900/30' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
          }`}
          title="Overdue"
          aria-label="Overdue"
        >
          <Flame size={16} />
        </button>
        <button
          onClick={() => setQuickFilter(quickFilter === 'starred' ? null : 'starred')}
          className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
            quickFilter === 'starred' ? 'text-yellow-400 bg-yellow-900/30' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
          }`}
          title="Starred"
          aria-label="Starred"
        >
          <Star size={16} />
        </button>

        {projects.length > 0 && (
          <>
            <div className="w-6 h-px bg-[var(--border)] my-2" />
            <button
              onClick={() => setProjectFilter(null)}
              className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
                !projectFilter ? 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
              }`}
              title="Projects"
              aria-label="Projects"
            >
              <FolderOpen size={16} />
            </button>
          </>
        )}

        {allTags.length > 0 && (
          <>
            <div className="w-6 h-px bg-[var(--border)] my-2" />
            <button
              onClick={() => {}}
              className="p-2 rounded-[var(--radius-md)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
              title="Tags"
              aria-label="Tags"
            >
              <Tag size={16} />
            </button>
          </>
        )}

        {savedViews.length > 0 && (
          <>
            <div className="w-6 h-px bg-[var(--border)] my-2" />
            <button
              onClick={() => {}}
              className="p-2 rounded-[var(--radius-md)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
              title="Saved Views"
              aria-label="Saved Views"
            >
              <Bookmark size={16} />
            </button>
          </>
        )}
      </aside>
    );
  }

  return (
    <aside aria-label="Task filters" className={`hidden sm:flex flex-col ${sidebarExpanded ? 'w-80' : 'w-56'} bg-[var(--surface-1)] border-r border-[var(--border)] p-4 overflow-y-auto overflow-x-hidden flex-shrink-0 transition-[width] duration-200`}>
      {/* Sources Section */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => toggleSection('sources')}
            className="flex-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide hover:text-[var(--text-secondary)] transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('sources') ? '' : 'rotate-90'}`} />
            Sources
            {collapsedSections.has('sources') && sourceFilter && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
            )}
          </button>
          <button
            onClick={() => setSidebarMode(sidebarExpanded ? 'collapsed' : 'expanded')}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
            aria-label={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
            title={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarExpanded ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
          </button>
        </div>
        {!collapsedSections.has('sources') && (
        <div className="space-y-1">
          <SidebarNavItem
            icon={<Globe size={14} className="text-blue-400" />}
            label="All Sources"
            count={Object.keys(allSourceCounts).length > 0
              ? Object.values(allSourceCounts).reduce((sum, c) => sum + c, 0)
              : taskResponse.stats.totalOpen
            }
            active={!sourceFilter}
            onClick={() => { setSourceFilter(null); setListFilter(null); }}
          />
          {enabledSources.filter(s => !s.notificationOnly).map((source) => {
            const hasLists = sourceHasLists(source.type);
            const isListsExpanded = expandedSourceLists.has(source.type);
            const showLists = isListsExpanded;
            const currentSourceLists = showLists ? getSourceListsForType(source.type) : [];
            const hasActiveChildList = sourceFilter === source.type && !!listFilter && !isListsExpanded;
            return (
            <div key={source.type}>
              <SidebarNavItem
                icon={CONNECTOR_ICONS[source.type]
                  ? <Image src={CONNECTOR_ICONS[source.type]} alt={source.name} width={14} height={14} />
                  : <Globe size={14} />
                }
                label={source.name}
                count={allSourceCounts[source.type] || 0}
                active={sourceFilter === source.type}
                suffix={hasActiveChildList ? <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0" /> : undefined}
                onClick={() => {
                  setSourceFilter(source.type);
                  setListFilter(null);
                  setListSearch('');
                  if (hasLists) {
                    setExpandedSourceLists((prev) => {
                      const next = new Set(prev);
                      if (sourceFilter === source.type) {
                        if (next.has(source.type)) next.delete(source.type);
                        else next.add(source.type);
                      } else {
                        next.add(source.type);
                      }
                      return next;
                    });
                  }
                }}
                action={hasLists ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedSourceLists((prev) => {
                        const next = new Set(prev);
                        if (next.has(source.type)) next.delete(source.type);
                        else next.add(source.type);
                        return next;
                      });
                    }}
                    className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100 shrink-0"
                    aria-label={isListsExpanded ? 'Collapse lists' : 'Expand lists'}
                    title={isListsExpanded ? 'Collapse lists' : 'Expand lists'}
                  >
                    {isListsExpanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
                  </button>
                ) : undefined}
              />
              {showLists && currentSourceLists.length > 0 && (
                <SourceListSection
                  source={source}
                  currentSourceLists={currentSourceLists}
                  listGroups={listGroups}
                  listSearch={listSearch}
                  listFilter={listFilter}
                  listGroupFilter={listGroupFilter}
                  collapsedListGroups={collapsedListGroups}
                  sidebarExpanded={sidebarExpanded}
                  setListSearch={setListSearch}
                  setSourceFilter={setSourceFilter}
                  setListFilter={setListFilter}
                  setListGroupFilter={setListGroupFilter}
                  setCollapsedListGroups={setCollapsedListGroups}
                />
              )}
            </div>
            );
          })}
        </div>
        )}
      </div>

      {/* Quick Filters Section */}
      <div className="mb-4">
        <div className="flex items-center gap-1 mb-2">
          <button
            onClick={() => toggleSection('quickFilters')}
            className="flex-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide hover:text-[var(--text-secondary)] transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('quickFilters') ? '' : 'rotate-90'}`} />
            Quick Filters
            {collapsedSections.has('quickFilters') && quickFilter && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
            )}
          </button>
          <button
            onClick={() => setShowFilterSettings(!showFilterSettings)}
            className={`p-0.5 rounded transition-colors ${showFilterSettings ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}
            title="Configure visible filters"
            aria-label="Configure visible filters"
          >
            <Settings2 size={11} />
          </button>
        </div>
        {showFilterSettings && (
          <div className="mb-2 p-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] space-y-1">
            <p className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wide mb-1">Show/Hide Filters</p>
            {[
              { id: 'myDay', label: 'My Day' },
              { id: 'inbox', label: 'Inbox' },
              { id: 'overdue', label: 'Overdue' },
              { id: 'high', label: 'High Priority' },
              { id: 'week', label: 'Due This Week' },
              { id: 'assigned', label: 'Assigned to Me' },
              { id: 'recentlyCreated', label: 'Recently Created' },
              { id: 'recentlyClosed', label: 'Recently Closed' },
              { id: 'waiting', label: 'Waiting / On Hold' },
            ].map(f => (
              <label key={f.id} className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={!hiddenQuickFilters.includes(f.id)}
                  onChange={() => toggleQuickFilterVisibility(f.id)}
                  className="rounded border-[var(--border)] accent-[var(--accent)]"
                />
                {f.label}
              </label>
            ))}
          </div>
        )}
        {!collapsedSections.has('quickFilters') && (
        <div className="space-y-1">
          {!hiddenQuickFilters.includes('myDay') && (
          <SidebarNavItem
            icon={<Sun size={14} className="text-amber-400" />}
            label="My Day"
            count={taskResponse.stats.myDay || 0}
            active={quickFilter === 'myDay'}
            onClick={() => setQuickFilter(quickFilter === 'myDay' ? null : 'myDay')}
          />
          )}
          {!hiddenQuickFilters.includes('inbox') && (
          <SidebarNavItem
            icon={<Inbox size={14} className="text-teal-400" />}
            label="Inbox"
            count={taskResponse.stats.inbox || 0}
            active={quickFilter === 'inbox'}
            onClick={() => setQuickFilter(quickFilter === 'inbox' ? null : 'inbox')}
          />
          )}
          {!hiddenQuickFilters.includes('overdue') && (
          <SidebarNavItem
            icon={<Flame size={14} className="text-red-400" />}
            label="Overdue"
            count={taskResponse.stats.overdue}
            active={quickFilter === 'overdue'}
            onClick={() => setQuickFilter(quickFilter === 'overdue' ? null : 'overdue')}
          />
          )}
          {!hiddenQuickFilters.includes('high') && (
          <SidebarNavItem
            icon={<Star size={14} className="text-amber-400" />}
            label="High Priority"
            count={taskResponse.stats.highPriority}
            active={quickFilter === 'high'}
            onClick={() => setQuickFilter(quickFilter === 'high' ? null : 'high')}
          />
          )}
          {!hiddenQuickFilters.includes('week') && (
          <SidebarNavItem
            icon={<Clock size={14} className="text-blue-400" />}
            label="Due This Week"
            count={taskResponse.stats.dueThisWeek}
            active={quickFilter === 'week'}
            onClick={() => setQuickFilter(quickFilter === 'week' ? null : 'week')}
          />
          )}
          {!hiddenQuickFilters.includes('assigned') && (
          <SidebarNavItem
            icon={<User size={14} className="text-[var(--text-muted)]" />}
            label="Assigned to Me"
            count={taskResponse.stats.assignedToMe}
            active={quickFilter === 'assigned'}
            onClick={() => setQuickFilter(quickFilter === 'assigned' ? null : 'assigned')}
          />
          )}
          {!hiddenQuickFilters.includes('recentlyCreated') && (
          <SidebarNavItem
            icon={<Sparkles size={14} className="text-emerald-400" />}
            label="Recently Created"
            count={taskResponse.stats.recentlyCreated || 0}
            active={quickFilter === 'recentlyCreated'}
            onClick={() => setQuickFilter(quickFilter === 'recentlyCreated' ? null : 'recentlyCreated')}
          />
          )}
          {!hiddenQuickFilters.includes('recentlyClosed') && (
          <SidebarNavItem
            icon={<CheckCircle2 size={14} className="text-violet-400" />}
            label="Recently Closed"
            count={taskResponse.stats.recentlyClosed || 0}
            active={quickFilter === 'recentlyClosed'}
            onClick={() => setQuickFilter(quickFilter === 'recentlyClosed' ? null : 'recentlyClosed')}
          />
          )}
          {!hiddenQuickFilters.includes('waiting') && (
          <SidebarNavItem
            icon={<Hourglass size={14} className="text-orange-400" />}
            label="Waiting / On Hold"
            count={taskResponse.stats.waiting || 0}
            active={quickFilter === 'waiting'}
            onClick={() => setQuickFilter(quickFilter === 'waiting' ? null : 'waiting')}
          />
          )}
        </div>
        )}
      </div>

      {/* Saved Views Section */}
      {savedViews.length > 0 && (
        <div className="mb-4">
          <button
            onClick={() => toggleSection('savedViews')}
            className="w-full flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 hover:text-[var(--text-secondary)] transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('savedViews') ? '' : 'rotate-90'}`} />
            Saved Views
          </button>
          {!collapsedSections.has('savedViews') && (
          <div className="space-y-1">
            {savedViews.map((view) => (
              <div key={view.id} className="flex items-center group">
                <div className="flex-1">
                  <SidebarNavItem
                    icon={view.icon}
                    label={view.name}
                    count={0}
                    onClick={() => applyView(view)}
                    action={graphOrigin ? (
                      <ViewInGraphLink
                        context={view.filterContext ?? taskFilterContextFromSavedView(view.filters)}
                        origin={graphOrigin}
                        collectionLabel={view.name}
                        compact
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                      />
                    ) : undefined}
                  />
                </div>
                {deleteView ? (
                  <button
                    onClick={() => deleteView(view.id)}
                    className="text-[var(--text-muted)] hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity px-1"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      {/* Projects Section */}
      <div className="mb-4">
        <button
          onClick={() => toggleSection('projects')}
          className="w-full flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 hover:text-[var(--text-secondary)] transition-colors"
        >
          <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('projects') ? '' : 'rotate-90'}`} />
          Projects
          {collapsedSections.has('projects') && projectFilter && (
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
          )}
        </button>
        {!collapsedSections.has('projects') && (
        <>
        {projects.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] italic">No projects yet</p>
        ) : (
          <ProjectCategoryGroups
            projects={projects}
            projectFilter={projectFilter}
            setProjectFilter={setProjectFilter}
            collapsedSections={collapsedSections}
            toggleSection={toggleSection}
          />
        )}
        </>
        )}
      </div>

      {/* Priority Section */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => toggleSection('priority')}
            className="flex-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide hover:text-[var(--text-secondary)] transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('priority') ? '' : 'rotate-90'}`} />
            Priority
            {collapsedSections.has('priority') && priorityFilter.length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
            )}
          </button>
          {priorityFilter.length > 0 && (
            <button
              onClick={() => setPriorityFilter([])}
              className="text-xs font-normal normal-case tracking-normal text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={10} className="inline" /> Clear
            </button>
          )}
        </div>
        {!collapsedSections.has('priority') && (
          <div className="flex flex-wrap gap-1">
            {(['critical', 'high', 'medium', 'low', 'none'] as const).map((p) => {
              const isActive = priorityFilter.includes(p);
              // Only show counts when no priority filter is active (counts are from unfiltered results)
              const count = priorityFilter.length === 0 ? taskResponse.tasks.filter((t) => t.priority === p).length : 0;
              return (
                <button
                  key={p}
                  onClick={() => setPriorityFilter((prev) =>
                    prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                  )}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium border transition-colors ${PRIORITY_COLORS[p]} ${
                    isActive ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]' : 'hover:opacity-80'
                  }`}
                >
                  {PRIORITY_LABELS[p] !== '—' ? `${PRIORITY_LABELS[p]} ${p}` : 'None'}
                  {isActive ? <span className="ml-1"><Check size={10} /></span> : count > 0 ? <span className="ml-1 opacity-60">{count}</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Status Section */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => toggleSection('status')}
            className="flex-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide hover:text-[var(--text-secondary)] transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('status') ? '' : 'rotate-90'}`} />
            Status
            {collapsedSections.has('status') && statusFilter.length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
            )}
          </button>
          {statusFilter.length > 0 && (
            <button
              onClick={() => setStatusFilter([])}
              className="text-xs font-normal normal-case tracking-normal text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={10} className="inline" /> Clear
            </button>
          )}
        </div>
        {!collapsedSections.has('status') && (
          <div className="flex flex-wrap gap-1">
            {(['todo', 'in_progress', 'done', 'cancelled'] as const).map((s) => {
              const isActive = statusFilter.includes(s);
              // Only show counts when no status filter is active (counts are from unfiltered results)
              const count = statusFilter.length === 0 ? taskResponse.tasks.filter((t) => t.status === s).length : 0;
              return (
                <button
                  key={s}
                  onClick={() => setStatusFilter((prev) =>
                    prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
                  )}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium border transition-colors ${STATUS_COLORS[s] || ''} ${
                    isActive ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]' : 'hover:opacity-80'
                  }`}
                >
                  {STATUS_LABELS[s]}
                  {isActive ? <span className="ml-1"><Check size={10} /></span> : count > 0 ? <span className="ml-1 opacity-60">{count}</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Tags Section */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => toggleSection('tags')}
            className="flex-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide hover:text-[var(--text-secondary)] transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('tags') ? '' : 'rotate-90'}`} />
            Tags{sourceFilter && <span className="ml-1 normal-case font-normal text-[var(--text-muted)]">({listFilter && enabledSources.find(s => s.type === sourceFilter)?.tagScope === 'per-list' ? selectedSourceList?.name || sourceFilter : enabledSources.find(s => s.type === sourceFilter)?.name || sourceFilter})</span>}
            {collapsedSections.has('tags') && tagFilter.length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
            )}
          </button>
          {tagFilter.length > 0 && (
            <button
              onClick={() => setTagFilter([])}
              className="text-xs font-normal normal-case tracking-normal text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={10} className="inline" /> Clear
            </button>
          )}
        </div>
        {!collapsedSections.has('tags') && (
        <div>
          {(allTags.length > TAG_DEFAULT_COUNT || tagSearch) && (
            <div className="relative mb-2">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                placeholder="Filter tags..."
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1 text-xs bg-[var(--surface-0)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {(() => {
              const sourceFilteredTags = sourceFilter
                ? allTags.filter((tag) => !isSyntheticTag(tag.name) && tag.sources?.includes(sourceFilter))
                : allTags.filter((tag) => !isSyntheticTag(tag.name));
              const sortedTags = [...sourceFilteredTags].sort((a, b) => (b.count || 0) - (a.count || 0));
              const searchedTags = tagSearch
                ? sortedTags.filter((tag) => tag.name.toLowerCase().includes(tagSearch.toLowerCase()))
                : sortedTags;
              const visibleTags = tagsExpanded || tagSearch ? searchedTags : searchedTags.slice(0, TAG_DEFAULT_COUNT);
              return (
                <>
                  {visibleTags.length === 0 && !tagSearch && (
                    <span className="text-xs text-[var(--text-muted)] italic">No tags for this source</span>
                  )}
                  {visibleTags.map((tag) => (
                    <button
                      key={tag.slug}
                      onClick={() => setTagFilter((prev) =>
                        prev.includes(tag.slug)
                          ? prev.filter((t) => t !== tag.slug)
                          : [...prev, tag.slug]
                      )}
                      className={`rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium border border-transparent text-[var(--text-secondary)] transition-colors ${
                        tagFilter.includes(tag.slug)
                          ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]'
                          : 'hover:opacity-80'
                      }`}
                      style={tag.color ? {
                        backgroundColor: `${tag.color}30`,
                        color: `color-mix(in oklch, ${tag.color} 60%, white)`,
                      } : undefined}
                    >
                      {tag.name}
                    </button>
                  ))}
                  {!tagSearch && searchedTags.length > TAG_DEFAULT_COUNT && (
                    <button
                      onClick={() => setTagsExpanded(!tagsExpanded)}
                      className="text-xs px-2 py-0.5 text-[var(--accent-400)] hover:text-[var(--accent-300)] transition-colors"
                    >
                      {tagsExpanded ? '← Show less' : `+${searchedTags.length - TAG_DEFAULT_COUNT} more`}
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>
        )}
      </div>

      {/* Sync Status Section - stays at bottom, scrolls with content */}
      {syncStatus.length > 0 && (
        <div className="mt-auto pt-4 border-t border-[var(--border-subtle)]">
          <button
            onClick={() => toggleSection('syncStatus')}
            className="w-full flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 hover:text-[var(--text-secondary)] transition-colors"
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${collapsedSections.has('syncStatus') ? '' : 'rotate-90'}`} />
            <span>Sync Status</span>
            {isSyncing && (
              <span className="flex items-center gap-1 text-blue-400 font-normal normal-case tracking-normal ml-2">
                <RefreshCw size={10} className="animate-spin" />
                <span className="text-xs">Syncing…</span>
              </span>
            )}
          </button>
          {!collapsedSections.has('syncStatus') && (
          <div className="space-y-2">
            {syncStatus.filter((status) => status.enabled).map((status) => (
              <div key={status.type} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  {CONNECTOR_ICONS[status.type] && (
                    <Image src={CONNECTOR_ICONS[status.type]} alt={status.type} width={12} height={12} />
                  )}
                  <span className="text-[var(--text-muted)] truncate max-w-[80px]">{status.name}</span>
                </div>
                {status.lastSyncedAt ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <CheckCircle2 size={10} />
                    <span>{formatSyncTime(status.lastSyncedAt)}</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[var(--text-muted)]">
                    <AlertCircle size={10} />
                    <span>Never</span>
                  </span>
                )}
              </div>
            ))}
          </div>
          )}
        </div>
      )}
    </aside>
  );
}

// Sub-component for source list rendering within expanded sources
function SourceListSection({
  source,
  currentSourceLists,
  listGroups,
  listSearch,
  listFilter,
  listGroupFilter,
  collapsedListGroups,
  sidebarExpanded,
  setListSearch,
  setSourceFilter,
  setListFilter,
  setListGroupFilter,
  setCollapsedListGroups,
}: {
  source: EnabledSource;
  currentSourceLists: SourceList[];
  listGroups: ListGroup[];
  listSearch: string;
  listFilter: string | null;
  listGroupFilter: string | null;
  collapsedListGroups: Set<string>;
  sidebarExpanded: boolean;
  setListSearch: (v: string) => void;
  setSourceFilter: (v: string | null) => void;
  setListFilter: (v: string | null) => void;
  setListGroupFilter: (v: string | null) => void;
  setCollapsedListGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const knownGroupIds = new Set(listGroups.map((g) => g.id));
  const sourceListsByGroup = new Map<string, SourceList[]>();
  const ungroupedLists: SourceList[] = [];
  for (const sl of currentSourceLists) {
    if (sl.groupId && knownGroupIds.has(sl.groupId)) {
      const existing = sourceListsByGroup.get(sl.groupId) || [];
      sourceListsByGroup.set(sl.groupId, [...existing, sl]);
    } else {
      ungroupedLists.push(sl);
    }
  }
  const groups = [...listGroups]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .filter((g) => sourceListsByGroup.has(g.id))
    .map((g) => ({
      group: g,
      sourceLists: (sourceListsByGroup.get(g.id) || []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)),
    }));

  return (
    <div className="ml-2 mt-1 space-y-1">
      <div className="relative mb-2">
        <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          type="text"
          placeholder="Filter lists..."
          value={listSearch}
          onChange={(e) => setListSearch(e.target.value)}
          className="w-full pl-6 pr-2 py-1 text-xs bg-[var(--surface-0)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
      </div>
      {groups.map(({ group, sourceLists: groupedLists }) => {
        const filteredLists = listSearch
          ? groupedLists.filter(sl => sl.name.toLowerCase().includes(listSearch.toLowerCase()))
          : groupedLists;
        if (filteredLists.length === 0) return null;
        const isCollapsed = listSearch ? false : collapsedListGroups.has(group.id);
        const isGroupActive = listGroupFilter === group.id;
        const groupTaskCount = groupedLists.reduce((sum, sl) => sum + sl.taskCount, 0);
        return (
          <div key={group.id} className="space-y-0.5">
            <div className={`flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold uppercase tracking-[0.06em] transition-colors border-b border-[var(--border-subtle)] ${
              isGroupActive ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-primary)] hover:text-[var(--accent)]'
            }`}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const next = new Set(collapsedListGroups);
                  isCollapsed ? next.delete(group.id) : next.add(group.id);
                  setCollapsedListGroups(next);
                }}
                className="shrink-0 p-0.5 -ml-0.5 rounded hover:bg-[var(--surface-2)]"
              >
                <ChevronRight size={10} className={`transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`} />
              </button>
              <button
                onClick={() => {
                  if (isGroupActive) {
                    setListGroupFilter(null);
                    setListFilter(null);
                  } else {
                    setSourceFilter(source.type);
                    setListGroupFilter(group.id);
                    setListFilter(null);
                  }
                }}
                className="flex items-center gap-1.5 flex-1 min-w-0"
              >
                <span className="text-xs leading-none">{group.icon ? <IconRenderer value={group.icon} size={12} color={group.iconColor || undefined} /> : <FolderOpen size={11} className="inline" />}</span>
                <span className={sidebarExpanded ? '' : 'truncate'}>{group.name}</span>
                {groupTaskCount > 0 && (
                  <AnimatedCounter value={groupTaskCount} className="text-xs text-[var(--text-muted)] tabular-nums shrink-0 ml-auto" />
                )}
              </button>
              {isGroupActive && (
                <button
                  onClick={(e) => { e.stopPropagation(); setListGroupFilter(null); }}
                  className="shrink-0 text-[var(--accent)] hover:text-[var(--text-primary)]"
                  title="Clear group filter"
                >×</button>
              )}
              {!isGroupActive && isCollapsed && listFilter && filteredLists.some(sl => matchesSourceListFilter(sl, listFilter)) && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
              )}
            </div>
            {!isCollapsed && (
              <div className="pl-7 space-y-0.5">
                {filteredLists.map((sl) => (
                  <button
                    key={sl.id}
                    onClick={() => { setSourceFilter(source.type); setListGroupFilter(null); setListFilter(matchesSourceListFilter(sl, listFilter) ? null : sl.sourceId); }}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-xs transition-colors ${
                      matchesSourceListFilter(sl, listFilter)
                        ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5 truncate">
                      {sl.icon ? <IconRenderer value={sl.icon} size={11} color={sl.iconColor || undefined} className="flex-shrink-0" /> : <List size={11} className="flex-shrink-0" />}
                      <span className="truncate">{sl.name}</span>
                      {sl.selectedForSync === false && (
                        <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-amber-400">
                          Not syncing
                        </span>
                      )}
                    </span>
                    {sl.taskCount > 0 && (
                      <AnimatedCounter value={sl.taskCount} className="text-xs text-[var(--text-muted)] tabular-nums shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {(() => {
        const filteredUngrouped = listSearch
          ? ungroupedLists.filter(sl => sl.name.toLowerCase().includes(listSearch.toLowerCase()))
          : ungroupedLists;
        if (filteredUngrouped.length === 0) return null;
        const isCollapsed = listSearch ? false : (groups.length > 0 && collapsedListGroups.has('__ungrouped__'));
        return (
          <div className="space-y-0.5">
            {groups.length > 0 && (
              <button
                onClick={() => {
                  const next = new Set(collapsedListGroups);
                  isCollapsed ? next.delete('__ungrouped__') : next.add('__ungrouped__');
                  setCollapsedListGroups(next);
                }}
                className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold uppercase tracking-[0.06em] text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors border-b border-[var(--border-subtle)]"
              >
                <ChevronRight size={10} className={`shrink-0 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`} />
                <span className="text-xs leading-none"><List size={11} className="inline" /></span>
                <span>Other</span>
              </button>
            )}
            {!isCollapsed && (
              <div className={`${groups.length > 0 ? 'pl-7' : ''} space-y-0.5`}>
                {filteredUngrouped.map((sl) => (
                  <button
                    key={sl.id}
                    onClick={() => { setSourceFilter(source.type); setListGroupFilter(null); setListFilter(matchesSourceListFilter(sl, listFilter) ? null : sl.sourceId); }}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-xs transition-colors ${
                      matchesSourceListFilter(sl, listFilter)
                        ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5 truncate">
                      {sl.icon ? <IconRenderer value={sl.icon} size={11} color={sl.iconColor || undefined} className="flex-shrink-0" /> : <List size={11} className="flex-shrink-0" />}
                      <span className="truncate">{sl.name}</span>
                      {sl.selectedForSync === false && (
                        <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-amber-400">
                          Not syncing
                        </span>
                      )}
                    </span>
                    {sl.taskCount > 0 && (
                      <AnimatedCounter value={sl.taskCount} className="text-xs text-[var(--text-muted)] tabular-nums shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// Sub-component for project category grouping in the sidebar
function ProjectCategoryGroups({
  projects,
  projectFilter,
  setProjectFilter,
  collapsedSections,
  toggleSection,
}: {
  projects: HubProject[];
  projectFilter: string | null;
  setProjectFilter: (v: string | null) => void;
  collapsedSections: Set<string>;
  toggleSection: (section: string) => void;
}) {
  // Group projects by category
  const categorized = new Map<string, HubProject[]>();
  const uncategorized: HubProject[] = [];

  for (const project of projects) {
    if (project.category) {
      const existing = categorized.get(project.category) || [];
      categorized.set(project.category, [...existing, project]);
    } else {
      uncategorized.push(project);
    }
  }

  const categories = [...categorized.entries()]
    .sort(([a], [b]) => a.localeCompare(b));

  // If no categories exist, just render flat list
  if (categories.length === 0) {
    return (
      <div className="space-y-1">
        {uncategorized.map((project) => (
          <ProjectSidebarItem key={project.id} project={project} projectFilter={projectFilter} setProjectFilter={setProjectFilter} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {categories.map(([category, categoryProjects]) => {
        const sectionKey = `project-cat:${category}`;
        const isCollapsed = collapsedSections.has(sectionKey);
        return (
          <div key={category} className="space-y-0.5">
            <button
              onClick={() => toggleSection(sectionKey)}
              className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold uppercase tracking-[0.06em] text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors border-b border-[var(--border-subtle)]"
            >
              <ChevronRight size={10} className={`shrink-0 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`} />
              <span className="text-xs leading-none"><FolderOpen size={11} className="inline" /></span>
              <span>{category}</span>
              {isCollapsed && projectFilter && categoryProjects.some(p => p.id === projectFilter) && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
              )}
            </button>
            {!isCollapsed && (
              <div className="pl-5 space-y-0.5">
                {categoryProjects.map((project) => (
                  <ProjectSidebarItem key={project.id} project={project} projectFilter={projectFilter} setProjectFilter={setProjectFilter} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {uncategorized.length > 0 && (
        <div className="space-y-0.5">
          <button
            onClick={() => toggleSection('project-cat:__other__')}
            className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold uppercase tracking-[0.06em] text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors border-b border-[var(--border-subtle)]"
          >
            <ChevronRight size={10} className={`shrink-0 transition-transform duration-150 ${collapsedSections.has('project-cat:__other__') ? '' : 'rotate-90'}`} />
            <span className="text-xs leading-none"><List size={11} className="inline" /></span>
            <span>Other</span>
          </button>
          {!collapsedSections.has('project-cat:__other__') && (
            <div className="pl-5 space-y-0.5">
              {uncategorized.map((project) => (
                <ProjectSidebarItem key={project.id} project={project} projectFilter={projectFilter} setProjectFilter={setProjectFilter} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectSidebarItem({
  project,
  projectFilter,
  setProjectFilter,
}: {
  project: HubProject;
  projectFilter: string | null;
  setProjectFilter: (v: string | null) => void;
}) {
  const isSyncManagedProject = !!(project.metadata as Record<string, unknown> | undefined)?.syncManaged;
  return (
    <SidebarNavItem
      icon={isSyncManagedProject
        ? <Image src="/icons/connectors/github.svg" alt="GitHub" width={12} height={12} className="flex-shrink-0 opacity-80" />
        : project.icon
          ? <IconRenderer value={project.icon} size={16} color={project.color} />
          : <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} />
      }
      label={project.name}
      count={0}
      active={projectFilter === project.id}
      onClick={() => setProjectFilter(projectFilter === project.id ? null : project.id)}
    />
  );
}
