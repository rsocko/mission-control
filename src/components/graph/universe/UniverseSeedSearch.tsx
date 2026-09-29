'use client';

import { useEffect, useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/SearchInput';
import { useProgressiveSearch } from '@/lib/hooks/useProgressiveSearch';

const MAX_SEEDS = 10;

export function UniverseSeedSearch({
  onExplore,
  onExploreAll,
}: {
  onExplore: (taskIds: string[]) => void;
  onExploreAll: () => void;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const {
    results,
    note,
    keywordLoading,
    semanticLoading,
    semanticEnabled,
    semanticAvailable,
  } = useProgressiveSearch({
    query: debouncedQuery,
    enabled: true,
    type: 'tasks',
    limit: 20,
    universeEligible: true,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 100);
    return () => window.clearTimeout(timer);
  }, [query]);

  const taskResults = useMemo(
    () => results.filter((result) => result.type === 'task'),
    [results],
  );

  const toggleTask = (taskId: string) => {
    setSelectedTaskIds((current) => {
      if (current.includes(taskId)) return current.filter((id) => id !== taskId);
      if (current.length >= MAX_SEEDS) return current;
      return [...current, taskId];
    });
  };

  return (
    <section className="w-full max-w-2xl rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-1)] p-4 shadow-2xl sm:p-6">
      <div className="flex items-start gap-3 text-left">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-500)]/15 text-[var(--accent-400)]">
          <Network size={18} aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Choose a task universe</h2>
          <p className="mt-1 max-w-[65ch] text-xs leading-5 text-[var(--text-secondary)]">
            Search tasks, choose up to {MAX_SEEDS} seeds, then load only their bounded neighborhood.
          </p>
        </div>
      </div>

      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search by title, concept, or identifier"
        ariaLabel="Search tasks to seed the Universe"
        clearLabel="Clear Universe seed search"
        loading={keywordLoading || semanticLoading}
        size="md"
        className="mt-5 h-11"
        inputClassName="min-w-0"
        iconClassName="text-[var(--text-tertiary)]"
      />

      {query.trim() ? (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-1">
          {taskResults.length ? (
            <ul aria-label="Universe seed search results">
              {taskResults.map((result) => {
                const selected = selectedTaskIds.includes(result.id);
                const atLimit = !selected && selectedTaskIds.length >= MAX_SEEDS;
                return (
                  <li key={result.id}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-3 py-2 hover:bg-[var(--surface-2)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent-400)]">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={atLimit}
                        onChange={() => toggleTask(result.id)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                          {result.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">
                          {result.source === 'semantic' ? 'Related match' : result.source === 'hybrid' ? 'Keyword + related match' : 'Keyword match'}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : keywordLoading ? null : (
            <p className="px-3 py-5 text-center text-xs text-[var(--text-secondary)]">
              No matching tasks. Try fewer words or a task identifier.
            </p>
          )}
        </div>
      ) : null}

      {note && semanticEnabled && !semanticAvailable ? (
        <p role="status" className="mt-3 text-xs text-amber-200">
          {note} Keyword results remain available.
        </p>
      ) : null}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onExploreAll}
          className="min-h-10 rounded-lg px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
        >
          Explore all tasks
        </button>
        <Button
          disabled={selectedTaskIds.length === 0}
          onClick={() => onExplore(selectedTaskIds)}
          className="min-h-10"
        >
          Explore {selectedTaskIds.length || ''} selected task{selectedTaskIds.length === 1 ? '' : 's'}
        </Button>
      </div>
    </section>
  );
}
