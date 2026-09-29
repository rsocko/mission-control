'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEventHandler } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface SearchInputProps {
  /** Current search value. */
  value: string;
  /** Called on every keystroke. */
  onChange: (value: string) => void;
  /** Placeholder text. Default: "Search…" */
  placeholder?: string;
  /** Accessible name for the input. Defaults to the placeholder. */
  ariaLabel?: string;
  /** Optional input id. */
  id?: string;
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
  /** Additional input keydown handler. */
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  /** Visual size. Default: 'sm'. */
  size?: 'sm' | 'md';
  /** Extra className on the wrapper. */
  className?: string;
  /** Extra className on the input. */
  inputClassName?: string;
  /** Extra className on the search icon. */
  iconClassName?: string;
  /** Accessible label for the clear button. Default: "Clear search". */
  clearLabel?: string;
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
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  ariaLabel,
  id,
  autoFocus = false,
  loading = false,
  showClear = true,
  onEscape,
  onEnter,
  onKeyDown,
  size = 'sm',
  className,
  inputClassName,
  iconClassName,
  clearLabel = 'Clear search',
}, forwardedRef) {
  const inputRef = useRef<HTMLInputElement>(null);
  const config = SIZE_CONFIG[size];

  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;

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
        className={cn('shrink-0 text-[var(--text-muted)]', iconClassName)}
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={cn(
          'w-full bg-transparent text-[var(--text-primary)] outline-none shadow-none border-none placeholder:text-[var(--text-muted)]',
          config.input,
          inputClassName,
        )}
      />
      {loading && (
        <Loader2
          size={config.icon}
          className="shrink-0 animate-spin text-[var(--text-tertiary)]"
          aria-label="Searching"
        />
      )}
      {showClear && value && (
        <button
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
          className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors duration-75 hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label={clearLabel}
          type="button"
        >
          <X size={config.icon} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});
