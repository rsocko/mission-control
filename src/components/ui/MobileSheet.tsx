'use client';

import { useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence, useDragControls, useReducedMotion, type PanInfo } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface MobileSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Title shown in the sheet header */
  title?: string;
  /** Accessible dialog name when the visual title is intentionally omitted */
  ariaLabel?: string;
  /** Height of the sheet: 'auto' fits content, 'full' is near-fullscreen, or a percentage like '75%' */
  height?: 'auto' | 'full' | string;
  /** Extra className on the sheet container */
  className?: string;
  /** Stable fallback focus target when the element that opened the sheet is removed */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Mobile bottom sheet with drag-to-dismiss.
 * Slides up from the bottom with a backdrop overlay.
 * Drag the handle or swipe down to dismiss.
 */
export function MobileSheet({
  isOpen,
  onClose,
  children,
  title,
  ariaLabel,
  height = 'auto',
  className,
  returnFocusRef,
}: MobileSheetProps) {
  const dragControls = useDragControls();
  const sheetRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const prefersReducedMotion = useReducedMotion();
  onCloseRef.current = onClose;

  // Keep keyboard focus inside the modal sheet.
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const fallbackFocus = returnFocusRef?.current;
    const focusSheet = requestAnimationFrame(() => {
      const firstFocusable = sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable || sheetRef.current)?.focus();
    });

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || e.defaultPrevented || !sheetRef.current) return;

      const sheet = sheetRef.current;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        e.preventDefault();
        sheet.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !focusable.includes(active as HTMLElement))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      cancelAnimationFrame(focusSheet);
      document.removeEventListener('keydown', handler);
      const focusTarget = previousFocusRef.current?.isConnected
        && previousFocusRef.current !== document.body
        ? previousFocusRef.current
        : fallbackFocus;
      focusTarget?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen, returnFocusRef]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isOpen]);

  const handleDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      // Dismiss if dragged down more than 100px or with high velocity
      if (info.offset.y > 100 || info.velocity.y > 500) {
        onClose();
      }
    },
    [onClose]
  );

  const heightClass =
    height === 'full'
      ? 'max-h-[92vh]'
      : height === 'auto'
        ? 'max-h-[85vh]'
        : '';
  const heightStyle = height !== 'full' && height !== 'auto' ? { maxHeight: height } : undefined;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className={cn("fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]", className)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Sheet */}
          <motion.div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel || title || 'Detail sheet'}
            tabIndex={-1}
            className={cn(
              'fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-[var(--surface-1)] border-t border-[var(--border)] shadow-2xl overflow-hidden outline-none',
              heightClass,
              className
            )}
            style={heightStyle}
            initial={prefersReducedMotion ? { y: 0 } : { y: '100%' }}
            animate={{ y: 0 }}
            exit={prefersReducedMotion ? { y: 0 } : { y: '100%' }}
            transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', damping: 30, stiffness: 300 }}
            drag="y"
            dragControls={dragControls}
            dragConstraints={{ top: 0 }}
            dragElastic={0.2}
            onDragEnd={handleDragEnd}
          >
            {/* Drag handle */}
            <div
              className="flex-shrink-0 flex items-center justify-center pt-3 pb-2 cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => dragControls.start(e)}
              role="separator"
              aria-label="Drag to dismiss sheet"
            >
              <div className="w-10 h-1 rounded-full bg-[var(--text-tertiary)]/40" />
            </div>

            {/* Header */}
            {title && (
              <div className="flex items-center justify-between px-4 pb-3 border-b border-[var(--border-subtle)]">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
                <button
                  onClick={onClose}
                  className="p-2 -mr-2 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
