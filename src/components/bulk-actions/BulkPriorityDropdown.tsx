'use client';

import { useEffect, useRef, useState } from 'react';

interface BulkPriorityDropdownProps {
  onSetPriority: (priority: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

const PRIORITIES = [
  { value: 'critical', label: 'Critical', color: 'text-rose-400' },
  { value: 'high', label: 'High', color: 'text-orange-400' },
  { value: 'medium', label: 'Medium', color: 'text-amber-300' },
  { value: 'low', label: 'Low', color: 'text-sky-400' },
  { value: 'none', label: 'None', color: 'text-[var(--text-muted)]' },
];

export function BulkPriorityDropdown({ onSetPriority, disabled = false, disabledReason }: BulkPriorityDropdownProps) {
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function handleSelect(priority: string) {
    setApplying(true);
    setOpen(false);
    onSetPriority(priority).finally(() => setApplying(false));
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="text-xs px-2 py-1 bg-orange-900/30 text-orange-300 border border-orange-800/40 rounded-[var(--radius-sm)] hover:bg-orange-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {applying ? 'Setting…' : '⚑ Priority'}
      </button>
      {open && (
        <div role="listbox" aria-label="Set priority" className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] shadow-lg py-1 min-w-36">
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              onClick={() => handleSelect(p.value)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-2)] transition-colors duration-75 ${p.color}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
