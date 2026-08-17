'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Filter,
  Loader2,
  RefreshCw,
  CheckCircle2,
  Clock,
  CreditCard,
  PenLine,
  FolderOpen,
  CalendarPlus,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AgentAttribution } from '@/components/domains/AgentAttribution';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DiTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: string | null;
}

type ActionTypeFilter = 'all' | 'pay' | 'respond' | 'file' | 'review' | 'sign' | 'schedule';
type UrgencyFilter = 'all' | 'critical' | 'high' | 'medium' | 'low';

const ACTION_TYPE_META: Record<string, { label: string; icon: typeof FileText; color: string }> = {
  pay: { label: 'Pay', icon: CreditCard, color: 'text-green-400' },
  respond: { label: 'Respond', icon: PenLine, color: 'text-blue-400' },
  file: { label: 'File', icon: FolderOpen, color: 'text-amber-400' },
  review: { label: 'Review', icon: FileText, color: 'text-purple-400' },
  sign: { label: 'Sign', icon: PenLine, color: 'text-cyan-400' },
  schedule: { label: 'Schedule', icon: CalendarPlus, color: 'text-orange-400' },
};

const URGENCY_COLORS: Record<string, string> = {
  critical: 'text-rose-400 bg-rose-400/10 border-rose-400/30',
  high: 'text-orange-400 bg-orange-400/10 border-orange-400/30',
  medium: 'text-amber-300 bg-amber-300/10 border-amber-300/30',
  low: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
};

// ─── Page Component ─────────────────────────────────────────────────────────

