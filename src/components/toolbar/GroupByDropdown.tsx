'use client';

import { useState, useEffect, useRef } from 'react';
import { Layers } from 'lucide-react';

export interface GroupOption {
  value: string;
  label: string;
}

export const DEFAULT_GROUP_OPTIONS: readonly GroupOption[] = [
  { value: 'none', label: 'None' },
  { value: 'source', label: 'Source' },
  { value: 'list', label: 'List' },
  { value: 'status', label: 'Status' },
  { value: 'tag', label: 'Tag' },
  { value: 'priority', label: 'Priority' },
  { value: 'planningHorizon', label: 'Horizon' },
  { value: 'effort', label: 'Effort' },
  { value: 'dueDate', label: 'Due Date' },
  { value: 'project', label: 'Project + Phase' },
] as const;

const STORAGE_KEY = 'mission-control:group-by';

interface GroupByDropdownProps {
  options?: readonly GroupOption[];
  value?: string;
  onChange?: (groupBy: string) => void;
}

export function GroupByDropdown({
  options = DEFAULT_GROUP_OPTIONS,
  value,
  onChange,
}: GroupByDropdownProps = {}) {
  const [open, setOpen] = useState(false);
  const [internalGroupBy, setInternalGroupBy] = useState('none');
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const groupBy = value ?? internalGroupBy;

  useEffect(() => {
    if (value !== undefined) return;
    const restoreFrame = requestAnimationFrame(() => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setInternalGroupBy(stored);
    });
    return () => cancelAnimationFrame(restoreFrame);
  }, [value]);

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

  const handleSelect = (nextGroupBy: string) => {
    if (value === undefined) {
      setInternalGroupBy(nextGroupBy);
      localStorage.setItem(STORAGE_KEY, nextGroupBy);
    }
    setOpen(false);
    if (onChange) {
      onChange(nextGroupBy);
    } else {
      window.dispatchEvent(new CustomEvent('mission-control:group-change', { detail: nextGroupBy }));
    }
  };

  const currentLabel = options.find((o) => o.value === groupBy)?.label || 'None';

  return (
    <div ref={ref} className="relative" onKeyDown={handleKeyDown}>
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Group by: ${currentLabel}`}
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-md)] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-0)]"
      >
        <Layers size={13} />
        <span className="hidden lg:inline">{currentLabel}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Group by options"
          className="absolute right-0 top-full mt-1 z-50 w-40 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-md)] shadow-[var(--shadow-lg)] py-1"
        >
          {options.map((option) => (
            <button
              key={option.value}
              role="menuitem"
              aria-current={groupBy === option.value ? 'true' : undefined}
              onClick={() => handleSelect(option.value)}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors duration-75 focus-visible:bg-[var(--surface-3)] focus-visible:outline-none ${
                groupBy === option.value
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
