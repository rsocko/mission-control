'use client';

import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, Palette } from 'lucide-react';
import { COLOR_PRESETS } from '@/lib/constants/colors';
import { cn } from '@/lib/utils';

const COLOR_LABELS: Record<(typeof COLOR_PRESETS)[number], string> = {
  '#3b82f6': 'Blue',
  '#8b5cf6': 'Violet',
  '#ec4899': 'Pink',
  '#f59e0b': 'Amber',
  '#10b981': 'Emerald',
  '#06b6d4': 'Cyan',
  '#ef4444': 'Red',
  '#6b7280': 'Gray',
};

interface PhaseColorPickerProps {
  phaseName: string;
  value: string | null;
  fallbackColor: string;
  inheritLabel?: string | null;
  disabled?: boolean;
  onChange: (color: string | null) => void | Promise<void>;
}

export function PhaseColorPicker({
  phaseName,
  value,
  fallbackColor,
  inheritLabel = 'Use project color',
  disabled = false,
  onChange,
}: PhaseColorPickerProps) {
  const [open, setOpen] = useState(false);
  const activeColor = value || fallbackColor;

  function selectColor(color: string | null) {
    setOpen(false);
    void onChange(color);
  }

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen) => setOpen(disabled ? false : nextOpen)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Change ${phaseName} color`}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent transition-[background-color,border-color,transform] duration-150',
            'hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] active:scale-[0.96]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <span
            className="h-2.5 w-2.5 rounded-full ring-1 ring-white/20"
            style={{ backgroundColor: activeColor }}
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label={`Choose a color for ${phaseName}`}
          className="z-50 w-56 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-[var(--shadow-lg)] outline-none"
        >
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
            <Palette size={13} aria-hidden="true" />
            Phase color
          </div>
          <div className="grid grid-cols-4 gap-2">
            {COLOR_PRESETS.map((preset) => {
              const selected = value === preset;
              const label = COLOR_LABELS[preset];
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => selectColor(preset)}
                  aria-label={`Set ${phaseName} color to ${label}`}
                  aria-pressed={selected}
                  className={cn(
                    'inline-flex h-9 w-9 items-center justify-center rounded-full border transition-[border-color,transform] duration-150',
                    'hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]',
                    selected ? 'border-white/90' : 'border-white/20',
                  )}
                  style={{ backgroundColor: preset }}
                  title={label}
                >
                  {selected ? <Check size={15} className="text-white drop-shadow-sm" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          {inheritLabel ? (
            <button
              type="button"
              onClick={() => selectColor(null)}
              aria-pressed={value === null}
              className={cn(
                'mt-3 flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]',
                value === null
                  ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
              )}
            >
              <span
                className="h-2.5 w-2.5 rounded-full ring-1 ring-white/20"
                style={{ backgroundColor: fallbackColor }}
                aria-hidden="true"
              />
              {inheritLabel}
              {value === null ? <Check size={13} className="ml-auto" aria-hidden="true" /> : null}
            </button>
          ) : null}
          <Popover.Arrow className="fill-[var(--border)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
