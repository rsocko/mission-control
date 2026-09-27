'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Search, Tag } from 'lucide-react';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { toast } from '@/lib/toast';

export interface BulkTagOption {
  id: string;
  name: string;
  slug: string;
  color: string | null;
}

function isBulkTagOption(value: unknown): value is BulkTagOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tag = value as Record<string, unknown>;
  return typeof tag.id === 'string'
    && typeof tag.name === 'string'
    && typeof tag.slug === 'string'
    && (typeof tag.color === 'string' || tag.color === null);
}

interface BulkTagDropdownProps {
  availableTags: BulkTagOption[];
  onAddTag: (tag: BulkTagOption) => Promise<void>;
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
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const selectableTags = availableTags.filter((tag) => !isSyntheticTag(tag.name));
  const normalizedSearch = search.trim();
  const filtered = normalizedSearch
    ? selectableTags.filter((tag) => tag.name.toLowerCase().includes(normalizedSearch.toLowerCase()))
    : selectableTags;
  const exactMatch = normalizedSearch
    ? selectableTags.find((tag) => tag.name.toLowerCase() === normalizedSearch.toLowerCase())
    : undefined;

  async function handleSelect(tag: BulkTagOption) {
    setApplying(true);
    setOpen(false);
    setSearch('');
    try {
      await onAddTag(tag);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add tag');
    } finally {
      setApplying(false);
    }
  }

  async function handleCreate() {
    if (!normalizedSearch || exactMatch) return;

    setApplying(true);
    try {
      const response = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: normalizedSearch }),
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = data && typeof data === 'object' && !Array.isArray(data)
          ? Object.getOwnPropertyDescriptor(data, 'error')?.value
          : undefined;
        throw new Error(typeof errorMessage === 'string' ? errorMessage : 'Failed to create tag');
      }
      if (!isBulkTagOption(data)) {
        throw new Error('The tag was created, but the server returned an invalid response');
      }

      setOpen(false);
      setSearch('');
      await onAddTag(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create tag');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen(!open);
          if (open) setSearch('');
        }}
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
            <div className="input-glow flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
              <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && normalizedSearch) {
                    e.preventDefault();
                    if (exactMatch) void handleSelect(exactMatch);
                    else void handleCreate();
                  }
                  if (e.key === 'Escape') {
                    setOpen(false);
                    setSearch('');
                  }
                }}
                placeholder="Search or create tag…"
                maxLength={100}
                className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          {filtered.length > 0 && (
            filtered.map((tag) => (
              <button
                key={tag.id}
                onClick={() => void handleSelect(tag)}
                disabled={applying}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
              >
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-slate-500"
                  style={tag.color ? { backgroundColor: tag.color } : undefined}
                />
                {tag.name}
              </button>
            ))
          )}
          {normalizedSearch && !exactMatch ? (
            <button
              onClick={() => void handleCreate()}
              disabled={applying}
              className="w-full text-left flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors duration-75 disabled:cursor-wait disabled:opacity-60"
            >
              <Plus size={12} className="shrink-0" />
              <span className="truncate">{applying ? 'Creating tag…' : `Create "${normalizedSearch}"`}</span>
            </button>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No tags found</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
