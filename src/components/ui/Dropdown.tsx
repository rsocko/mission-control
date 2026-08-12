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

export interface DropdownProps {
  /** The trigger element (typically a button). */
  trigger: React.ReactNode;
  /** Dropdown content. */
  children: React.ReactNode;
  /** Controlled open state. */
  isOpen: boolean;
  /** Called when the dropdown should open or close. */
  onOpenChange: (open: boolean) => void;
  /** Horizontal alignment relative to trigger. Default: 'left'. */
  align?: keyof typeof ALIGN_CLASSES;
  /** Extra className on the floating content panel. */
  className?: string;
  /** Width class (e.g. 'w-56', 'w-72'). Default: 'w-56'. */
  width?: string;
  /** Whether to animate with motion. Default: true. */
  animated?: boolean;
  /** ARIA role for the dropdown content. Default: 'menu'. */
  role?: string;
  /** ARIA label for the dropdown content. */
  ariaLabel?: string;
}

/**
 * Positioned dropdown panel anchored below a trigger element.
 *
 * Handles click-outside dismissal, optional Framer Motion animation,
 * and configurable alignment/width.
 *
 * @example
 * <Dropdown
 *   trigger={<button>Sort</button>}
 *   isOpen={open}
 *   onOpenChange={setOpen}
 *   align="right"
 *   width="w-44"
 * >
 *   <DropdownItem onClick={() => sort('name')}>Name</DropdownItem>
 *   <DropdownItem onClick={() => sort('date')}>Date</DropdownItem>
 * </Dropdown>
 */
export function Dropdown({
  trigger,
  children,
  isOpen,
  onOpenChange,
  align = 'left',
  className,
  width = 'w-56',
  animated = true,
  role = 'menu',
  ariaLabel,
}: DropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => onOpenChange(false), isOpen);

  const content = (
    <div
      className={cn(
        'absolute top-full mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden py-1',
        ALIGN_CLASSES[align],
        width,
        className,
      )}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <div onClick={() => onOpenChange(!isOpen)}>{trigger}</div>
      {animated ? (
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.12 }}
            >
              {content}
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        isOpen && content
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DropdownItem — convenience component for menu items
// ---------------------------------------------------------------------------

export interface DropdownItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether this item is currently selected/active. */
  active?: boolean;
}

/**
 * Styled menu item for use inside a `<Dropdown>`.
 */
export function DropdownItem({
  children,
  active,
  className,
  ...props
}: DropdownItemProps) {
  return (
    <button
      role="menuitem"
      className={cn(
        'w-full text-left px-3 py-1.5 text-xs transition-colors duration-75 focus-visible:bg-[var(--surface-3)] focus-visible:outline-none',
        active
          ? 'text-[var(--text-primary)] bg-[var(--surface-3)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
