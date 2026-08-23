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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const hasFilter = !!(filter.source || filter.sourceList);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/tasks/quick-sort?sources=true', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load sources');
        return response.json();
      })
      .then((data) => setSources(data.sources ?? {}))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, []);

  const toggleDropdown = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) return;
    setSearchQuery('');
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

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

  const toggleSource = (connectorType: string) => {
    setExpandedSources((current) => {
      const next = new Set(current);
      if (next.has(connectorType)) next.delete(connectorType);
      else next.add(connectorType);
      return next;
    });
  };

  const filteredSources = sources
    ? Object.entries(sources).filter(([connectorType, data]) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        const label = (SOURCE_LABELS[connectorType] ?? connectorType).toLowerCase();
        if (label.includes(q)) return true;
        return data.lists.some((list) => list.name.toLowerCase().includes(q));
      })
    : [];

  return (
    <div className="px-4 mb-4" ref={panelRef}>
      <div
        className={cn(
          'flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm transition-colors',
          hasFilter
            ? 'border-[var(--accent-400)]/40 bg-[var(--accent-400)]/10 text-[var(--accent-400)]'
            : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-tertiary)]'
        )}
      >
        <Filter size={14} />
        <button
          type="button"
          onClick={toggleDropdown}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          aria-controls="quick-sort-source-options"
        >
          <span className="flex-1 truncate">
            {hasFilter
              ? `${SOURCE_LABELS[filter.source!] ?? filter.source}${filter.sourceList ? ` / ${filter.sourceList}` : ''}`
              : 'All sources'}
          </span>
          <ChevronDown size={14} className={cn('flex-shrink-0 transition-transform', expanded && 'rotate-180')} />
        </button>
        {hasFilter && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clearFilter(); }}
            className="flex min-h-11 min-w-11 items-center justify-center rounded hover:bg-[var(--surface-3)]"
            aria-label="Clear source filter"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {expanded && (
        <div
          id="quick-sort-source-options"
          className="mt-2 flex max-h-[60vh] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
        >
          <div className="input-glow flex items-center gap-2 px-3 py-3 border-b border-[var(--border-subtle)] flex-shrink-0 bg-[var(--surface-2)]">
            <Search size={14} className="text-[var(--text-tertiary)] flex-shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sources and lists…"
              aria-label="Search sources and lists"
              className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none min-w-0"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center text-[var(--text-tertiary)]"
                aria-label="Clear source search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="overflow-y-auto overscroll-contain">
            {loading && (
              <div className="px-4 py-4 text-sm text-[var(--text-muted)]">Loading sources…</div>
            )}
            {!loading && loadError && (
              <div className="px-4 py-4 text-sm text-[var(--text-muted)]">Could not load sources</div>
            )}
            {!loading && sources && Object.keys(sources).length === 0 && (
              <div className="px-4 py-4 text-sm text-[var(--text-muted)]">No sources found</div>
            )}
            {!loading && sources && filteredSources.length === 0 && searchQuery && (
              <div className="px-4 py-4 text-sm text-[var(--text-muted)]">No sources match &ldquo;{searchQuery}&rdquo;</div>
            )}
            {!loading && sources && (
              <div className="py-1">
                {!searchQuery.trim() && (
                  <button
                    type="button"
                    onClick={() => { clearFilter(); setExpanded(false); }}
                    className={cn(
                      'min-h-11 w-full px-4 text-left text-sm transition-colors hover:bg-[var(--surface-2)] active:bg-[var(--surface-3)]',
                      !hasFilter ? 'text-[var(--accent-400)] font-medium' : 'text-[var(--text-secondary)]'
                    )}
                  >
                    All sources
                  </button>
                )}

                {filteredSources.map(([connectorType, data]) => {
                  const q = searchQuery.toLowerCase();
                  const sourceLabel = SOURCE_LABELS[connectorType] ?? connectorType;
                  const filteredLists = searchQuery.trim()
                    ? data.lists.filter((list) => list.name.toLowerCase().includes(q) || sourceLabel.toLowerCase().includes(q))
                    : data.lists;
                  const listsExpanded = searchQuery.trim() !== '' || expandedSources.has(connectorType);

                  return (
                    <div key={connectorType} className="border-t border-[var(--border-subtle)] first:border-t-0">
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() => selectSource(connectorType)}
                          className={cn(
                            'min-h-11 min-w-0 flex-1 px-4 text-left text-sm font-medium transition-colors hover:bg-[var(--surface-2)] active:bg-[var(--surface-3)]',
                            filter.source === connectorType && !filter.sourceList
                              ? 'text-[var(--accent-400)]'
                              : 'text-[var(--text-primary)]'
                          )}
                        >
                          {sourceLabel}
                        </button>
                        {data.lists.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleSource(connectorType)}
                            className="flex min-h-11 min-w-11 items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
                            aria-label={`${listsExpanded ? 'Collapse' : 'Expand'} ${sourceLabel} lists`}
                            aria-expanded={listsExpanded}
                          >
                            <ChevronDown size={14} className={cn('transition-transform', listsExpanded && 'rotate-180')} />
                          </button>
                        )}
                      </div>
                      {listsExpanded && filteredLists.length > 0 && (
                        <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-2)] py-1 pl-3">
                          {filteredLists.map((list) => (
                            <button
                              type="button"
                              key={list.name}
                              onClick={() => selectList(connectorType, list.name)}
                              className={cn(
                                'min-h-11 w-full rounded-lg px-3 text-left text-sm transition-colors hover:bg-[var(--surface-3)]',
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
