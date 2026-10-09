'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Archive,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  FileCheck2,
  FileText,
  Filter,
  FolderOpen,
  ExternalLink,
  Inbox,
  Loader2,
  MessageSquareText,
  PenLine,
  Plus,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { AgentAttribution } from '@/components/domains/AgentAttribution';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { GroupByDropdown, type GroupOption } from '@/components/toolbar/GroupByDropdown';
import { SortDropdown, type SortOption } from '@/components/toolbar/SortDropdown';
import { CollapsibleSection } from '@/components/dashboard/CollapsibleSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Dropdown } from '@/components/ui/Dropdown';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';
import { cn } from '@/lib/utils/cn';
import { formatShortDate } from '@/lib/utils/date-format';
import {
  countByMetadata,
  countDocumentViews,
  filterDocumentTasks,
  groupDocumentTasks,
  parseDocumentTaskMetadata,
  sortDocumentTasks,
  type DocumentGroup,
  type DocumentSort,
  type DocumentTask,
  type DocumentView,
  type SortDirection,
} from './document-workspace';
import type {
  TaskDetailCloseReason,
  TaskDetailMode,
  TaskFieldUpdate,
} from '@/components/task-detail/task-detail-types';

type ActionTypeFilter = 'all' | 'pay' | 'respond' | 'file' | 'archive' | 'review' | 'sign' | 'schedule';
type UrgencyFilter = 'all' | 'critical' | 'high' | 'medium' | 'low';

interface ViewDefinition {
  id: DocumentView;
  label: string;
  icon: LucideIcon;
}

const ACTION_TYPE_META: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  pay: { label: 'Pay', icon: CreditCard, color: 'text-green-400' },
  respond: { label: 'Respond', icon: PenLine, color: 'text-blue-400' },
  file: { label: 'File', icon: FolderOpen, color: 'text-amber-400' },
  archive: { label: 'Archive', icon: Archive, color: 'text-slate-400' },
  review: { label: 'Review', icon: FileText, color: 'text-purple-400' },
  sign: { label: 'Sign', icon: FileCheck2, color: 'text-cyan-400' },
  schedule: { label: 'Schedule', icon: CalendarPlus, color: 'text-orange-400' },
};

const URGENCY_COLORS: Record<string, string> = {
  critical: 'text-rose-400 bg-rose-400/10 border-rose-400/30',
  high: 'text-orange-400 bg-orange-400/10 border-orange-400/30',
  medium: 'text-amber-300 bg-amber-300/10 border-amber-300/30',
  low: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
};

const URGENCY_PRIORITY: Record<string, { code: string; label: string }> = {
  critical: { code: 'P0', label: 'Critical urgency' },
  high: { code: 'P1', label: 'High urgency' },
  medium: { code: 'P2', label: 'Medium urgency' },
  low: { code: 'P3', label: 'Low urgency' },
};

const VIEW_DEFINITIONS: ViewDefinition[] = [
  { id: 'all', label: 'All actions', icon: Inbox },
  { id: 'payments', label: 'Payments', icon: CreditCard },
  { id: 'review-sign', label: 'Review & sign', icon: FileCheck2 },
  { id: 'responses', label: 'Respond & schedule', icon: MessageSquareText },
  { id: 'filing', label: 'Filing', icon: FolderOpen },
  { id: 'due-soon', label: 'Due soon', icon: CalendarClock },
  { id: 'overdue', label: 'Overdue', icon: ShieldAlert },
];

const DOCUMENT_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'dueDate', label: 'Due date' },
  { value: 'amount', label: 'Amount' },
  { value: 'correspondent', label: 'Correspondent' },
  { value: 'createdAt', label: 'Created date' },
];

const DOCUMENT_GROUP_OPTIONS: readonly GroupOption[] = [
  { value: 'none', label: 'None' },
  { value: 'actionType', label: 'Action type' },
  { value: 'urgency', label: 'Urgency' },
  { value: 'correspondent', label: 'Correspondent' },
  { value: 'dueDate', label: 'Due date' },
];

const STORAGE_KEYS = {
  view: 'mission-control:docs:view',
  sort: 'mission-control:docs:sort',
  direction: 'mission-control:docs:sort-direction',
  group: 'mission-control:docs:group',
} as const;

