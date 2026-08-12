'use client';

import { useEffect } from 'react';
import { installBackgroundAiToastListener } from '@/lib/ai/useBackgroundAiTasks';

/**
 * Eagerly installs the background AI toast listener at app startup.
 * Ensures completed/failed AI tasks always show a toast notification
 * regardless of which page the user is currently viewing.
 */
export function BackgroundAiToastProvider() {
  useEffect(() => {
    installBackgroundAiToastListener();
  }, []);

  return null;
}
