'use client';

import React from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleHelp,
  Globe,
  Lock,
  Tag as TagIcon,
} from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { SidebarNavItem } from '@/components/sidebar/SidebarNavItem';
import { ConnectorBrandIcon } from '../ConnectorBrandIcon';
import type { ReviewTag, SourceListInfo } from './types';

interface TagReviewFiltersProps {
  connectorTypeLabel: (source: string) => string;
  expandedSources: Set<string>;
  listsByType: Map<string, SourceListInfo[]>;
  onExpandedSourcesChange: (sources: Set<string>) => void;
  onScopeChange: (scope: string) => void;
  scopeFilter: string;
  sources: string[];
  systemTags: ReviewTag[];
  userTags: ReviewTag[];
}

export function TagReviewFilters({
  connectorTypeLabel,
  expandedSources,
  listsByType,
  onExpandedSourcesChange,
  onScopeChange,
  scopeFilter,
  sources,
  systemTags,
  userTags,
}: TagReviewFiltersProps) {
  const toggleSource = (source: string) => {
    const next = new Set(expandedSources);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    onExpandedSourcesChange(next);
  };

  return (
    <aside aria-label="Filter tags by source" className="w-48 flex-shrink-0 overflow-y-auto overflow-x-hidden border-r border-[var(--border)] p-4 sm:w-56 xl:w-64">
      <div className="mb-2 flex items-center gap-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Sources</p>
        <Tooltip content="Choose where a tag is used. Connector rows include every list or repository for that source.">
          <button type="button" aria-label="About source scope" className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
            <CircleHelp size={11} />
          </button>
        </Tooltip>
      </div>
      <div className="space-y-1">
        <SidebarNavItem
          icon={<Globe size={14} className="text-blue-400" />}
          label="All Sources"
          count={userTags.length}
          active={scopeFilter === 'all'}
          onClick={() => onScopeChange('all')}
          showZeroCount
        />
        {sources.map(source => {
          const sourceLists = listsByType.get(source) ?? [];
          const isExpanded = expandedSources.has(source);
          const activeSourceList = scopeFilter.startsWith('list:')
            ? sourceLists.find(sourceList => `list:${sourceList.id}` === scopeFilter)
            : undefined;
          const hasHiddenActiveList = !!activeSourceList && !isExpanded;
          const sourceTagCount = userTags.filter(tag => {
            const tagSources = tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : []);
            return tagSources.includes(source);
          }).length;

          return (
            <React.Fragment key={source}>
              <SidebarNavItem
                icon={<ConnectorBrandIcon type={source} size={14} />}
                label={connectorTypeLabel(source)}
                count={sourceTagCount}
                active={scopeFilter === source}
                showZeroCount
                suffix={hasHiddenActiveList ? (
                  <span
                    className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]"
                    title={`${activeSourceList.name} is still filtering tags`}
                  />
                ) : undefined}
                onClick={() => {
                  onScopeChange(source);
                  if (sourceLists.length > 0) {
                    onExpandedSourcesChange(new Set(expandedSources).add(source));
                  }
                }}
                action={sourceLists.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggleSource(source)}
                    className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                    aria-label={isExpanded ? `Collapse ${connectorTypeLabel(source)} lists` : `Expand ${connectorTypeLabel(source)} lists`}
                    aria-expanded={isExpanded}
                    title={isExpanded ? 'Collapse lists' : 'Expand lists'}
                  >
                    {isExpanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
                  </button>
                ) : undefined}
              />
              {isExpanded && sourceLists.map(sourceList => (
                <button
                  key={sourceList.id}
                  type="button"
                  onClick={() => onScopeChange(`list:${sourceList.id}`)}
                  className={`grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md py-1.5 pl-7 pr-2.5 text-[11px] transition-colors ${
                    scopeFilter === `list:${sourceList.id}`
                      ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <ChevronRight size={9} className="opacity-40 flex-shrink-0" />
                  <span className="truncate text-left">{sourceList.name}</span>
                  <span className="text-[10px] tabular-nums text-[var(--text-muted)]">
                    {userTags.filter(tag => tag.listUsage?.some(usage =>
                      usage.connectorInstanceId === sourceList.connectorInstanceId
                      && usage.sourceListId === sourceList.sourceId
                    )).length}
                  </span>
                </button>
              ))}
            </React.Fragment>
          );
        })}
        <SidebarNavItem
          icon={<TagIcon size={14} />}
          label="Hub / Local"
          count={userTags.filter(tag => !tag.sources?.length && !tag.source).length}
          active={scopeFilter === 'local'}
          onClick={() => onScopeChange('local')}
          showZeroCount
        />
      </div>
      {systemTags.length > 0 && (
        <div className="mt-5 pt-4 border-t border-[var(--border)]">
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2 px-2">System Tags</p>
          <div className="space-y-1">
            {systemTags.map(tag => (
              <div key={tag.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Lock size={9} className="text-[var(--text-muted)] opacity-50 flex-shrink-0" />
                  <span className="truncate">{tag.name}</span>
                </span>
                <span className="text-[10px] tabular-nums flex-shrink-0">{tag.usageCount}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