export default function DocIntelligencePage() {
  const [tasks, setTasks] = useState<DocumentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewAlerts, setReviewAlerts] = useState<Array<{ id: string; title: string; reviewUrl: string }>>([]);
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [detailMode, setDetailMode] = useState<Exclude<TaskDetailMode, 'mobile'>>('panel');
  const [selectedView, setSelectedView] = useState<DocumentView>('all');
  const [actionTypeFilter, setActionTypeFilter] = useState<ActionTypeFilter>('all');
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>('all');
  const [correspondentFilter, setCorrespondentFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<DocumentSort>('dueDate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [groupBy, setGroupBy] = useState<DocumentGroup>('dueDate');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const taskSelection = useTaskSelection({
    selectedTaskId,
    onSelectionChange: setSelectedTaskId,
  });

  useEffect(() => {
    const restoreFrame = requestAnimationFrame(() => {
      const storedView = localStorage.getItem(STORAGE_KEYS.view);
      const storedSort = localStorage.getItem(STORAGE_KEYS.sort);
      const storedDirection = localStorage.getItem(STORAGE_KEYS.direction);
      const storedGroup = localStorage.getItem(STORAGE_KEYS.group);
      if (VIEW_DEFINITIONS.some((view) => view.id === storedView)) setSelectedView(storedView as DocumentView);
      if (DOCUMENT_SORT_OPTIONS.some((option) => option.value === storedSort)) setSortBy(storedSort as DocumentSort);
      if (storedDirection === 'asc' || storedDirection === 'desc') setSortDirection(storedDirection);
      if (DOCUMENT_GROUP_OPTIONS.some((option) => option.value === storedGroup)) setGroupBy(storedGroup as DocumentGroup);
    });
    return () => cancelAnimationFrame(restoreFrame);
  }, []);

  const fetchTasks = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    setLoadError(null);

    try {
      const [res, notificationsResponse] = await Promise.all([
        fetch('/api/tasks?source=document-intelligence&openOnly=true&sortBy=dueDate&sortDirection=asc&limit=200'),
        fetch('/api/notifications?source=document-intelligence&limit=200').catch(() => null),
      ]);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = await res.json();
      setTasks(data.tasks || []);
      if (notificationsResponse?.ok) {
        const notificationData = await notificationsResponse.json() as {
          notifications?: Array<{
            id?: unknown;
            title?: unknown;
            templateKey?: unknown;
            metadata?: unknown;
          }>;
        };
        setReviewAlerts((notificationData.notifications || []).flatMap((notification) => {
          if (
            notification.templateKey !== 'owl_needs_review'
            || typeof notification.id !== 'string'
            || typeof notification.title !== 'string'
            || !notification.metadata
            || typeof notification.metadata !== 'object'
            || Array.isArray(notification.metadata)
          ) {
            return [];
          }
          const reviewUrl = normalizeExternalUrl(
            (notification.metadata as Record<string, unknown>).reviewUrl,
          );
          return reviewUrl ? [{ id: notification.id, title: notification.title, reviewUrl }] : [];
        }));
      } else {
        setReviewAlerts([]);
      }
    } catch {
      setLoadError('OWL document actions could not be loaded. Check the connector and try again.');
      toast.error('OWL could not load Paperless-ngx document actions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial connector synchronization is intentionally client-driven for this interactive workspace.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTasks();
  }, [fetchTasks]);

  const filteredTasks = useMemo(() => filterDocumentTasks(tasks, {
    view: selectedView,
    actionType: actionTypeFilter,
    category: 'all',
    urgency: urgencyFilter,
    correspondent: correspondentFilter,
    query: searchQuery,
  }), [tasks, selectedView, actionTypeFilter, urgencyFilter, correspondentFilter, searchQuery]);

  const sortedTasks = useMemo(
    () => sortDocumentTasks(filteredTasks, sortBy, sortDirection),
    [filteredTasks, sortBy, sortDirection],
  );
  const taskGroups = useMemo(() => groupDocumentTasks(sortedTasks, groupBy), [sortedTasks, groupBy]);
  const viewCounts = useMemo(() => countDocumentViews(tasks), [tasks]);
  const actionTypeCounts = useMemo(() => countByMetadata(tasks, 'actionType'), [tasks]);
  const urgencyCounts = useMemo(() => countByMetadata(tasks, 'urgency'), [tasks]);
  const correspondentCounts = useMemo(() => countByMetadata(tasks, 'correspondent'), [tasks]);
  const correspondents = useMemo(
    () => Object.entries(correspondentCounts).sort(([left], [right]) => left.localeCompare(right)),
    [correspondentCounts],
  );
  const activeFilters = [
    actionTypeFilter !== 'all' ? ACTION_TYPE_META[actionTypeFilter]?.label : null,
    urgencyFilter !== 'all' ? `${urgencyFilter} urgency` : null,
    correspondentFilter !== 'all' ? correspondentFilter : null,
  ].filter((value): value is string => !!value);
  const hasFilters = selectedView !== 'all'
    || activeFilters.length > 0
    || !!searchQuery.trim();

  function changeView(view: DocumentView) {
    setSelectedView(view);
    localStorage.setItem(STORAGE_KEYS.view, view);
  }

  function selectDocumentTask(taskId: string) {
    setDetailMode('panel');
    taskSelection.selectTask(taskId);
  }

  function closeDocumentTask(reason?: TaskDetailCloseReason) {
    setDetailMode('panel');
    setSelectedTaskId(
      null,
      reason === 'task-removed' ? { history: 'replace' } : undefined,
    );
  }

  function handleSortChange(nextSort: string, nextDirection: SortDirection) {
    setSortBy(nextSort as DocumentSort);
    setSortDirection(nextDirection);
    localStorage.setItem(STORAGE_KEYS.sort, nextSort);
    localStorage.setItem(STORAGE_KEYS.direction, nextDirection);
  }

  function handleGroupChange(nextGroup: string) {
    setGroupBy(nextGroup as DocumentGroup);
    localStorage.setItem(STORAGE_KEYS.group, nextGroup);
  }

  function clearFilters() {
    setSelectedView('all');
    setActionTypeFilter('all');
    setUrgencyFilter('all');
    setCorrespondentFilter('all');
    setSearchQuery('');
    localStorage.setItem(STORAGE_KEYS.view, 'all');
  }

  const handleTaskUpdate = useCallback((fields?: TaskFieldUpdate) => {
    if (selectedTaskId && fields) {
      setTasks((current) => current.map((task) => task.id === selectedTaskId
        ? {
            ...task,
            ...(typeof fields.title === 'string' ? { title: fields.title } : {}),
            ...(typeof fields.status === 'string' ? { status: fields.status } : {}),
            ...(typeof fields.priority === 'string' ? { priority: fields.priority } : {}),
            ...(fields.dueDate === null || typeof fields.dueDate === 'string'
              ? { dueDate: fields.dueDate }
              : {}),
          }
        : task));
      return;
    }
    void fetchTasks(true);
  }, [fetchTasks, selectedTaskId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      <header className="flex-shrink-0 border-b border-[var(--border)] px-4 pb-3 pt-4 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <FileText size={20} className="shrink-0 text-indigo-400" />
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Document Actions</h1>
            <AgentAttribution agent="OWL" />
            <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
              {filteredTasks.length} action{filteredTasks.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void fetchTasks(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors duration-100 hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Execute trusted OWL actions here; review document uncertainty in OWL.
        </p>

        {reviewAlerts.length > 0 && (
          <aside
            aria-label="OWL items needing review"
            className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-xs font-semibold text-amber-300">
                {reviewAlerts.length} item{reviewAlerts.length === 1 ? '' : 's'} need review in OWL
              </span>
              {reviewAlerts.slice(0, 3).map((alert) => (
                <a
                  key={alert.id}
                  href={alert.reviewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-amber-200 underline-offset-2 hover:underline"
                >
                  <ExternalLink size={11} aria-hidden="true" />
                  {alert.title.replace(/^Needs review in OWL:\s*/i, '')}
                </a>
              ))}
            </div>
          </aside>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search actions, documents, correspondents..."
            clearLabel="Clear document search"
            className="min-w-[180px] max-w-md flex-1 rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 focus-within:border-[var(--accent)]"
          />

          <DocumentFilterBuilder
            selectedView={selectedView}
            onViewChange={changeView}
            actionTypeFilter={actionTypeFilter}
            onActionTypeChange={setActionTypeFilter}
            urgencyFilter={urgencyFilter}
            onUrgencyChange={setUrgencyFilter}
            correspondentFilter={correspondentFilter}
            onCorrespondentChange={setCorrespondentFilter}
            correspondents={correspondents}
          />

          <button
            type="button"
            onClick={() => setMobileFiltersOpen((open) => !open)}
            aria-expanded={mobileFiltersOpen}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] lg:hidden"
          >
            <SlidersHorizontal size={13} />
            Filters
          </button>

          <GroupByDropdown
            options={DOCUMENT_GROUP_OPTIONS}
            value={groupBy}
            onChange={handleGroupChange}
          />
          <SortDropdown
            options={DOCUMENT_SORT_OPTIONS}
            value={sortBy}
            direction={sortDirection}
            onChange={handleSortChange}
          />
        </div>

        {(activeFilters.length > 0 || selectedView !== 'all') && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Active</span>
            {selectedView !== 'all' && (
              <ActiveFilterChip label={VIEW_DEFINITIONS.find((view) => view.id === selectedView)?.label ?? selectedView} />
            )}
            {activeFilters.map((filter) => <ActiveFilterChip key={filter} label={filter} />)}
            <button
              type="button"
              onClick={clearFilters}
              className="ml-1 text-xs font-medium text-[var(--accent)] hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
      </header>

      {mobileFiltersOpen && (
        <div className="max-h-[50vh] overflow-y-auto border-b border-[var(--border)] bg-[var(--surface-1)] p-4 lg:hidden">
          <DocumentFilters
            selectedView={selectedView}
            onViewChange={changeView}
            viewCounts={viewCounts}
            actionTypeFilter={actionTypeFilter}
            onActionTypeChange={setActionTypeFilter}
            actionTypeCounts={actionTypeCounts}
            urgencyFilter={urgencyFilter}
            onUrgencyChange={setUrgencyFilter}
            urgencyCounts={urgencyCounts}
            correspondentFilter={correspondentFilter}
            onCorrespondentChange={setCorrespondentFilter}
            correspondents={correspondents}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface-1)] p-3 lg:block">
          <DocumentFilters
            selectedView={selectedView}
            onViewChange={changeView}
            viewCounts={viewCounts}
            actionTypeFilter={actionTypeFilter}
            onActionTypeChange={setActionTypeFilter}
            actionTypeCounts={actionTypeCounts}
            urgencyFilter={urgencyFilter}
            onUrgencyChange={setUrgencyFilter}
            urgencyCounts={urgencyCounts}
            correspondentFilter={correspondentFilter}
            onCorrespondentChange={setCorrespondentFilter}
            correspondents={correspondents}
          />
        </aside>

        <main className={cn(
          'overflow-y-auto border-r border-[var(--border)]',
          selectedTaskId ? 'hidden w-full sm:block sm:w-[360px] sm:shrink-0 xl:w-[440px] 2xl:w-[500px]' : 'flex-1',
        )}>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
              <span className="ml-2 text-sm text-[var(--text-muted)]">OWL is loading document actions...</span>
            </div>
          ) : loadError ? (
            <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
              <ShieldAlert size={24} className="text-amber-400" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">OWL actions unavailable</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{loadError}</p>
              <button
                type="button"
                onClick={() => void fetchTasks()}
                className="mt-4 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              >
                Try again
              </button>
            </div>
          ) : filteredTasks.length === 0 ? (
            <EmptyState hasFilters={hasFilters} onClearFilters={clearFilters} />
          ) : (
            <div className={cn(groupBy !== 'none' && 'space-y-1 pb-4')}>
              {taskGroups.map((group) => (
                <section key={group.id}>
                  {group.label && (
                    <div className="sticky top-0 z-10 flex items-center justify-between border-y border-[var(--border-subtle)] bg-[var(--surface-1)]/95 px-4 py-2 backdrop-blur-sm">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                        {group.label}
                      </h2>
                      <span className="text-xs tabular-nums text-[var(--text-muted)]">{group.tasks.length}</span>
                    </div>
                  )}
                  <div className="divide-y divide-[var(--border-subtle)]">
                    {group.tasks.map((task) => (
                      <ActionRow
                        key={task.id}
                        task={task}
                        isSelected={task.id === selectedTaskId}
                        onClick={() => selectDocumentTask(task.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </main>

        {selectedTaskId ? (
          <section className="flex min-w-0 flex-1 overflow-hidden bg-[var(--surface-0)]" aria-label="Document action details">
            <div className="h-full min-w-0 flex-1">
              <TaskDetailPanel
                key={selectedTaskId}
                taskId={selectedTaskId}
                onClose={closeDocumentTask}
                onUpdate={handleTaskUpdate}
                mode={detailMode}
                onModeChange={setDetailMode}
                portalDialog
                minPanelWidth={420}
                fillContainer
              />
            </div>
          </section>
        ) : (
          <section className="hidden min-w-0 flex-1 items-center justify-center bg-[var(--surface-0)] sm:flex">
            <div className="max-w-xs text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                <FileText size={20} className="text-indigo-400" />
              </div>
              <p className="text-sm font-medium text-[var(--text-secondary)]">Select a document action</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                Review the document, its OWL metadata, and task actions side by side.
              </p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function DocumentFilters({
  selectedView,
  onViewChange,
  viewCounts,
  actionTypeFilter,
  onActionTypeChange,
  actionTypeCounts,
  urgencyFilter,
  onUrgencyChange,
  urgencyCounts,
  correspondentFilter,
  onCorrespondentChange,
  correspondents,
}: {
  selectedView: DocumentView;
  onViewChange: (view: DocumentView) => void;
  viewCounts: Record<DocumentView, number>;
  actionTypeFilter: ActionTypeFilter;
  onActionTypeChange: (filter: ActionTypeFilter) => void;
  actionTypeCounts: Record<string, number>;
  urgencyFilter: UrgencyFilter;
  onUrgencyChange: (filter: UrgencyFilter) => void;
  urgencyCounts: Record<string, number>;
  correspondentFilter: string;
  onCorrespondentChange: (filter: string) => void;
  correspondents: Array<[string, number]>;
}) {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const toggleSection = (section: string) => {
    setCollapsedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  return (
    <div className="space-y-1">
      {correspondents.length > 0 && (
        <CollapsibleSection
          title="Correspondent"
          collapsed={!!collapsedSections.correspondent}
          onToggle={() => toggleSection('correspondent')}
        >
          <div className="px-1 pb-3">
            <Select value={correspondentFilter} onValueChange={onCorrespondentChange}>
              <SelectTrigger className="w-full" aria-label="Filter by correspondent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All correspondents</SelectItem>
                {correspondents.map(([name, count]) => (
                  <SelectItem key={name} value={name}>{name} ({count})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CollapsibleSection>
      )}

      <CollapsibleSection
        title="Quick views"
        collapsed={!!collapsedSections.views}
        onToggle={() => toggleSection('views')}
      >
        <div className="space-y-0.5 px-1 pb-2">
          <p className="px-2 pb-1 text-[11px] leading-4 text-[var(--text-muted)]">
            Shortcuts that combine related action types or due dates.
          </p>
          {VIEW_DEFINITIONS.map(({ id, label, icon: Icon }) => (
            <FilterRow
              key={id}
              label={label}
              count={viewCounts[id]}
              active={selectedView === id}
              icon={<Icon size={13} />}
              onClick={() => onViewChange(id)}
            />
          ))}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Action type"
        collapsed={!!collapsedSections.actionType}
        onToggle={() => toggleSection('actionType')}
      >
        <div className="space-y-0.5 px-1 pb-2">
          <FilterRow
            label="All types"
            count={Object.values(actionTypeCounts).reduce((sum, count) => sum + count, 0)}
            active={actionTypeFilter === 'all'}
            icon={<Inbox size={13} />}
            onClick={() => onActionTypeChange('all')}
          />
          {Object.entries(ACTION_TYPE_META).map(([id, meta]) => {
            const Icon = meta.icon;
            return (
              <FilterRow
                key={id}
                label={meta.label}
                count={actionTypeCounts[id] ?? 0}
                active={actionTypeFilter === id}
                icon={<Icon size={13} className={meta.color} />}
                onClick={() => onActionTypeChange(id as ActionTypeFilter)}
              />
            );
          })}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Urgency"
        collapsed={!!collapsedSections.urgency}
        onToggle={() => toggleSection('urgency')}
      >
        <div className="space-y-0.5 px-1 pb-2">
          <FilterRow
            label="All urgency"
            count={Object.values(urgencyCounts).reduce((sum, count) => sum + count, 0)}
            active={urgencyFilter === 'all'}
            icon={<Inbox size={13} />}
            onClick={() => onUrgencyChange('all')}
          />
          {(['critical', 'high', 'medium', 'low'] as const).map((urgency) => (
            <FilterRow
              key={urgency}
              label={`${URGENCY_PRIORITY[urgency].code} · ${urgency.charAt(0).toUpperCase()}${urgency.slice(1)}`}
              count={urgencyCounts[urgency] ?? 0}
              active={urgencyFilter === urgency}
              icon={<span className={cn('h-2 w-2 rounded-full', {
                'bg-rose-400': urgency === 'critical',
                'bg-orange-400': urgency === 'high',
                'bg-amber-300': urgency === 'medium',
                'bg-sky-400': urgency === 'low',
              })} />}
              onClick={() => onUrgencyChange(urgency)}
            />
          ))}
        </div>
      </CollapsibleSection>

    </div>
  );
}

function normalizeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function FilterRow({
  label,
  count,
  active,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
        active
          ? 'bg-[var(--accent)]/10 text-[var(--accent-400)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
      )}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular-nums text-xs text-[var(--text-muted)]">{count}</span>
    </button>
  );
}

function ActiveFilterChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent-300)]">
      {label}
      <Filter size={9} aria-hidden="true" />
    </span>
  );
}

type DocumentBuilderCategory = 'actionType' | 'urgency' | 'correspondent' | 'timing';

function DocumentFilterBuilder({
  selectedView,
  onViewChange,
  actionTypeFilter,
  onActionTypeChange,
  urgencyFilter,
  onUrgencyChange,
  correspondentFilter,
  onCorrespondentChange,
  correspondents,
}: {
  selectedView: DocumentView;
  onViewChange: (view: DocumentView) => void;
  actionTypeFilter: ActionTypeFilter;
  onActionTypeChange: (filter: ActionTypeFilter) => void;
  urgencyFilter: UrgencyFilter;
  onUrgencyChange: (filter: UrgencyFilter) => void;
  correspondentFilter: string;
  onCorrespondentChange: (filter: string) => void;
  correspondents: Array<[string, number]>;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<DocumentBuilderCategory | null>(null);
  const [filterSearch, setFilterSearch] = useState('');

  const categories: Array<{
    id: DocumentBuilderCategory;
    label: string;
    icon: LucideIcon;
  }> = [
    { id: 'actionType', label: 'Action type', icon: FileCheck2 },
    { id: 'urgency', label: 'Priority', icon: ShieldAlert },
    { id: 'correspondent', label: 'Correspondent', icon: MessageSquareText },
    { id: 'timing', label: 'Due date', icon: CalendarClock },
  ];

  const options: Array<{
    value: string;
    label: string;
    detail?: string;
    selected: boolean;
  }> = category === 'actionType'
    ? Object.entries(ACTION_TYPE_META).map(([value, meta]) => ({
        value,
        label: meta.label,
        selected: actionTypeFilter === value,
      }))
    : category === 'urgency'
      ? (['critical', 'high', 'medium', 'low'] as const).map((value) => ({
          value,
          label: `${URGENCY_PRIORITY[value].code} · ${value.charAt(0).toUpperCase()}${value.slice(1)}`,
          selected: urgencyFilter === value,
        }))
      : category === 'correspondent'
        ? correspondents.map(([value, count]) => ({
            value,
            label: value,
            detail: String(count),
            selected: correspondentFilter === value,
          }))
        : category === 'timing'
          ? [
              { value: 'due-soon', label: 'Due in the next 7 days', selected: selectedView === 'due-soon' },
              { value: 'overdue', label: 'Overdue', selected: selectedView === 'overdue' },
            ]
          : [];
  const normalizedSearch = filterSearch.trim().toLocaleLowerCase();
  const visibleCategories = categories.filter((item) => (
    !normalizedSearch || item.label.toLocaleLowerCase().includes(normalizedSearch)
  ));
  const visibleOptions = options.filter((item) => (
    !normalizedSearch || item.label.toLocaleLowerCase().includes(normalizedSearch)
  ));

  function close() {
    setOpen(false);
    setCategory(null);
    setFilterSearch('');
  }

  function apply(value: string) {
    if (category === 'actionType') onActionTypeChange(value as ActionTypeFilter);
    if (category === 'urgency') onUrgencyChange(value as UrgencyFilter);
    if (category === 'correspondent') onCorrespondentChange(value);
    if (category === 'timing') onViewChange(value as DocumentView);
    close();
  }

  return (
    <Dropdown
      trigger={(
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
        >
          <Plus size={13} className="text-[var(--accent-400)]" aria-hidden="true" />
          Add Filter
        </button>
      )}
      isOpen={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setCategory(null);
          setFilterSearch('');
        }
      }}
      align="left"
      width="w-72"
      role="dialog"
      ariaLabel={category ? `Select ${categories.find((item) => item.id === category)?.label} filter` : 'Add a document filter'}
      className="p-1.5"
    >
      <div className="flex items-center gap-2 px-1 py-1">
        {category && (
          <button
            type="button"
            onClick={() => {
              setCategory(null);
              setFilterSearch('');
            }}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
            aria-label="Back to document filter types"
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <SearchInput
          value={filterSearch}
          onChange={setFilterSearch}
          placeholder={category ? `Search ${categories.find((item) => item.id === category)?.label.toLocaleLowerCase()}…` : 'Search filters…'}
          clearLabel="Clear filter search"
          className="min-w-0 flex-1"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {category
          ? visibleOptions.map((option) => (
              <button
                type="button"
                key={option.value}
                onClick={() => apply(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs',
                  option.selected
                    ? 'bg-[var(--accent)]/10 text-[var(--accent-300)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.detail && (
                  <span className="tabular-nums text-[var(--text-muted)]">{option.detail}</span>
                )}
                {option.selected && <CheckCircle2 size={13} aria-hidden="true" />}
              </button>
            ))
          : visibleCategories.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                onClick={() => {
                  setCategory(id);
                  setFilterSearch('');
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
              >
                <Icon size={14} className="text-[var(--text-muted)]" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                <ChevronRight size={13} className="text-[var(--text-muted)]" aria-hidden="true" />
              </button>
            ))}
        {(category ? visibleOptions : visibleCategories).length === 0 && (
          <p className="px-3 py-5 text-center text-xs text-[var(--text-muted)]">No matching filters</p>
        )}
      </div>
    </Dropdown>
  );
}

function ActionRow({ task, isSelected, onClick }: { task: DocumentTask; isSelected: boolean; onClick: () => void }) {
  const metadata = parseDocumentTaskMetadata(task.metadata);
  const actionType = metadata.actionType || 'review';
  const urgency = metadata.urgency || 'medium';
  const urgencyPriority = URGENCY_PRIORITY[urgency] ?? { code: '—', label: 'Urgency not set' };
  const ActionIcon = ACTION_TYPE_META[actionType]?.icon || FileText;
  const actionColor = ACTION_TYPE_META[actionType]?.color || 'text-[var(--text-muted)]';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group w-full px-4 py-3 text-left transition-colors duration-75',
        isSelected
          ? 'bg-[var(--accent-500)]/8 ring-1 ring-inset ring-[var(--accent-400)]'
          : 'hover:bg-[var(--surface-2)]',
      )}
    >
      <div className="flex items-start gap-3">
        <ActionIcon size={15} className={cn('mt-0.5 shrink-0', actionColor)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--text-primary)]">{task.title}</span>
            {typeof metadata.amount === 'number' && Number.isFinite(metadata.amount) && (
              <span className="shrink-0 text-xs font-semibold tabular-nums text-emerald-400">
                ${metadata.amount.toFixed(2)}
              </span>
            )}
          </div>
          {task.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-[var(--text-muted)]">{task.description}</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <span className={cn(
              'inline-flex rounded border px-1.5 py-0.5 text-xs font-semibold tabular-nums',
              URGENCY_COLORS[urgency] || 'text-[var(--text-muted)]',
            )} title={urgencyPriority.label} aria-label={urgencyPriority.label}>
              {urgencyPriority.code}
            </span>
            {metadata.correspondent && (
              <span className="truncate text-xs text-[var(--text-muted)]">{metadata.correspondent}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span className="flex items-center gap-0.5" title="Created date">
                <CalendarPlus size={10} aria-hidden="true" />
                {formatShortDate(task.createdAt)}
              </span>
              {task.dueDate && (
                <span className="flex items-center gap-0.5 font-medium text-[var(--text-secondary)]" title="Due date">
                  <Clock size={10} aria-hidden="true" />
                  {formatShortDate(task.dueDate)}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

function EmptyState({ hasFilters, onClearFilters }: { hasFilters: boolean; onClearFilters: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-2)]">
        {hasFilters
          ? <Filter size={20} className="text-[var(--text-muted)]" />
          : <CheckCircle2 size={20} className="text-emerald-400" />}
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)]">
        {hasFilters ? 'No actions match this view' : 'All caught up!'}
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        {hasFilters ? 'Adjust the view or clear filters to see more actions.' : 'OWL found no pending actions from Paperless-ngx.'}
      </p>
      {hasFilters && (
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
        >
          <X size={11} />
          Clear filters
        </button>
      )}
    </div>
  );
}
