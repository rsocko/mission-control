'use client';

import { useEffect, useRef } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface SearchInputProps {
  /** Current search value. */
  value: string;
  /** Called on every keystroke. */
  onChange: (value: string) => void;
  /** Placeholder text. Default: "Search…" */
  placeholder?: string;
  /** Auto-focus the input on mount. */
  autoFocus?: boolean;
  /** Show a loading spinner. */
  loading?: boolean;
  /** Show a clear (X) button when value is non-empty. Default: true. */
  showClear?: boolean;
  /** Called when Escape is pressed. */
  onEscape?: () => void;
  /** Called when Enter is pressed. */
  onEnter?: (value: string) => void;
  /** Visual size. Default: 'sm'. */
  size?: 'sm' | 'md';
  /** Extra className on the wrapper. */
  className?: string;
}

const SIZE_CONFIG = {
  sm: {
    wrapper: 'gap-1.5 px-2 py-1 rounded-md',
    icon: 12,
    input: 'text-xs',
  },
  md: {
    wrapper: 'gap-2 px-3 py-2 rounded-xl',
    icon: 14,
    input: 'text-sm',
  },
} as const;

/**
 * Search input with icon, optional clear button, and loading spinner.
 *
 * Matches the existing inline search pattern:
 * `flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)]`
 *
 * @example
 * <SearchInput
 *   value={query}
 *   onChange={setQuery}
 *   placeholder="Search or create tag…"
 *   autoFocus
 *   onEscape={() => setOpen(false)}
 *   onEnter={(val) => handleAdd(val)}
 * />
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  autoFocus = false,
  loading = false,
  showClear = true,
  onEscape,
  onEnter,
  size = 'sm',
  className,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const config = SIZE_CONFIG[size];

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onEscape?.();
    }
    if (e.key === 'Enter' && value.trim()) {
      e.preventDefault();
      onEnter?.(value.trim());
    }
  };

  return (
    <div
      className={cn(
        'flex items-center border border-[var(--border)] bg-[var(--surface-0)] input-glow transition-[border-color,box-shadow] duration-150',
        config.wrapper,
        className,
      )}
    >
      <Search
        size={config.icon}
        className="shrink-0 text-[var(--text-muted)]"
      />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          'w-full bg-transparent text-[var(--text-primary)] outline-none shadow-none border-none placeholder:text-[var(--text-muted)]',
          config.input,
        )}
      />
      {loading && (
        <Loader2
          size={config.icon}
          className="shrink-0 animate-spin text-[var(--text-tertiary)]"
        />
      )}
      {showClear && value && !loading && (
        <button
          onClick={() => onChange('')}
          className="shrink-0 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-75"
          aria-label="Clear search"
          type="button"
        >
          <X size={config.icon} />
        </button>
      )}
    </div>
  );
}
