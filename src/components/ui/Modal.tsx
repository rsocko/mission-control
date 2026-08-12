'use client';

import { useEffect, useId, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { modalOverlay, modalContent } from '@/lib/motion';
import { cn } from '@/lib/utils/cn';

const SIZE_CLASSES = {
  sm: 'w-[400px]',
  md: 'w-[600px]',
  lg: 'w-[800px]',
  xl: 'w-[900px]',
  '2xl': 'w-[1100px]',
} as const;

export interface ModalProps {
  /** Whether the modal is visible. */
  isOpen: boolean;
  /** Called when the user dismisses the modal (backdrop click, Escape, or close button). */
  onClose: () => void;
  children: React.ReactNode;
  /** Width variant. */
  size?: keyof typeof SIZE_CLASSES;
  /** Optional title shown in a header bar. */
  title?: string;
  /** Accessible name when the visual title is rendered inside children. */
  ariaLabel?: string;
  /** Show a close (X) button in the header area. Default: true when title is provided. */
  showClose?: boolean;
  /** Close on backdrop click. Default: true. */
  closeOnBackdropClick?: boolean;
  /** Extra className on the modal container. */
  className?: string;
  /** Extra className on the full-screen positioning wrapper. */
  overlayClassName?: string;
  /** Optional test id for the visual dialog panel. */
  contentTestId?: string;
}

/**
 * Full-screen modal overlay with animated backdrop and content panel.
 *
 * Matches the existing design system: `bg-[var(--surface-1)]`, `rounded-2xl`,
 * `shadow-2xl`, `modalOverlay`/`modalContent` motion variants.
 *
 * @example
 * <Modal isOpen={open} onClose={() => setOpen(false)} title="Add Task" size="md">
 *   <div className="p-4">...form content...</div>
 * </Modal>
 */
export function Modal({
  isOpen,
  onClose,
  children,
  size = 'md',
  title,
  ariaLabel = 'Dialog',
  showClose,
  closeOnBackdropClick = true,
  className,
  overlayClassName,
  contentTestId,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!e.defaultPrevented) onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previouslyFocused?.focus();
    };
  }, [isOpen, onClose]);

  const shouldShowClose = showClose ?? !!title;

  return (
    <AnimatePresence propagate>
      {isOpen && (
        <motion.div
          className={cn('fixed inset-0 z-50 flex items-start justify-center pt-[10vh]', overlayClassName)}
          variants={modalOverlay}
          initial="hidden"
          animate="show"
          exit="exit"
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-label={title ? undefined : ariaLabel}
          ref={dialogRef}
          tabIndex={-1}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={closeOnBackdropClick ? onClose : undefined}
            aria-hidden="true"
          />

          {/* Content panel */}
          <motion.div
            data-testid={contentTestId}
            className={cn(
              'relative z-10 flex flex-col bg-[var(--surface-1)] border border-[var(--border)] rounded-2xl shadow-2xl max-w-[95vw] max-h-[85vh]',
              SIZE_CLASSES[size],
              className,
            )}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            variants={modalContent}
            initial="hidden"
            animate="show"
            exit="exit"
          >
            {/* Optional header */}
            {(title || shouldShowClose) && (
              <div className="flex items-center justify-between px-5 pt-4 pb-2">
                {title && (
                  <h2 id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
                    {title}
                  </h2>
                )}
                {shouldShowClose && (
                  <button
                    onClick={onClose}
                    className="ml-auto p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            )}

            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
