'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Circle, Clock3, FileQuestion, FileText, FolderOpen, Globe, Image, Layers, LinkIcon, ListTodo, MessageCircle, Package, PlayCircle, Settings2, X, Box } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { CollapsibleSection } from '@/components/dashboard/CollapsibleSection';
import { ACTION_META, ACTION_TYPE_OPTIONS, CONTENT_TYPE_OPTIONS, SOURCE_OPTIONS, STATUS_OPTIONS, type Stats } from '@/components/triage/types';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';
import type { TriageActionType, TriageSourcePlatform, TriageStatus } from '@/types';
import type { InboxGroup } from '@/lib/inbox/items';

interface TriageFilterSidebarProps {
  stats: Stats;
  query: string;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  group: InboxGroup;
  onGroupChange: (value: InboxGroup) => void;
  groupCounts: Record<InboxGroup, number>;
  status: TriageStatus | 'all';
  onStatusChange: (value: TriageStatus | 'all') => void;
  source: TriageSourcePlatform | 'all';
  onSourceChange: (value: TriageSourcePlatform | 'all') => void;
  contentTypeFilter: string | null;
  onContentTypeChange: (value: string | null) => void;
  contentTypeCounts: Record<string, number>;
  actionTypeFilter: TriageActionType | null;
  onActionTypeChange: (value: TriageActionType | null) => void;
  actionTypeCounts: Record<string, number>;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  all: <Layers size={12} />,
  pending: <Circle size={8} className="text-amber-400" />,
  snoozed: <Clock3 size={12} className="text-sky-400" />,
  actioned: <Check size={12} className="text-emerald-400" />,
  dismissed: <X size={12} className="text-slate-400" />,
};

function getStatusCount(stats: Stats, value: string): number {
  switch (value) {
    case 'all': return stats.total;
    case 'pending': return stats.pending;
    case 'snoozed': return stats.snoozed;
    case 'actioned': return stats.actioned;
    case 'dismissed': return stats.dismissed;
    default: return 0;
  }
}

const CONTENT_TYPE_ICONS: Record<string, React.ReactNode> = {
  task: <ListTodo size={13} className="text-cyan-400" />,
  link: <LinkIcon size={13} className="text-blue-400" />,
  repo: <FolderOpen size={13} className="text-violet-400" />,
  model_3d: <Box size={13} className="text-amber-400" />,
  video: <PlayCircle size={13} className="text-red-400" />,
  article: <FileText size={13} className="text-indigo-400" />,
  image: <Image size={13} className="text-pink-400" />,
  text_post: <MessageCircle size={13} className="text-emerald-400" />,
  product: <Package size={13} className="text-orange-400" />,
  other: <FileQuestion size={13} className="text-slate-400" />,
};

const GROUP_OPTIONS: Array<{ value: InboxGroup; label: string; icon: React.ReactNode }> = [
  { value: 'all', label: 'All', icon: <Layers size={13} /> },
  { value: 'tasks', label: 'Tasks', icon: <ListTodo size={13} className="text-cyan-400" /> },
  { value: 'content', label: 'Content', icon: <FileText size={13} className="text-violet-400" /> },
];

function ContentTypeIcon({ type }: { type: string }) {
  return <span className="flex w-4 items-center justify-center shrink-0">{CONTENT_TYPE_ICONS[type] ?? <Globe size={13} />}</span>;
}

