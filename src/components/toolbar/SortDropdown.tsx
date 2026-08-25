'use client';

import { useState, useEffect, useRef } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

export interface SortOption {
  value: string;
  label: string;
  supportsDirection?: boolean;
}

export const DEFAULT_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'planningHorizon', label: 'Planning Horizon' },
  { value: 'effort', label: 'Effort' },
  { value: 'smartScore', label: 'Smart Score' },
  { value: 'dueDate', label: 'Due Date' },
  { value: 'createdAt', label: 'Created Date' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'title', label: 'Alphabetical' },
  { value: 'sourceList', label: 'Source List' },
] as const;

const STORAGE_KEY = 'mission-control:sort-by';
const DIRECTION_KEY = 'mission-control:sort-direction';

interface SortDropdownProps {
  options?: readonly SortOption[];
  value?: string;
  direction?: 'asc' | 'desc';
  onChange?: (sortBy: string, direction: 'asc' | 'desc') => void;
}

export function SortDropdown({
  options = DEFAULT_SORT_OPTIONS,
  value,
  direction: controlledDirection,
  onChange,
}: SortDropdownProps = {}) {
  const [open, setOpen] = useState(false);
  const [internalSortBy, setInternalSortBy] = useState('priority');
  const [internalDirection, setInternalDirection] = useState<'asc' | 'desc'>('asc');
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sortBy = value ?? internalSortBy;
  const direction = controlledDirection ?? internalDirection;

  useEffect(() => {
    if (value === undefined) {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setInternalSortBy(stored);
    }
    if (controlledDirection === undefined) {
      const storedDir = localStorage.getItem(DIRECTION_KEY);
      if (storedDir === 'asc' || storedDir === 'desc') setInternalDirection(storedDir);
    }
  }, [controlledDirection, value]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items) return;
    const current = Array.from(items).findIndex(el => el === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[current < items.length - 1 ? current + 1 : 0]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[current > 0 ? current - 1 : items.length - 1]?.focus();
    }
  };

  const dispatchChange = (sort: string, dir: 'asc' | 'desc') => {
    if (onChange) {
      onChange(sort, dir);
    } else {
      window.dispatchEvent(new CustomEvent('mission-control:sort-change', { detail: { sortBy: sort, direction: dir } }));
    }
  };

  const handleSelect = (nextSortBy: string) => {
    if (value === undefined) {
      setInternalSortBy(nextSortBy);
      localStorage.setItem(STORAGE_KEY, nextSortBy);
    }
    setOpen(false);
    dispatchChange(nextSortBy, direction);
  };

  const toggleDirection = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newDir = direction === 'asc' ? 'desc' : 'asc';
    if (controlledDirection === undefined) {
      setInternalDirection(newDir);
      localStorage.setItem(DIRECTION_KEY, newDir);
    }
    dispatchChange(sortBy, newDir);
  };

  const currentOption = options.find((option) => option.value === sortBy) ?? options[0];
  const currentLabel = currentOption?.label || 'Priority';
  const supportsDirection = currentOption?.supportsDirection !== false;
  const DirectionIcon = direction === 'asc' ? ArrowUp : ArrowDown;

  return (
    <div ref={ref} className="relative" onKeyDown={handleKeyDown}>
      <div className="flex items-center">
        {/* Sort field selector */}
        <button
          onClick={() => setOpen(!open)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Sort by: ${currentLabel}`}
          className={`flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border)] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-0)] ${supportsDirection ? 'rounded-l-[var(--radius-md)] border-r-0' : 'rounded-[var(--radius-md)]'}`}
        >
          <ArrowUpDown size={13} />
          <span className="hidden lg:inline">{currentLabel}</span>
        </button>
        {/* Direction toggle */}
        {supportsDirection && (
          <button
            onClick={toggleDirection}
            aria-label={`Sort direction: ${direction === 'asc' ? 'ascending' : 'descending'}`}
            title={direction === 'asc' ? 'Ascending' : 'Descending'}
            className="flex items-center px-1.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border)] rounded-r-[var(--radius-md)] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-0)]"
          >
            <DirectionIcon size={13} />
          </button>
        )}
      </div>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Sort options"
          className="absolute right-0 top-full mt-1 z-50 w-44 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-md)] shadow-[var(--shadow-lg)] py-1"
        >
          {options.map((option) => (
            <button
              key={option.value}
              role="menuitem"
              aria-current={sortBy === option.value ? 'true' : undefined}
              onClick={() => handleSelect(option.value)}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors duration-75 focus-visible:bg-[var(--surface-3)] focus-visible:outline-none ${
                sortBy === option.value
                  ? 'text-[var(--text-primary)] bg-[var(--surface-3)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
