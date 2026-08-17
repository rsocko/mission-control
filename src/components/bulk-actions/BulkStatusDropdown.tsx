'use client';

import { useEffect, useRef, useState } from 'react';
import { TASK_STATUS_VISUALS } from '@/lib/constants/task-formatting';

interface BulkStatusDropdownProps {
  onSetStatus: (status: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

const STATUSES = [
  ...(['todo', 'in_progress', 'done', 'cancelled'] as const).map((value) => ({
    value,
    label: TASK_STATUS_VISUALS[value].label,
    color: TASK_STATUS_VISUALS[value].textClass,
  })),
];

export function BulkStatusDropdown({ onSetStatus, disabled = false, disabledReason }: BulkStatusDropdownProps) {
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

  function handleSelect(status: string) {
    setApplying(true);
    setOpen(false);
    onSetStatus(status).finally(() => setApplying(false));
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="text-xs px-2 py-1 bg-blue-900/30 text-blue-300 border border-blue-800/40 rounded-[var(--radius-sm)] hover:bg-blue-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {applying ? 'Setting…' : '◉ Status'}
      </button>
      {open && (
        <div role="listbox" aria-label="Set status" className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] shadow-lg py-1 min-w-36">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              onClick={() => handleSelect(s.value)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-2)] transition-colors duration-75 ${s.color}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
