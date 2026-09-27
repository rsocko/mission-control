'use client';

import { useEffect, useRef, useState } from 'react';
import { Toaster as SonnerToaster, toast as sonnerToast, type ToastT } from 'sonner';
import { useToastPreferences } from '@/lib/toast-preferences';
import { isRoutineToast } from '@/lib/toast';
import './toaster.css';

function getActiveToasts() {
  return sonnerToast.getToasts().filter((toast): toast is ToastT => !('dismiss' in toast));
}

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);

  return isMobile;
}

export function Toaster() {
  const isMobile = useIsMobile();
  const { preferences, muted } = useToastPreferences();
  const heldDurations = useRef(new Map<string | number, number>());
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const pointerFocus = useRef(false);

  function setDuration(toast: ToastT, duration: number) {
    const emit = toast.type === 'success' || toast.type === 'info' ||
      toast.type === 'warning' || toast.type === 'error'
      ? sonnerToast[toast.type] : sonnerToast;
    emit(toast.title, { ...toast, duration });
  }

  function holdForKeyboard() {
    if (pointerFocus.current) return;
    const activeToasts = getActiveToasts();
    const activeIds = new Set(activeToasts.map((toast) => toast.id));
    for (const id of heldDurations.current.keys()) {
      if (!activeIds.has(id)) heldDurations.current.delete(id);
    }
    for (const toast of activeToasts) {
      if (toast.type === 'loading' || toast.duration === Infinity || heldDurations.current.has(toast.id)) continue;
      heldDurations.current.set(toast.id, toast.duration ?? 3000);
      setDuration(toast, Infinity);
    }
  }

  function releaseKeyboardHold() {
    for (const toast of getActiveToasts()) {
      const duration = heldDurations.current.get(toast.id);
      if (duration !== undefined && toast.duration === Infinity) setDuration(toast, duration);
    }
    heldDurations.current.clear();
  }

  useEffect(() => {
    if (preferences.mode !== 'errors-only' && !muted) return;
    for (const toast of getActiveToasts()) {
      if (toast.type !== 'error' && toast.type !== 'warning' && toast.type !== 'loading' &&
        isRoutineToast({ ...toast, duration: heldDurations.current.get(toast.id) ?? toast.duration })) {
        sonnerToast.dismiss(toast.id);
      }
    }
  }, [preferences.mode, muted]);

  return (
    <div
      onPointerDownCapture={(event) => {
        pointerFocus.current = true;
        dragStart.current = null;
        const target = event.target;
        if (!(target instanceof Element) || event.button !== 0 ||
          target.closest('button, a, input, textarea, select') ||
          !target.closest('[data-sonner-toast][data-dismissible="true"]:not([data-type="loading"])')) return;
        dragStart.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMoveCapture={(event) => {
        const start = dragStart.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 8) {
          // Sonner ignores drags while any page text is selected, even outside the toast.
          window.getSelection()?.removeAllRanges();
          dragStart.current = null;
        }
      }}
      onPointerUpCapture={() => {
        dragStart.current = null;
        pointerFocus.current = false;
      }}
      onPointerCancelCapture={() => {
        dragStart.current = null;
        pointerFocus.current = false;
      }}
      onFocusCapture={holdForKeyboard}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) releaseKeyboardHold();
      }}
    >
      <SonnerToaster
        position={isMobile ? 'top-center' : preferences.desktopPosition}
        closeButton
        swipeDirections={['top', 'bottom', 'left', 'right']}
        visibleToasts={2}
        duration={3000}
        offset={{ left: 'calc(var(--toast-nav-width, 0px) + 24px)', top: 72, bottom: 24, right: 24 }}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)', left: 16, right: 16 }}
        toastOptions={{
          style: {
            background: 'var(--surface-2)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-primary)',
            borderRadius: 'var(--radius-lg)',
            touchAction: 'none',
            userSelect: 'none',
          },
          classNames: {
            error: '!border-red-500/40 !bg-red-950/80 !text-red-200',
            success: '!border-green-500/40 !bg-green-950/80 !text-green-200',
            warning: '!border-yellow-500/40 !bg-yellow-950/80 !text-yellow-200',
            info: '!border-blue-500/40 !bg-blue-950/80 !text-blue-200',
            closeButton: '!bg-white/10 !border-white/20',
          },
        }}
        theme="dark"
      />
    </div>
  );
}
