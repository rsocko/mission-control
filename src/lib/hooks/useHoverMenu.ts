'use client';

import { useCallback, useEffect, useRef } from 'react';

const HOVER_CLOSE_DELAY_MS = 120;

export function useHoverMenu({
  enabled = true,
  onOpenChange,
}: {
  enabled?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingClose = useCallback(() => {
    if (!closeTimer.current) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const openOnHover = useCallback(() => {
    if (!enabled) return;
    cancelPendingClose();
    onOpenChange(true);
  }, [cancelPendingClose, enabled, onOpenChange]);

  const closeAfterHover = useCallback(() => {
    if (!enabled) return;
    cancelPendingClose();
    closeTimer.current = setTimeout(() => {
      onOpenChange(false);
      closeTimer.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelPendingClose, enabled, onOpenChange]);

  useEffect(() => cancelPendingClose, [cancelPendingClose]);

  return {
    openOnHover,
    closeAfterHover,
  };
}
