'use client';

import { useState, useEffect, useRef } from 'react';
import { Check, ListChevronsUpDown, ListChevronsDownUp, Rows3, WrapText } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

const STORAGE_KEY = 'mission-control:view-density';

export type ViewDensity = 'compact' | 'comfortable';
export type RowLayout = 'normal' | 'compact' | 'wrapped';

interface ViewDensityToggleProps {
  value?: ViewDensity;
  onChange?: (density: ViewDensity) => void;
}

export function ViewDensityToggle({ value, onChange }: ViewDensityToggleProps = {}) {
  const [internalDensity, setInternalDensity] = useState<ViewDensity>('comfortable');
  const density = value ?? internalDensity;

  useEffect(() => {
    if (value !== undefined) return;
    const stored = localStorage.getItem(STORAGE_KEY) as ViewDensity | null;
    if (stored) setInternalDensity(stored);
  }, [value]);

  const toggle = () => {
    const next: ViewDensity = density === 'comfortable' ? 'compact' : 'comfortable';
    if (value === undefined) {
      setInternalDensity(next);
      localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new CustomEvent('mission-control:density-change', { detail: next }));
    }
    onChange?.(next);
  };

  const tooltipText = density === 'comfortable' ? 'Switch to compact view' : 'Switch to expanded view';

  return (
    <Tooltip content={tooltipText} placement="bottom">
      <button
        onClick={toggle}
        aria-pressed={density === 'compact'}
        aria-label={tooltipText}
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-md)] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-0)]"
      >
        {density === 'comfortable' ? <ListChevronsDownUp size={13} /> : <ListChevronsUpDown size={13} />}
      </button>
    </Tooltip>
  );
}

interface RowLayoutDropdownProps {
  value: RowLayout;
  onChange: (layout: RowLayout) => void;
}

const ROW_LAYOUT_OPTIONS: Array<{
  value: RowLayout;
  label: string;
  description: string;
  icon: typeof Rows3;
}> = [
  { value: 'normal', label: 'Normal', description: 'Single-line titles', icon: Rows3 },
  { value: 'compact', label: 'Compact', description: 'Tighter single-line rows', icon: ListChevronsUpDown },
  { value: 'wrapped', label: 'Wrap', description: 'Show up to two title lines', icon: WrapText },
];

export function RowLayoutDropdown({ value, onChange }: RowLayoutDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = ROW_LAYOUT_OPTIONS.find((option) => option.value === value) ?? ROW_LAYOUT_OPTIONS[0];
  const CurrentIcon = current.icon;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    if (!items?.length) return;
    const currentIndex = Array.from(items).findIndex((item) => item === document.activeElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[currentIndex < items.length - 1 ? currentIndex + 1 : 0]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[currentIndex > 0 ? currentIndex - 1 : items.length - 1]?.focus();
    }
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Row layout: ${current.label}`}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors duration-100 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-0)]"
      >
        <CurrentIcon size={13} />
        <span className="hidden lg:inline">{current.label}</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Row layout options"
          className="absolute right-0 top-full z-50 mt-1 w-52 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] py-1 shadow-[var(--shadow-lg)]"
        >
          {ROW_LAYOUT_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[var(--text-secondary)] transition-colors duration-75 hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--surface-3)] focus-visible:outline-none"
              >
                <OptionIcon size={14} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-[var(--text-primary)]">{option.label}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{option.description}</span>
                </span>
                {selected && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
