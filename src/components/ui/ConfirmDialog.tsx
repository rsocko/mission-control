'use client';

import { useEffect, useRef } from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant: 'danger' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmDialog({ open, title, message, confirmLabel, confirmVariant, onConfirm, onCancel, children }: ConfirmDialogProps) {
  const wasOpen = useRef(false);

  // Safety net: if Radix's pointer-events cleanup on <body> is disrupted by a
  // concurrent React re-render during the close transition, force-restore it.
  useEffect(() => {
    if (wasOpen.current && !open) {
      const id = window.setTimeout(() => {
        if (document.body.style.pointerEvents === 'none') {
          document.body.style.pointerEvents = '';
        }
      }, 200);
      return () => window.clearTimeout(id);
    }
    wasOpen.current = open;
  }, [open]);
  const variantStyles = confirmVariant === 'danger'
    ? 'bg-red-600 hover:bg-red-500 text-white'
    : 'bg-amber-700 hover:bg-amber-800 text-white';

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-150" />
        <AlertDialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] shadow-xl p-5 max-w-sm w-full mx-4 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150">
          <AlertDialogPrimitive.Title className="text-sm font-semibold text-[var(--text-primary)] mb-1">
            {title}
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="text-xs text-[var(--text-secondary)] mb-4 leading-relaxed">
            {message}
          </AlertDialogPrimitive.Description>
          {children}
          <div className="flex items-center justify-end gap-2 mt-4">
            <AlertDialogPrimitive.Cancel
              onClick={onCancel}
              className="text-xs px-3 py-1.5 rounded-[var(--radius-sm)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
            >
              Cancel
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action
              onClick={onConfirm}
              className={`text-xs px-3 py-1.5 rounded-[var(--radius-sm)] font-medium transition-colors duration-100 ${variantStyles}`}
            >
              {confirmLabel}
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