export default function DocIntelligencePage() {
  const [tasks, setTasks] = useState<DiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [actionTypeFilter, setActionTypeFilter] = useState<ActionTypeFilter>('all');
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const taskSelection = useTaskSelection({
    selectedTaskId,
    onSelectionChange: setSelectedTaskId,
  });

  const fetchTasks = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await fetch('/api/tasks?source=document-intelligence&openOnly=true&sortBy=priority&sortDirection=asc&limit=200');
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch {
      toast.error('OWL could not load Paperless-ngx document actions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const filteredTasks = useMemo(() => {
    let result = tasks;

    if (actionTypeFilter !== 'all') {
      result = result.filter((t) => {
        const meta = t.metadata ? JSON.parse(t.metadata) : null;
        return meta?.actionType === actionTypeFilter;
      });
    }

    if (urgencyFilter !== 'all') {
      result = result.filter((t) => {
        const meta = t.metadata ? JSON.parse(t.metadata) : null;
        return meta?.urgency === urgencyFilter;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
      );
    }

    return result;
  }, [tasks, actionTypeFilter, urgencyFilter, searchQuery]);

  const actionTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      const meta = t.metadata ? JSON.parse(t.metadata) : null;
      const type = meta?.actionType || 'unknown';
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }, [tasks]);

  const handleTaskUpdate = useCallback(() => { fetchTasks(true); }, [fetchTasks]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <FileText size={20} className="text-indigo-400" />
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Docs</h1>
            <AgentAttribution agent="OWL" />
            <span className="text-xs font-medium text-[var(--text-muted)] bg-[var(--surface-2)] px-2 py-0.5 rounded-full">
              {filteredTasks.length} action{filteredTasks.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button
            onClick={() => fetchTasks(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] rounded-lg border border-[var(--border)] transition-colors duration-100"
          >
            <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          OWL turns Paperless-ngx document signals into actionable work while Paperless-ngx remains the system of record.
        </p>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[160px] max-w-[260px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="Search actions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none transition-colors"
            />
          </div>

          {/* Action type filter chips */}
          <div className="flex items-center gap-1">
            <Filter size={12} className="text-[var(--text-muted)] mr-1" />
            <FilterChip active={actionTypeFilter === 'all'} onClick={() => setActionTypeFilter('all')}>
              All
            </FilterChip>
            {Object.entries(ACTION_TYPE_META).map(([type, meta]) => (
              <FilterChip
                key={type}
                active={actionTypeFilter === type}
                onClick={() => setActionTypeFilter(type as ActionTypeFilter)}
                count={actionTypeCounts[type]}
              >
                {meta.label}
              </FilterChip>
            ))}
          </div>

          {/* Urgency filter */}
          <Select
            value={urgencyFilter}
            onValueChange={(value) => setUrgencyFilter(value as UrgencyFilter)}
          >
            <SelectTrigger variant="inline" aria-label="Filter by urgency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All urgency</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Master-Detail Layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Task List (Master) */}
        <div className={cn(
          'flex-1 overflow-y-auto border-r border-[var(--border)]',
          selectedTaskId ? 'hidden sm:block sm:w-[340px] sm:flex-none lg:w-[400px]' : 'w-full'
        )}>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
              <span className="ml-2 text-sm text-[var(--text-muted)]">OWL is loading Paperless-ngx actions...</span>
            </div>
          ) : filteredTasks.length === 0 ? (
            <EmptyState hasFilters={actionTypeFilter !== 'all' || urgencyFilter !== 'all' || !!searchQuery.trim()} />
          ) : (
            <div className="divide-y divide-[var(--border-subtle)]">
              {filteredTasks.map((task) => (
                <ActionRow
                  key={task.id}
                  task={task}
                  isSelected={task.id === selectedTaskId}
                  onClick={() => taskSelection.toggleTask(task.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {selectedTaskId && (
          <div className="flex-1 min-w-0 overflow-y-auto">
            <TaskDetailPanel
              taskId={selectedTaskId}
              onClose={() => setSelectedTaskId(null)}
              onUpdate={handleTaskUpdate}
              mode="panel"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

function FilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-full border transition-colors duration-100',
        active
          ? 'bg-[var(--accent)]/10 border-[var(--accent)]/40 text-[var(--accent-400)]'
          : 'bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
      )}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="text-[10px] opacity-70">{count}</span>
      )}
    </button>
  );
}

function ActionRow({ task, isSelected, onClick }: { task: DiTask; isSelected: boolean; onClick: () => void }) {
  const meta = task.metadata ? JSON.parse(task.metadata) : null;
  const actionType = meta?.actionType || 'review';
  const urgency = meta?.urgency || 'medium';
  const amount = meta?.amount;
  const correspondent = meta?.correspondent;
  const ActionIcon = ACTION_TYPE_META[actionType]?.icon || FileText;
  const actionColor = ACTION_TYPE_META[actionType]?.color || 'text-[var(--text-muted)]';

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3 transition-colors duration-75 group',
        isSelected
          ? 'ring-1 ring-inset ring-[var(--accent-400)] bg-[var(--accent-500)]/8 rounded-sm'
          : 'hover:bg-[var(--surface-2)]'
      )}
    >
      <div className="flex items-start gap-3">
        <ActionIcon size={15} className={cn('mt-0.5 flex-shrink-0', actionColor)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text-primary)] truncate">
              {task.title}
            </span>
            {amount != null && (
              <span className="flex-shrink-0 text-xs font-medium text-emerald-400 tabular-nums">
                ${typeof amount === 'number' ? amount.toFixed(2) : amount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={cn(
              'inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded border',
              URGENCY_COLORS[urgency] || 'text-[var(--text-muted)]'
            )}>
              {urgency}
            </span>
            {correspondent && (
              <span className="text-xs text-[var(--text-muted)] truncate">
                {correspondent}
              </span>
            )}
            {task.dueDate && (
              <span className="flex items-center gap-0.5 text-[10px] text-[var(--text-muted)]">
                <Clock size={10} />
                {new Date(task.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-12 h-12 rounded-full bg-[var(--surface-2)] flex items-center justify-center mb-3">
        {hasFilters ? <Filter size={20} className="text-[var(--text-muted)]" /> : <CheckCircle2 size={20} className="text-emerald-400" />}
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)]">
        {hasFilters ? 'No actions match filters' : 'All caught up!'}
      </p>
      <p className="text-xs text-[var(--text-muted)] mt-1">
        {hasFilters ? 'Try adjusting your filters to see more actions.' : 'OWL found no pending actions from Paperless-ngx.'}
      </p>
    </div>
  );
}
