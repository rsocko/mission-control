'use client';

import { useEffect, useRef, useState } from 'react';
import { Calendar, Clock, X } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { getLocalToday as getClientToday, getLocalTomorrow as getClientTomorrow } from '@/lib/utils/client-date';

// Re-export for convenience where date-picker isn't needed inline
export { Calendar as CalendarIcon } from 'lucide-react';

interface BulkDueDateDropdownProps {
  onSetDate: (date: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

export function BulkDueDateDropdown({ onSetDate, disabled = false, disabledReason }: BulkDueDateDropdownProps) {
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function handleSelect(date: string) {
    setApplying(true);
    setOpen(false);
    setShowPicker(false);
    onSetDate(date).finally(() => setApplying(false));
  }

  const today = getClientToday();
  const tomorrow = getClientTomorrow();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(!open); setShowPicker(false); }}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="text-xs px-2 py-1 bg-blue-900/30 text-blue-300 border border-blue-800/40 rounded-[var(--radius-sm)] hover:bg-blue-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {applying ? 'Setting…' : <><Calendar size={12} className="inline" /> Due date</>}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] shadow-lg py-1 min-w-40">
          {!showPicker ? (
            <>
              <button
                onClick={() => handleSelect(today)}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
              >
                <Calendar size={12} className="text-blue-400" />
                Due today
              </button>
              <button
                onClick={() => handleSelect(tomorrow)}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
              >
                <Clock size={12} className="text-orange-400" />
                Due tomorrow
              </button>
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <button
                onClick={() => setShowPicker(true)}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
              >
                <Calendar size={12} className="text-purple-400" />
                Pick a date…
              </button>
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <button
                onClick={() => handleSelect('')}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors duration-75"
              >
                <X size={12} />
                Clear due date
              </button>
            </>
          ) : (
            <div className="p-2">
              <DatePicker
                value={null}
                onChange={(date) => {
                  if (date) handleSelect(date);
                }}
                variant="input"
                placeholder="Pick a date"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
