'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Clock, Sun, Calendar } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

interface SnoozePopoverProps {
  taskId: string;
  onSnooze: (taskId: string, until: string) => void;
}

const SNOOZE_OPTIONS = [
  { label: '1 hour', icon: Clock, hours: 1 },
  { label: '4 hours', icon: Clock, hours: 4 },
  { label: 'Tomorrow', icon: Sun, hours: null, isTomorrow: true },
  { label: 'Next week', icon: Calendar, hours: null, isNextWeek: true },
] as const;

function getSnoozeUntil(option: typeof SNOOZE_OPTIONS[number]): string {
  const now = new Date();
  if (option.hours) {
    return new Date(now.getTime() + option.hours * 60 * 60 * 1000).toISOString();
  }
  if ('isTomorrow' in option && option.isTomorrow) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow.toISOString();
  }
  // Next week (Monday 9am)
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
  nextMonday.setHours(9, 0, 0, 0);
  return nextMonday.toISOString();
}

export function SnoozePopover({ taskId, onSnooze }: SnoozePopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Tooltip content="Snooze task">
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="p-1 rounded text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-900/20 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
          aria-label="Snooze task"
        >
          <Clock size={13} />
        </button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full mt-1 z-50 w-40 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg shadow-lg py-1"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2.5 py-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              Snooze for
            </div>
            {SNOOZE_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSnooze(taskId, getSnoozeUntil(option));
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
                >
                  <Icon size={12} className="text-amber-400/60" />
                  {option.label}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
