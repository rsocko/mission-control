'use client';

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
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
  /** Optional picker color when the trigger uses a resolved theme color */
  pickerColor?: string;
  /** Called when color changes in the picker */
  onColorChange?: (color: string) => void;
}

const SIZE_CONFIG = {
  sm: { button: 'h-8 w-12', iconSize: 16, placeholder: 'text-xs' },
  md: { button: 'h-10 w-16', iconSize: 20, placeholder: 'text-sm' },
  lg: { button: 'h-12 w-20', iconSize: 28, placeholder: 'text-base' },
} as const;

const PICKER_WIDTH = 420;
const PICKER_HEIGHT = 520;
const MIN_USABLE_PICKER_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;

interface PickerPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

function calculatePickerPosition(
  rect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): PickerPosition {
  const width = Math.max(1, Math.min(PICKER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2));
  const spaceBelow = Math.max(
    0,
    viewportHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN,
  );
  const spaceAbove = Math.max(0, rect.top - TRIGGER_GAP - VIEWPORT_MARGIN);
  const openAbove = spaceBelow < PICKER_HEIGHT && spaceAbove > spaceBelow;
  const viewportHeightLimit = Math.max(1, viewportHeight - VIEWPORT_MARGIN * 2);
  const overlapTrigger = Math.max(spaceAbove, spaceBelow)
    < Math.min(MIN_USABLE_PICKER_HEIGHT, viewportHeightLimit);
  const height = overlapTrigger
    ? Math.min(PICKER_HEIGHT, viewportHeightLimit)
    : Math.min(PICKER_HEIGHT, openAbove ? spaceAbove : spaceBelow);
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.left),
    Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width),
  );
  const top = overlapTrigger
    ? VIEWPORT_MARGIN
    : openAbove
    ? Math.max(VIEWPORT_MARGIN, rect.top - TRIGGER_GAP - height)
    : Math.min(
        rect.bottom + TRIGGER_GAP,
        Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - height),
      );

  return { top, left, width, height };
}

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
  pickerColor = color,
  onColorChange,
}: IconPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PickerPosition | null>(null);
  const config = SIZE_CONFIG[size];

  const setOpenAndNotify = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;

    function updatePosition() {
      if (!btnRef.current) return;
      const next = calculatePickerPosition(
        btnRef.current.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      );
      setPos((current) => (
        current
        && current.top === next.top
        && current.left === next.left
        && current.width === next.width
        && current.height === next.height
          ? current
          : next
      ));
    }

    function handleScroll(event: Event) {
      if (pickerRef.current?.contains(event.target as Node)) return;
      updatePosition();
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', handleScroll, true);
    };
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
            role="dialog"
            aria-label="Choose an icon"
            className="fixed z-[9999]"
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              width: pos?.width ?? PICKER_WIDTH,
              height: pos?.height ?? PICKER_HEIGHT,
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            <IconPicker
              value={value}
              onChange={(v) => {
                onChange(v);
                setOpenAndNotify(false);
              }}
              onClose={() => setOpenAndNotify(false)}
              color={pickerColor}
              onColorChange={onColorChange}
              className="h-full max-h-none w-full"
            />
          </div>,
          document.body,
        )}
    </>
  );
}
