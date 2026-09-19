'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type MissionControlConnectivity = 'offline' | 'checking' | 'online';

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;
const PROBE_TIMEOUT_MS = 4_000;

async function probeReadiness(signal: AbortSignal): Promise<boolean> {
  const response = await fetch('/api/health/ready', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) return false;
  const result = await response.json() as { ready?: boolean };
  return result.ready === true;
}

/**
 * Browser network events only describe the local network. This hook verifies
 * that the configured Mission Control instance is actually reachable.
 */
export function useMissionControlConnectivity(): MissionControlConnectivity {
  const [status, setStatus] = useState<MissionControlConnectivity>(() => (
    typeof navigator === 'undefined' || navigator.onLine ? 'checking' : 'offline'
  ));
  const retryMs = useRef(INITIAL_RETRY_MS);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);

  const clearProbe = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const scheduleProbe = useCallback((delay: number) => {
    if (document.hidden || !navigator.onLine) return;
    timer.current = setTimeout(() => {
      const nextController = new AbortController();
      controller.current = nextController;
      const timeout = setTimeout(() => nextController.abort(), PROBE_TIMEOUT_MS);

      void probeReadiness(nextController.signal)
        .then((ready) => {
          if (nextController.signal.aborted) return;
          if (ready) {
            retryMs.current = INITIAL_RETRY_MS;
            setStatus('online');
            scheduleProbe(MAX_RETRY_MS);
          } else {
            setStatus('offline');
            retryMs.current = Math.min(retryMs.current * 2, MAX_RETRY_MS);
            scheduleProbe(retryMs.current);
          }
        })
        .catch(() => {
          if (nextController.signal.aborted) return;
          setStatus('offline');
          retryMs.current = Math.min(retryMs.current * 2, MAX_RETRY_MS);
          scheduleProbe(retryMs.current);
        })
        .finally(() => clearTimeout(timeout));
    }, delay);
  }, []);

  useEffect(() => {
    const goOffline = () => {
      clearProbe();
      setStatus('offline');
    };
    const goOnline = () => {
      clearProbe();
      retryMs.current = INITIAL_RETRY_MS;
      setStatus('checking');
      scheduleProbe(0);
    };
    const handleVisibility = () => {
      if (document.hidden) {
        clearProbe();
      } else if (navigator.onLine) {
        goOnline();
      }
    };

    if (navigator.onLine && !document.hidden) scheduleProbe(0);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearProbe();
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [clearProbe, scheduleProbe]);

  return status;
}
