'use client';

import { useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useClickOutside } from '@/lib/hooks/useClickOutside';
import { cn } from '@/lib/utils/cn';

const ALIGN_CLASSES = {
  left: 'left-0',
  right: 'right-0',
  center: 'left-1/2 -translate-x-1/2',
} as const;

export interface PopoverProps {
  /** Whether the popover is visible. */
  isOpen: boolean;
  /** Called when the popover should close (click-outside or Escape). */
  onClose: () => void;
  /** Popover content. */
  children: React.ReactNode;
  /** Horizontal alignment relative to anchor. Default: 'left'. */
  align?: keyof typeof ALIGN_CLASSES;
  /** Width class (e.g. 'w-56', 'w-72'). Default: 'w-56'. */
  width?: string;
  /** Extra className on the content panel. */
  className?: string;
}

/**
 * Lightweight positioned content panel, anchored below its parent.
 *
 * Unlike `<Dropdown>`, Popover does not include a trigger — wrap it in
 * a `relative` container and control `isOpen` yourself.
 *
 * Ideal for tag pickers, micro-status selectors, and other inline panels.
 *
 * @example
 * <div className="relative">
 *   <button onClick={() => setOpen(!open)}>Pick tags</button>
 *   <Popover isOpen={open} onClose={() => setOpen(false)} width="w-64">
 *     <SearchInput ... />
 *     <div>...tag list...</div>
 *   </Popover>
 * </div>
 */
export function Popover({
  isOpen,
  onClose,
  children,
  align = 'left',
  width = 'w-56',
  className,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, onClose, isOpen);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={ref}
          className={cn(
            'absolute top-full mt-1 z-20 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden',
            ALIGN_CLASSES[align],
            width,
            className,
          )}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.12 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
