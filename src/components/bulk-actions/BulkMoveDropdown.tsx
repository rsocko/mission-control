'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock, Search } from 'lucide-react';

const RECENT_MOVE_TARGETS_KEY = 'mission-control:recent-move-targets';
const MAX_RECENT = 5;

function getRecentMoveTargets(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_MOVE_TARGETS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function saveRecentMoveTarget(id: string) {
  const recent = getRecentMoveTargets().filter((r) => r !== id);
  recent.unshift(id);
  localStorage.setItem(RECENT_MOVE_TARGETS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

interface BulkMoveDropdownProps {
  sourceLists: Array<{ id: string; sourceId: string; name: string }>;
  onMove: (targetListId: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

export function BulkMoveDropdown({ sourceLists, onMove, disabled = false, disabledReason }: BulkMoveDropdownProps) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else setSearch('');
  }, [open]);

  const recentIds = getRecentMoveTargets();
  const isSearching = search.length > 0;

  const searchResults = isSearching
    ? sourceLists.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
    : [];

  const recentLists = !isSearching
    ? recentIds.map((id) => sourceLists.find((l) => l.sourceId === id)).filter(Boolean) as typeof sourceLists
    : [];
  const restLists = !isSearching
    ? sourceLists.filter((l) => !recentIds.includes(l.sourceId))
    : [];

  function handleSelect(list: { id: string; sourceId: string }) {
    saveRecentMoveTarget(list.sourceId);
    setMoving(true);
    setOpen(false);
    onMove(list.id).finally(() => setMoving(false));
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="text-xs px-2 py-1 bg-purple-900/30 text-purple-300 border border-purple-800/40 rounded-[var(--radius-sm)] hover:bg-purple-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {moving ? 'Moving…' : 'Move to list'}
      </button>
      {open && (
        <div role="listbox" aria-label="Move to list" className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] shadow-lg py-1 max-h-72 overflow-y-auto min-w-52">
          <div className="px-2 pb-1.5 pt-1 sticky top-0 bg-[var(--surface-1)]">
            <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
              <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search lists…"
                className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          {isSearching ? (
            <>
              {searchResults.map((list) => (
                <button
                  key={list.sourceId}
                  onClick={() => handleSelect(list)}
                  className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
                >
                  {list.name}
                </button>
              ))}
              {searchResults.length === 0 && (
                <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No lists found</div>
              )}
            </>
          ) : (
            <>
              {recentLists.length > 0 && (
                <>
                  {recentLists.map((list) => (
                    <button
                      key={list.sourceId}
                      onClick={() => handleSelect(list)}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
                    >
                      <Clock size={11} className="shrink-0 text-[var(--text-muted)]" />
                      {list.name}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-[var(--border-subtle)]" />
                </>
              )}
              {restLists.map((list) => (
                <button
                  key={list.sourceId}
                  onClick={() => handleSelect(list)}
                  className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
                >
                  {list.name}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
