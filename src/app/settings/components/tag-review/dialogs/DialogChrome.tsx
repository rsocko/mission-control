'use client';

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { modalContent, modalOverlay } from '@/lib/motion';

interface DialogChromeProps {
  children: ReactNode;
  labelId: string;
  maxWidth?: string;
  onClose: () => void;
  open: boolean;
}

export function DialogChrome({
  children,
  labelId,
  maxWidth = 'max-w-sm',
  onClose,
  open,
}: DialogChromeProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            variants={modalOverlay}
            initial="hidden"
            animate="show"
            exit="hidden"
            className="fixed inset-0 bg-black/60 z-50"
            onClick={onClose}
          />
          <motion.div
            variants={modalContent}
            initial="hidden"
            animate="show"
            exit="hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelId}
            className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full ${maxWidth} bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl`}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
