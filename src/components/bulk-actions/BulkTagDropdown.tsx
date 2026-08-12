'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Tag } from 'lucide-react';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';

interface BulkTagDropdownProps {
  availableTags: Array<{ id: string; name: string; slug: string; color: string | null }>;
  onAddTag: (tagId: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

export function BulkTagDropdown({ availableTags, onAddTag, disabled = false, disabledReason }: BulkTagDropdownProps) {
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
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

  const filtered = search.length > 0
    ? availableTags.filter((t) => !isSyntheticTag(t.name) && t.name.toLowerCase().includes(search.toLowerCase()))
    : availableTags.filter((t) => !isSyntheticTag(t.name));

  function handleSelect(tagId: string) {
    setApplying(true);
    setOpen(false);
    onAddTag(tagId).finally(() => setApplying(false));
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="text-xs px-2 py-1 bg-cyan-900/30 text-cyan-300 border border-cyan-800/40 rounded-[var(--radius-sm)] hover:bg-cyan-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {applying ? 'Tagging…' : <><Tag size={12} className="inline" /> Tag</>}
      </button>
      {open && (
        <div role="listbox" aria-label="Add tag" className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] shadow-lg py-1 max-h-72 overflow-y-auto min-w-48">
          <div className="px-2 pb-1.5 pt-1 sticky top-0 bg-[var(--surface-1)]">
            <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
              <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tags…"
                className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          {filtered.length > 0 ? (
            filtered.map((tag) => (
              <button
                key={tag.id}
                onClick={() => handleSelect(tag.id)}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
              >
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-slate-500"
                  style={tag.color ? { backgroundColor: tag.color } : undefined}
                />
                {tag.name}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No tags found</div>
          )}
        </div>
      )}
    </div>
  );
}
