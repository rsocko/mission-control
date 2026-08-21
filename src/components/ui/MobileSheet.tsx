'use client';

import { useCallback, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { surfaceExitTransition } from '@/lib/motion';

const DISMISS_DISTANCE_PX = 120;
const DISMISS_VELOCITY_PX_PER_SECOND = 700;

export interface MobileSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Title shown in the sheet header */
  title?: string;
  /** Accessible dialog name; overrides the visual title when provided */
  ariaLabel?: string;
  /** Height of the sheet: 'auto' fits content, 'full' is near-fullscreen, or a CSS height like '75%' */
  height?: 'auto' | 'full' | string;
  /** Extra className on the sheet container */
  className?: string;
  /** Extra className on the scrollable content container */
  contentClassName?: string;
  /** Stable fallback focus target when the element that opened the sheet is removed */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export function shouldDismissMobileSheet(offsetY: number, velocityY: number): boolean {
  return offsetY >= DISMISS_DISTANCE_PX || velocityY >= DISMISS_VELOCITY_PX_PER_SECOND;
}

/**
 * Mobile bottom sheet with accessible modal behavior and drag-to-dismiss.
 * Dragging is isolated to the handle so scrolling form content remains predictable.
 */
export function MobileSheet({
  isOpen,
  onClose,
  children,
  title,
  ariaLabel,
  height = 'auto',
  className,
  contentClassName,
  returnFocusRef,
}: MobileSheetProps) {
  const dragControls = useDragControls();
  const prefersReducedMotion = useReducedMotion();
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const handleDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      if (shouldDismissMobileSheet(info.offset.y, info.velocity.y)) {
        onClose();
      }
    },
    [onClose],
  );

  const heightClass =
    height === 'full'
      ? 'h-[92dvh] max-h-[calc(100dvh-env(safe-area-inset-top))]'
      : height === 'auto'
        ? 'max-h-[85dvh]'
        : '';
  const heightStyle = height !== 'full' && height !== 'auto'
    ? { height, maxHeight: 'calc(100dvh - env(safe-area-inset-top))' }
    : undefined;

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {isOpen && (
            <>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  key="mobile-sheet-overlay"
                  className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={prefersReducedMotion ? { duration: 0 } : surfaceExitTransition}
                />
              </Dialog.Overlay>

              <Dialog.Content
                asChild
                forceMount
                {...(ariaLabel ? { 'aria-label': ariaLabel, 'aria-labelledby': undefined } : {})}
                aria-describedby={undefined}
                onOpenAutoFocus={() => {
                  previousFocusRef.current = document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                }}
                onCloseAutoFocus={(event) => {
                  const opener = previousFocusRef.current?.isConnected
                    && previousFocusRef.current !== document.body
                    ? previousFocusRef.current
                    : null;
                  const focusTarget = opener ?? returnFocusRef?.current ?? null;
                  previousFocusRef.current = null;
                  if (!focusTarget) return;
                  event.preventDefault();
                  focusTarget.focus();
                }}
              >
                <motion.div
                  key="mobile-sheet-content"
                  className={cn(
                    'fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface-1)] shadow-2xl outline-none',
                    heightClass,
                    className,
                  )}
                  style={heightStyle}
                  initial={prefersReducedMotion ? { y: 0 } : { y: '100%' }}
                  animate={{
                    y: 0,
                    transition: prefersReducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', damping: 34, stiffness: 380 },
                  }}
                  exit={{
                    y: prefersReducedMotion ? 0 : '100%',
                    transition: prefersReducedMotion ? { duration: 0 } : surfaceExitTransition,
                  }}
                  drag="y"
                  dragListener={false}
                  dragControls={dragControls}
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0, bottom: 0.18 }}
                  dragMomentum={false}
                  dragSnapToOrigin="y"
                  dragTransition={{ bounceStiffness: 700, bounceDamping: 45 }}
                  onDragEnd={handleDragEnd}
                >
                  {!title && (
                    <Dialog.Title className="sr-only">
                      {ariaLabel || 'Detail sheet'}
                    </Dialog.Title>
                  )}

                  <div
                    className="flex touch-none shrink-0 cursor-grab items-center justify-center pb-2 pt-3 active:cursor-grabbing"
                    onPointerDown={(event) => dragControls.start(event)}
                    role="separator"
                    aria-label="Drag down to close sheet"
                    aria-orientation="horizontal"
                  >
                    <div className="h-1 w-10 rounded-full bg-[var(--text-tertiary)]/40" />
                  </div>

                  {title && (
                    <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 pb-3">
                      <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">
                        {title}
                      </Dialog.Title>
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          className="-mr-2 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-2 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                          aria-label="Close"
                        >
                          <X size={18} />
                        </button>
                      </Dialog.Close>
                    </div>
                  )}

                  <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', contentClassName)}>
                    {children}
                  </div>
                </motion.div>
              </Dialog.Content>
            </>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
