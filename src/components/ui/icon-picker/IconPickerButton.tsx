'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils/cn';
import { IconPicker } from './IconPicker';
import { IconRenderer } from './IconRenderer';

export interface IconPickerButtonProps {
  /** Current icon value */
  value: string | null;
  /** Called when the user picks an icon */
  onChange: (value: string) => void;
  /** Called when the picker opens/closes */
  onOpenChange?: (open: boolean) => void;
  /** Placeholder shown when no icon is selected */
  placeholder?: React.ReactNode;
  /** Button size. Default: 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Extra className on the trigger button */
  className?: string;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Optional icon color (for SVG icons) */
  color?: string;
  /** Called when color changes in the picker */
  onColorChange?: (color: string) => void;
}

const SIZE_CONFIG = {
  sm: { button: 'h-8 w-12', iconSize: 16, placeholder: 'text-xs' },
  md: { button: 'h-10 w-16', iconSize: 20, placeholder: 'text-sm' },
  lg: { button: 'h-12 w-20', iconSize: 28, placeholder: 'text-base' },
} as const;

/**
 * A trigger button that opens the IconPicker in a portal.
 *
 * Drop-in replacement for the old EmojiPickerButton — supports
 * emoji, Lucide, Material Design, Phosphor, Dashboard Icons, and Simple Icons.
 *
 * @example
 * <IconPickerButton
 *   value={icon}
 *   onChange={setIcon}
 *   placeholder={<Smile className="opacity-40" size={16} />}
 * />
 */
export function IconPickerButton({
  value,
  onChange,
  onOpenChange,
  placeholder,
  size = 'md',
  className,
  disabled = false,
  color,
  onColorChange,
}: IconPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const config = SIZE_CONFIG[size];

  const setOpenAndNotify = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  // Position the picker relative to the button
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const pickerHeight = 520;
    const pickerWidth = 420;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const openAbove = spaceBelow < pickerHeight && rect.top > pickerHeight;
    const spaceRight = window.innerWidth - rect.left;
    const shiftLeft = spaceRight < pickerWidth ? Math.max(0, pickerWidth - spaceRight + 8) : 0;

    setPos({
      top: openAbove ? rect.top - pickerHeight - 4 : rect.bottom + 4,
      left: Math.max(8, rect.left - shiftLeft),
    });
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (pickerRef.current?.contains(target)) return;
      setOpenAndNotify(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenAndNotify(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, setOpenAndNotify]);

  const defaultPlaceholder = (
    <span className={cn('opacity-40 grayscale', config.placeholder)}>😀</span>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpenAndNotify(!open)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          'flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-0)] transition-[border-color,box-shadow] hover:border-blue-500/40 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed',
          config.button,
          className,
        )}
        title="Pick an icon"
      >
        {value ? (
          <IconRenderer value={value} size={config.iconSize} color={color} />
        ) : (
          placeholder ?? defaultPlaceholder
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={pickerRef}
            className="fixed z-[9999]"
            style={{ top: pos.top, left: pos.left }}
          >
            <IconPicker
              value={value}
              onChange={(v) => {
                onChange(v);
                setOpenAndNotify(false);
              }}
              onClose={() => setOpenAndNotify(false)}
              color={color}
              onColorChange={onColorChange}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
