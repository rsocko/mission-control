'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export type TimerMode = 'focus' | 'deadline';
export type TimerState = 'idle' | 'running' | 'paused' | 'completed';

interface UseTimerOptions {
  mode: TimerMode;
  /** Duration in seconds (for focus mode) */
  duration?: number;
  /** Target deadline ISO string (for deadline mode) */
  deadline?: string;
  onComplete?: () => void;
  /** localStorage key for persistence (omit to disable) */
  persistKey?: string;
}

interface UseTimerReturn {
  /** Remaining time in seconds */
  remaining: number;
  /** Total duration in seconds */
  total: number;
  /** Progress 0..1 (elapsed / total) */
  progress: number;
  state: TimerState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
}

// ─── Persistence helpers ────────────────────────────────────────────────────

interface PersistedTimer {
  mode: TimerMode;
  state: TimerState;
  /** Wall-clock timestamp (ms) when the timer ends — the source of truth */
  endsAt: number;
  total: number;
  /** Only set when paused — seconds remaining at pause time */
  pausedRemaining?: number;
  deadline?: string;
  duration?: number;
}

function loadPersisted(key: string): PersistedTimer | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedTimer;
  } catch {
    return null;
  }
}

function savePersisted(key: string, data: PersistedTimer) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch { /* quota exceeded — silently ignore */ }
}

function clearPersisted(key: string) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch { /* ignore */ }
}

function parseDeadline(deadline: string | undefined): number | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useTimer({
  mode,
  duration = 25 * 60,
  deadline,
  onComplete,
  persistKey,
}: UseTimerOptions): UseTimerReturn {
  // ── Deterministic initial state (SSR-safe) ────────────────────────────
  const [state, setState] = useState<TimerState>('idle');
  const [remaining, setRemaining] = useState(duration);
  const [total, setTotal] = useState(duration);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Wall-clock end time — the single source of truth while running
  const endsAtRef = useRef<number>(0);
  // Track whether we've restored from persistence
  const didRestore = useRef(false);
  // One-shot guard so completion callback fires exactly once
  const completionFiredRef = useRef(false);

  const clearTick = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ── Wall-clock tick ───────────────────────────────────────────────────
  const tick = useCallback(() => {
    const now = Date.now();
    const secsLeft = Math.max(0, Math.ceil((endsAtRef.current - now) / 1000));
    setRemaining(secsLeft);
    if (secsLeft <= 0) {
      clearTick();
      setState('completed');
    }
  }, [clearTick]);

  // ── Completion side-effect (outside state updater) ────────────────────
  useEffect(() => {
    if (state === 'completed' && !completionFiredRef.current) {
      completionFiredRef.current = true;
      onCompleteRef.current?.();
    }
  }, [state]);

  // ── Restore from persistence on mount (avoids hydration mismatch) ─────
  useEffect(() => {
    if (didRestore.current || !persistKey) return;
    didRestore.current = true;

    const p = loadPersisted(persistKey);
    if (!p) return;

    // Validate persisted record matches current config
    if (p.mode !== mode) { clearPersisted(persistKey); return; }
    if (mode === 'focus' && p.duration !== duration) { clearPersisted(persistKey); return; }
    if (mode === 'deadline' && p.deadline !== deadline) { clearPersisted(persistKey); return; }

    setTotal(p.total);

    if (p.state === 'running') {
      const secsLeft = Math.max(0, Math.ceil((p.endsAt - Date.now()) / 1000));
      if (secsLeft <= 0) {
        setRemaining(0);
        setState('completed');
      } else {
        endsAtRef.current = p.endsAt;
        setRemaining(secsLeft);
        setState('running');
        intervalRef.current = setInterval(tick, 1000);
      }
    } else if (p.state === 'paused' && p.pausedRemaining !== undefined) {
      setRemaining(p.pausedRemaining);
      setState('paused');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist on state transitions only (not every tick) ────────────────
  const persist = useCallback((
    newState: TimerState,
    newTotal: number,
    opts?: { pausedRemaining?: number },
  ) => {
    if (!persistKey) return;
    if (newState === 'idle') {
      clearPersisted(persistKey);
      return;
    }
    savePersisted(persistKey, {
      mode,
      state: newState,
      endsAt: endsAtRef.current,
      total: newTotal,
      pausedRemaining: opts?.pausedRemaining,
      deadline,
      duration,
    });
  }, [persistKey, mode, deadline, duration]);

  // ── Actions ───────────────────────────────────────────────────────────
  const start = useCallback(() => {
    let secs: number;
    if (mode === 'deadline' && deadline) {
      const deadlineMs = parseDeadline(deadline);
      if (!deadlineMs) return; // invalid deadline — don't start
      secs = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      if (secs <= 0) {
        // Already past deadline — complete immediately
        setTotal(0);
        setRemaining(0);
        setState('completed');
        persist('completed', 0);
        return;
      }
    } else {
      secs = duration;
    }

    endsAtRef.current = Date.now() + secs * 1000;
    completionFiredRef.current = false;
    setTotal(secs);
    setRemaining(secs);
    setState('running');
    clearTick();
    intervalRef.current = setInterval(tick, 1000);
    persist('running', secs);
  }, [mode, deadline, duration, tick, clearTick, persist]);

  const pause = useCallback(() => {
    if (state !== 'running') return;
    clearTick();
    const secsLeft = Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000));
    setRemaining(secsLeft);
    setState('paused');
    persist('paused', total, { pausedRemaining: secsLeft });
  }, [state, clearTick, total, persist]);

  const resume = useCallback(() => {
    if (state !== 'paused') return;
    endsAtRef.current = Date.now() + remaining * 1000;
    completionFiredRef.current = false;
    setState('running');
    intervalRef.current = setInterval(tick, 1000);
    persist('running', total);
  }, [state, remaining, tick, total, persist]);

  const reset = useCallback(() => {
    clearTick();
    completionFiredRef.current = false;
    setState('idle');
    if (mode === 'deadline' && deadline) {
      const deadlineMs = parseDeadline(deadline);
      const secs = deadlineMs ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : 0;
      setTotal(secs);
      setRemaining(secs);
    } else {
      setRemaining(duration);
      setTotal(duration);
    }
    if (persistKey) clearPersisted(persistKey);
  }, [mode, deadline, duration, clearTick, persistKey]);

  // ── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => clearTick();
  }, [clearTick]);

  // ── Recalculate when mode/duration/deadline change while idle ─────────
  useEffect(() => {
    if (state === 'idle') {
      completionFiredRef.current = false;
      if (mode === 'deadline' && deadline) {
        const deadlineMs = parseDeadline(deadline);
        const secs = deadlineMs ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : 0;
        setTotal(secs);
        setRemaining(secs);
      } else {
        setTotal(duration);
        setRemaining(duration);
      }
    }
  }, [mode, duration, deadline, state]);

  // ── Re-sync on visibility change (handles tab backgrounding) ─────────
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && state === 'running') {
        tick(); // immediate re-sync from wall clock
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [state, tick]);

  const progress = total > 0 ? Math.min(1, (total - remaining) / total) : 0;

  return { remaining, total, progress, state, start, pause, resume, reset };
}
