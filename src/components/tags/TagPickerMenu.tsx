'use client';

import * as Popover from '@radix-ui/react-popover';
import { Check, Loader2, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { getTagPillStyle } from '@/lib/constants/colors';
import { cn } from '@/lib/utils';

export interface TagPickerOption {
  id: string;
  name: string;
  slug?: string;
  color?: string | null;
}

interface TagPillProps {
  tag: TagPickerOption;
  selected?: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
}

export function TagPill({
  tag,
  selected = true,
  disabled = false,
  onToggle,
  onRemove,
}: TagPillProps) {
  return (
    <span
      className={cn(
        'inline-flex min-h-7 items-center rounded-full border text-xs font-medium transition-opacity',
        !selected && 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-muted)] opacity-70',
      )}
      style={selected ? getTagPillStyle(tag.color ?? null) : undefined}
    >
      {onToggle ? (
        <button
          type="button"
          data-suggestion-control
          data-enter-native
          aria-label={tag.name}
          aria-pressed={selected}
          disabled={disabled}
          onClick={onToggle}
          className="inline-flex min-h-7 items-center gap-1 rounded-l-full px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {selected && <Check size={11} aria-hidden="true" />}
          {tag.name}
        </button>
      ) : (
        <span className="px-2.5">{tag.name}</span>
      )}
      {onRemove && (
        <button
          type="button"
          data-suggestion-control
          data-enter-native
          aria-label={`Remove tag ${tag.name}`}
          disabled={disabled}
          onClick={onRemove}
          className="flex min-h-7 items-center rounded-r-full px-2 opacity-60 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed"
        >
          <X size={10} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

interface TagPickerMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: TagPickerOption[];
  selectedTagIds: string[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (tag: TagPickerOption) => void;
  allowCreate?: boolean;
  onCreate?: (name: string) => void;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
  triggerLabel?: ReactNode;
  triggerAriaLabel?: string;
  triggerClassName?: string;
  emptyLabel?: string;
  noMatchesLabel?: string;
  searchPlaceholder?: string;
}

export function TagPickerMenu({
  open,
  onOpenChange,
  tags,
  selectedTagIds,
  query,
  onQueryChange,
  onSelect,
  allowCreate = false,
  onCreate,
  loading = false,
  disabled = false,
  error,
  triggerLabel = 'Add',
  triggerAriaLabel = 'Add tag',
  triggerClassName,
  emptyLabel = 'No tags available',
  noMatchesLabel = 'No matching tags',
  searchPlaceholder,
}: TagPickerMenuProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const availableTags = tags.filter((tag) => (
    !selectedTagIds.includes(tag.id)
    && (!normalizedQuery || tag.name.toLocaleLowerCase().includes(normalizedQuery))
  ));
  const canCreate = allowCreate
    && Boolean(normalizedQuery)
    && !tags.some((tag) => tag.name.toLocaleLowerCase() === normalizedQuery);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    openRef.current = nextOpen;
    onOpenChange(nextOpen);
    if (!nextOpen) onQueryChange('');
  }, [onOpenChange, onQueryChange]);

  useEffect(() => {
    openRef.current = open;
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (!openRef.current) return;
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      handleOpenChange(false);
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [handleOpenChange, open]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-suggestion-control
          data-enter-native
          aria-label={triggerAriaLabel}
          disabled={disabled}
          className={cn(
            'flex min-h-7 items-center gap-1 rounded-full border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50',
            triggerClassName,
          )}
        >
          <Plus size={10} aria-hidden="true" />
          {triggerLabel}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          className="z-[220] w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--shadow-lg)]"
        >
          <div className="border-b border-[var(--border-subtle)] p-2">
            <div className="input-glow flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2">
              <Search size={12} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canCreate && onCreate) {
                    event.preventDefault();
                    onCreate(query.trim());
                  }
                }}
                placeholder={searchPlaceholder ?? (allowCreate ? 'Search or create tag…' : 'Search tags…')}
                aria-label="Search tags"
                className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear tag search"
                  onClick={() => onQueryChange('')}
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              )}
            </div>
            {error && <p className="px-1 pt-1.5 text-[11px] text-red-300">{error}</p>}
          </div>
          <div className="max-h-52 overflow-y-auto p-1">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" aria-label="Loading tags" />
              </div>
            ) : (
              <>
                {canCreate && onCreate && (
                  <button
                    type="button"
                    onClick={() => onCreate(query.trim())}
                    className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                  >
                    <Plus size={11} aria-hidden="true" />
                    Create &ldquo;{query.trim()}&rdquo;
                  </button>
                )}
                {availableTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => onSelect(tag)}
                    className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--text-muted)]"
                      style={tag.color ? { backgroundColor: tag.color } : undefined}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  </button>
                ))}
                {availableTags.length === 0 && !canCreate && (
                  <p className="px-2.5 py-3 text-xs text-[var(--text-muted)]">
                    {normalizedQuery ? noMatchesLabel : emptyLabel}
                  </p>
                )}
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
