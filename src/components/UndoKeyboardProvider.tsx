'use client';

import { useEffect } from 'react';
import { executeUndo } from '@/lib/stores/undoStore';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';

/**
 * Global keyboard listener for Ctrl+Z / Cmd+Z undo.
 * Skips when focus is in an input/textarea/contenteditable to avoid
 * interfering with native browser undo.
 */
export function UndoKeyboardProvider() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (shouldBlockGlobalShortcut(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        const target = e.target as HTMLElement | null;
        // Don't intercept native undo in form fields
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        executeUndo();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return null;
}
