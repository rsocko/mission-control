'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Filter, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { QuickSortScopeFilter } from '@/lib/hooks/useQuickSortData';

const SOURCE_LABELS: Record<string, string> = {
  'microsoft-todo': 'Microsoft To Do',
  'ms-todo': 'Microsoft To Do',
  'github-issues': 'GitHub Issues',
  local: 'Local',
  'google-tasks': 'Google Tasks',
  jira: 'Jira',
  linear: 'Linear',
  asana: 'Asana',
  notion: 'Notion',
};

interface SourceData {
  [connectorType: string]: {
    connectorId: string;
    lists: Array<{ name: string; count: number }>;
  };
}

interface ScopeFilterProps {
  filter: QuickSortScopeFilter;
  onChange: (filter: QuickSortScopeFilter) => void;
}

export default function ScopeFilter({ filter, onChange }: ScopeFilterProps) {
  const [expanded, setExpanded] = useState(false);
  const [sources, setSources] = useState<SourceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const hasFilter = !!(filter.source || filter.sourceList);

  // Fetch sources eagerly so chip row renders on mount
  useEffect(() => {
    if (!sources) {
      setLoading(true);
      fetch('/api/tasks/quick-sort?sources=true')
        .then((r) => r.json())
        .then((data) => setSources(data.sources ?? {}))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [sources]);

  useEffect(() => {
    if (expanded) {
      setSearchQuery('');
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [expanded]);

  // Close on outside click/touch
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [expanded]);

  const clearFilter = () => {
    onChange({});
    setExpanded(false);
  };

  const selectSource = (connectorType: string) => {
    onChange({ source: connectorType });
    setExpanded(false);
  };

  const selectList = (connectorType: string, listName: string) => {
    onChange({ source: connectorType, sourceList: listName });
    setExpanded(false);
  };

  // Filter sources and lists by search query
  const filteredSources = sources
    ? Object.entries(sources).filter(([connectorType, data]) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        const label = (SOURCE_LABELS[connectorType] ?? connectorType).toLowerCase();
        if (label.includes(q)) return true;
        return data.lists.some((list) => list.name.toLowerCase().includes(q));
      })
    : [];

  // Source chip keys for top-level quick filter
  const sourceKeys = sources ? Object.keys(sources) : [];

  return (
    <div className="px-4 mb-4" ref={panelRef}>
      {/* Source chips row — quick top-level filter */}
      {sourceKeys.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-3 mb-3 border-b border-[var(--border-subtle)] scrollbar-none">
          <button
            onClick={() => onChange({})}
            className={cn(
              'flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              !filter.source
                ? 'bg-[var(--accent-400)] text-white'
                : 'bg-[var(--surface-3)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
            )}
          >
            All
          </button>
          {sourceKeys.map((key) => (
            <button
              key={key}
              onClick={() => {
                if (filter.source === key && !filter.sourceList) {
                  onChange({});
                } else {
                  onChange({ source: key });
                }
              }}
              className={cn(
                'flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                filter.source === key
                  ? 'bg-[var(--accent-400)] text-white'
                  : 'bg-[var(--surface-3)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
              )}
            >
              {SOURCE_LABELS[key] ?? key}
            </button>
          ))}
        </div>
      )}

      {/* Filter toggle — list picker */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex items-center gap-2 text-sm py-2.5 px-3 rounded-lg border transition-colors w-full',
          hasFilter
            ? 'border-[var(--accent-400)]/40 bg-[var(--accent-400)]/10 text-[var(--accent-400)]'
            : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-tertiary)]'
        )}
      >
        <Filter size={14} />
        <span className="flex-1 text-left truncate">
          {hasFilter
            ? `${SOURCE_LABELS[filter.source!] ?? filter.source}${filter.sourceList ? ` → ${filter.sourceList}` : ''}`
            : 'All sources'}
        </span>
        {hasFilter ? (
          <button
            onClick={(e) => { e.stopPropagation(); clearFilter(); }}
            className="p-1 rounded hover:bg-[var(--surface-3)]"
          >
            <X size={14} />
          </button>
        ) : (
          <ChevronDown size={14} className={cn('transition-transform flex-shrink-0', expanded && 'rotate-180')} />
        )}
      </button>

      {/* Dropdown */}
      {expanded && (
        <div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden flex flex-col max-h-[60vh]">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-3 border-b border-[var(--border-subtle)] flex-shrink-0 bg-[var(--surface-2)]">
            <Search size={14} className="text-[var(--text-tertiary)] flex-shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sources…"
              className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none min-w-0"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="p-1 text-[var(--text-tertiary)] flex-shrink-0">
                <X size={14} />
              </button>
            )}
          </div>

          {/* Scrollable list */}
          <div className="overflow-y-auto overscroll-contain">
            {loading && (
              <div className="px-4 py-4 text-sm text-[var(--text-muted)]">Loading sources…</div>
            )}
            {!loading && sources && Object.keys(sources).length === 0 && (
              <div className="px-4 py-4 text-sm text-[var(--text-muted)]">No sources found</div>
            )}
            {!loading && sources && filteredSources.length === 0 && searchQuery && (
              <div className="px-4 py-4 text-sm text-[var(--text-muted)]">No sources match &ldquo;{searchQuery}&rdquo;</div>
            )}
            {!loading && sources && (
              <div className="py-1">
                {/* "All sources" option (only when not searching) */}
                {!searchQuery.trim() && (
                  <button
                    onClick={() => { clearFilter(); setExpanded(false); }}
                    className={cn(
                      'w-full text-left px-4 py-3 text-sm transition-colors active:bg-[var(--surface-3)]',
                      !hasFilter ? 'text-[var(--accent-400)] font-medium' : 'text-[var(--text-secondary)]'
                    )}
                  >
                    All sources
                  </button>
                )}

                {filteredSources.map(([connectorType, data]) => {
                  const q = searchQuery.toLowerCase();
                  const filteredLists = searchQuery.trim()
                    ? data.lists.filter((list) => list.name.toLowerCase().includes(q) || (SOURCE_LABELS[connectorType] ?? connectorType).toLowerCase().includes(q))
                    : data.lists;

                  return (
                    <div key={connectorType}>
                      <button
                        onClick={() => selectSource(connectorType)}
                        className={cn(
                          'w-full text-left px-4 py-3 text-sm font-medium transition-colors active:bg-[var(--surface-3)]',
                          filter.source === connectorType && !filter.sourceList
                            ? 'text-[var(--accent-400)]'
                            : 'text-[var(--text-primary)]'
                        )}
                      >
                        {SOURCE_LABELS[connectorType] ?? connectorType}
                      </button>
                      {filteredLists.length > 0 && (
                        <div className="pl-4 pb-1">
                          {filteredLists.map((list) => (
                            <button
                              key={list.name}
                              onClick={() => selectList(connectorType, list.name)}
                              className={cn(
                                'w-full text-left px-3 py-3 text-sm rounded-lg transition-colors active:bg-[var(--surface-3)]',
                                filter.source === connectorType && filter.sourceList === list.name
                                  ? 'text-[var(--accent-400)] font-medium'
                                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                              )}
                            >
                              {list.name}
                              <span className="ml-1.5 opacity-50">({list.count})</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