export default function TriageFilterSidebar(props: TriageFilterSidebarProps) {
  const {
    stats,
    query,
    onQueryChange,
    onRefresh,
    group,
    onGroupChange,
    groupCounts,
    status,
    onStatusChange,
    source,
    onSourceChange,
    contentTypeFilter,
    onContentTypeChange,
    contentTypeCounts,
    actionTypeFilter,
    onActionTypeChange,
    actionTypeCounts,
  } = props;

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <aside className="flex flex-col gap-0 overflow-y-auto">
      {/* Search */}
      <div className="mb-3 px-1">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onRefresh();
          }}
          placeholder="Search inbox…"
          className="h-9 w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface-0)] px-3 text-xs text-[var(--text-primary)] outline-none transition-colors"
        />
      </div>

      {/* Groups and content sources */}
      <CollapsibleSection
        title="Groups"
        collapsed={!!collapsedSections.sources}
        onToggle={() => toggle('sources')}
      >
        <div className="space-y-0.5 px-2 pb-2.5">
          {GROUP_OPTIONS.map((option) => {
            const isActive = group === option.value && source === 'all';
            return (
              <button
                key={option.value}
                type="button"
                aria-label={`${option.label} group (${groupCounts[option.value]})`}
                onClick={() => {
                  onGroupChange(option.value);
                  onSourceChange('all');
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                )}
              >
                <span className="flex w-4 shrink-0 items-center justify-center">{option.icon}</span>
                <span className="truncate">{option.label}</span>
                <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{groupCounts[option.value]}</span>
              </button>
            );
          })}

          <div className="px-2.5 pb-1 pt-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Content sources
          </div>
          {SOURCE_OPTIONS.filter((option) => option.value !== 'all').map((option) => {
            const isActive = group === 'content' && source === option.value;
            const count = stats.sourceCounts[option.value] ?? 0;
            if (count === 0) return null;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onGroupChange('content');
                  onSourceChange(option.value);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                )}
              >
                <TriageSourceIcon source={option.value} size={13} className="shrink-0" decorative />
                <span className="truncate">{option.label}</span>
                <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{count}</span>
              </button>
            );
          })}
        </div>
      </CollapsibleSection>

      {/* Status section */}
      <CollapsibleSection
        title="Status"
        collapsed={!!collapsedSections.status}
        onToggle={() => toggle('status')}
      >
        <div className="space-y-0.5 px-2 pb-2.5">
          {STATUS_OPTIONS.map((option) => {
            const isActive = status === option.value;
            const count = getStatusCount(stats, option.value);
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onStatusChange(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                )}
              >
                <span className="flex w-4 items-center justify-center shrink-0">
                  {STATUS_ICONS[option.value] ?? <Circle size={8} />}
                </span>
                <span>{option.label}</span>
                <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{count}</span>
              </button>
            );
          })}
        </div>
      </CollapsibleSection>

      {/* Content Type section */}
      <CollapsibleSection
        title="Content Type"
        collapsed={!!collapsedSections.contentType}
        onToggle={() => toggle('contentType')}
        headerActions={
          <Link
            href="/settings/content-types"
            className="p-1 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
            title="Manage content types"
          >
            <Settings2 size={12} />
          </Link>
        }
      >
        <div className="space-y-0.5 px-2 pb-2.5">
          <button
            type="button"
            onClick={() => onContentTypeChange(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-xs font-medium transition-colors',
              !contentTypeFilter
                ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
            )}
          >
            <Layers size={13} className="shrink-0" />
            <span>All types</span>
            <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{groupCounts.all}</span>
          </button>
          {CONTENT_TYPE_OPTIONS.filter((opt) => (contentTypeCounts[opt.value] ?? 0) > 0).map((option) => {
            const isActive = contentTypeFilter === option.value;
            const count = contentTypeCounts[option.value] ?? 0;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onContentTypeChange(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                )}
              >
                <ContentTypeIcon type={option.value} />
                <span className="truncate">{option.label}</span>
                <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{count}</span>
              </button>
            );
          })}
        </div>
      </CollapsibleSection>

      {/* Action Type section */}
      <CollapsibleSection
        title="Action Type"
        collapsed={!!collapsedSections.actionType}
        onToggle={() => toggle('actionType')}
      >
        <div className="space-y-0.5 px-2 pb-2.5">
          <button
            type="button"
            onClick={() => onActionTypeChange(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-xs font-medium transition-colors',
              !actionTypeFilter
                ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
            )}
          >
            <Layers size={13} className="shrink-0" />
            <span>All actions</span>
            <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{stats.total}</span>
          </button>
          {ACTION_TYPE_OPTIONS.filter((opt) => (actionTypeCounts[opt.value] ?? 0) > 0).map((option) => {
            const isActive = actionTypeFilter === option.value;
            const count = actionTypeCounts[option.value] ?? 0;
            const meta = ACTION_META[option.value];
            const Icon = meta?.icon;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onActionTypeChange(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                )}
              >
                <span className="flex w-4 items-center justify-center shrink-0">
                  {Icon ? <Icon size={13} /> : <Layers size={13} />}
                </span>
                <span className="truncate">{option.label}</span>
                <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">{count}</span>
              </button>
            );
          })}
        </div>
      </CollapsibleSection>
    </aside>
  );
}
