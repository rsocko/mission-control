'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useViewMode } from '@/lib/hooks/useViewMode';
import { useSidebarExpanded } from '@/lib/hooks/useSidebarExpanded';

/**
 * Global keyboard shortcuts for Mission Control.
 * 
 * Navigation:
 *   G then D - Go to Dashboard
 *   G then T - Go to Today/My Day
 *   G then K - Go to Kanban
 *   G then A - Go to Houston
 *   G then S - Go to Settings
 * 
 * Actions:
 *   N - Focus quick add bar (handled in QuickAddBar)
 *   Ctrl+Shift+T - Open template picker (handled in QuickAddBar)
 *   S - Snooze focused/selected task
 *   / - Open search
 *   ? - Show shortcuts help
 *   Z - Toggle Zen Mode
 *   C - Toggle Calm Mode
 *   [ - Toggle sidebar collapse
 *   ] - Toggle notifications panel
 *   Escape - Close modal/dropdown, clear focus
 */

export function useKeyboardShortcuts() {
  const router = useRouter();
  const { toggleZen, toggleCalm } = useViewMode();
  const { toggleSidebar, toggleNotificationsPanel } = useSidebarExpanded();

  useEffect(() => {
    let gPending = false;
    let gTimeout: NodeJS.Timeout | null = null;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Don't intercept when typing in inputs (except Escape)
      if (isInput && e.key !== 'Escape') return;

      // "G" prefix for navigation
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!gPending) {
          gPending = true;
          gTimeout = setTimeout(() => { gPending = false; }, 1000);
          return;
        }
      }

      if (gPending) {
        gPending = false;
        if (gTimeout) clearTimeout(gTimeout);
        switch (e.key) {
          case 'd': router.push('/'); return;
          case 't': router.push('/today'); return;
          case 'k': router.push('/kanban'); return;
          case 'a': router.push('/ai'); return;
          case 's': router.push('/settings'); return;
        }
        // No matching nav key after 'g' prefix — consume the keypress
        return;
      }

      // "/" to open search
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('mission-control:open-search'));
        return;
      }


      // "Z" to toggle Zen Mode
      if (e.key === 'z' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        toggleZen();
        return;
      }

      // "C" to toggle Calm Mode (not Ctrl+C)
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        toggleCalm();
        return;
      }

      // "S" to snooze focused/selected task
      if (e.key === 's' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('mission-control:snooze-selected'));
        return;
      }

      // "[" to cycle sidebar collapse
      if (e.key === '[' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // "]" to toggle notifications panel
      if (e.key === ']' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        toggleNotificationsPanel();
        return;
      }

      // "?" to show help (future: shortcuts modal)
      if (e.key === '?' && e.shiftKey) {
        // Will open shortcuts help modal in future
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      if (gTimeout) clearTimeout(gTimeout);
    };
  }, [router, toggleZen, toggleCalm, toggleSidebar, toggleNotificationsPanel]);
}

/** Hook wrapper component — just include it in the layout */
export function KeyboardShortcuts() {
  useKeyboardShortcuts();
  return null;
}
