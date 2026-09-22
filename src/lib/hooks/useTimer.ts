'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export type TimerMode = 'focus' | 'deadline';
export type TimerState = 'idle' | 'running' | 'paused' | 'completed';

interface UseTimerOptions {
  mode: TimerMode;
  duration?: number;
  deadline?: string;
  taskId?: string | null;
  onComplete?: () => void;
  /** Legacy client-only timer key, removed only after a durable load succeeds. */
  persistKey?: string;
}

interface DurableActivity {
  id: string;
  taskId: string;
  mode: TimerMode;
  state: Exclude<TimerState, 'idle'> | 'cancelled';
  targetSeconds: number;
  elapsedSeconds: number;
  activeStartedAt: string | null;
  version: number;
}
interface ActivityResponse {
  activity: DurableActivity | null;
  serverNow: string;
  error?: string;
}
class TimerRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
interface UseTimerReturn {
  remaining: number;
  total: number;
  progress: number;
  state: TimerState;
  mode: TimerMode;
  loading: boolean;
  pending: boolean;
  error: string | null;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
}
function parseDeadline(deadline: string | undefined): number | null {
  if (!deadline) return null;
  const value = Date.parse(deadline);
  return Number.isFinite(value) ? value : null;
}

function clearLegacyTimer(key: string | undefined): void {
  if (!key || typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; the durable timer remains authoritative.
  }
}
function readTimerTask(key: string | undefined): string | null {
  if (!key || typeof window === 'undefined') return null;
  try { return localStorage.getItem(`${key}:task-id`); } catch { return null; }
}
function activityElapsed(activity: DurableActivity, serverNow: string): number {
  if (activity.state !== 'running' || !activity.activeStartedAt) {
    return activity.elapsedSeconds;
  }
  return Math.min(
    activity.targetSeconds,
    activity.elapsedSeconds + Math.max(
      0,
      Math.floor((Date.parse(serverNow) - Date.parse(activity.activeStartedAt)) / 1000),
    ),
  );
}

export function useTimer({
  mode,
  duration = 25 * 60,
  deadline,
  taskId,
  onComplete,
  persistKey,
}: UseTimerOptions): UseTimerReturn {
  const [state, setState] = useState<TimerState>('idle');
  const [remaining, setRemaining] = useState(duration);
  const [total, setTotal] = useState(duration);
  const [activeMode, setActiveMode] = useState(mode);
  const [loading, setLoading] = useState(Boolean(taskId || persistKey));
  const [pending, setPending] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endsAtRef = useRef(0);
  const activityRef = useRef<DurableActivity | null>(null);
  const onCompleteRef = useRef(onComplete);
  const completionFiredRef = useRef(false);
  const commandIdsRef = useRef(new Map<string, string>());
  const mutationPendingRef = useRef(false);
  const deferredLoadRef = useRef(false);
  onCompleteRef.current = onComplete;

  const clearTick = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }, []);

  const tick = useCallback(() => {
    const next = Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000));
    setRemaining(next);
    if (next === 0) {
      clearTick();
      setState('completed');
    }
  }, [clearTick]);

  const startTick = useCallback((seconds: number) => {
    clearTick();
    endsAtRef.current = Date.now() + seconds * 1000;
    intervalRef.current = setInterval(tick, 1000);
  }, [clearTick, tick]);

  const applyActivity = useCallback((activity: DurableActivity | null, serverNow: string) => {
    clearTick();
    activityRef.current = activity;
    if (persistKey && typeof window !== 'undefined') {
      try {
        const locatorKey = `${persistKey}:task-id`;
        if (activity && activity.state !== 'cancelled') localStorage.setItem(locatorKey, activity.taskId);
        else localStorage.removeItem(locatorKey);
      } catch { /* Storage may be unavailable. */ }
    }
    if (!activity || activity.state === 'cancelled') {
      setState('idle');
      return;
    }
    const elapsed = activityElapsed(activity, serverNow);
    const seconds = activity.state === 'completed'
      ? 0
      : Math.max(0, activity.targetSeconds - elapsed);
    setActiveMode(activity.mode);
    setTotal(activity.targetSeconds);
    setRemaining(seconds);
    setState(activity.state);
    if (activity.state === 'running' && seconds > 0) startTick(seconds);
  }, [clearTick, persistKey, startTick]);
  const commandId = useCallback((key: string) => {
    const existing = commandIdsRef.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    commandIdsRef.current.set(key, created);
    return created;
  }, []);

  const post = useCallback(async (
    ownerTaskId: string,
    body: Record<string, unknown>,
  ): Promise<ActivityResponse> => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(ownerTaskId)}/time-activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as ActivityResponse;
    if (!response.ok) {
      throw new TimerRequestError(payload.error || 'Timer action failed', response.status >= 500);
    }
    return payload;
  }, []);

  const finishMutation = useCallback(() => {
    mutationPendingRef.current = false;
    setPending(false);
    if (deferredLoadRef.current) setLoadRevision((value) => value + 1);
  }, []);
  const runTransition = useCallback(async (
    action: 'pause' | 'resume' | 'complete' | 'cancel',
  ) => {
    const activity = activityRef.current;
    if (!activity || mutationPendingRef.current) return false;
    const key = `${activity.id}:${action}:${activity.version}`;
    mutationPendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const payload = await post(activity.taskId, {
        action,
        activityId: activity.id,
        commandId: commandId(key),
        expectedVersion: activity.version,
      });
      commandIdsRef.current.delete(key);
      applyActivity(payload.activity, payload.serverNow);
      return true;
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : 'Timer action failed');
      const retryable = !(transitionError instanceof TimerRequestError) || transitionError.retryable;
      if (!retryable) deferredLoadRef.current = true;
      return retryable ? null : false;
    } finally {
      finishMutation();
    }
  }, [applyActivity, commandId, finishMutation, post]);
  useEffect(() => {
    if (mutationPendingRef.current) {
      deferredLoadRef.current = true;
      return;
    }
    deferredLoadRef.current = false;
    const active = activityRef.current;
    const locatedTaskId = readTimerTask(persistKey);
    const loadTaskId = active && (active.state === 'running' || active.state === 'paused')
      ? active.taskId
      : locatedTaskId || taskId;
    if (!loadTaskId) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(`/api/tasks/${encodeURIComponent(loadTaskId)}/time-activity`, {
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json() as ActivityResponse;
      if (response.status === 404) {
        applyActivity(null, '');
        clearLegacyTimer(persistKey);
        return;
      }
      if (!response.ok) throw new Error(payload.error || 'Failed to load timer');
      applyActivity(payload.activity, payload.serverNow);
      if (payload.activity?.state === 'completed') completionFiredRef.current = true;
      clearLegacyTimer(persistKey);
    }).catch((loadError) => {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError(loadError instanceof Error ? loadError.message : 'Failed to load timer');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [applyActivity, loadRevision, persistKey, taskId]);

  useEffect(() => {
    if (state !== 'completed' || completionFiredRef.current) return;
    completionFiredRef.current = true;
    if (activityRef.current) {
      let retry: ReturnType<typeof setTimeout>;
      const persistCompletion = () => void runTransition('complete').then((saved) => {
        if (saved) onCompleteRef.current?.();
        else if (saved === null) retry = setTimeout(persistCompletion, 1000);
      });
      persistCompletion();
      return () => clearTimeout(retry);
    } else {
      onCompleteRef.current?.();
    }
  }, [runTransition, state]);
  const start = useCallback(() => {
    if (loading || mutationPendingRef.current) return;
    let seconds = duration;
    if (mode === 'deadline') {
      const deadlineMs = parseDeadline(deadline);
      if (!deadlineMs && !taskId) return;
      seconds = deadlineMs ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : 0;
    }
    if (seconds <= 0 && !taskId) {
      setTotal(0);
      setRemaining(0);
      setState('completed');
      return;
    }
    completionFiredRef.current = false;
    setError(null);
    if (!taskId) {
      setActiveMode(mode);
      setTotal(seconds);
      setRemaining(seconds);
      setState('running');
      startTick(seconds);
      return;
    }
    mutationPendingRef.current = true;
    setPending(true);
    void post(taskId, {
      action: 'start',
      commandId: commandId('start'),
      mode,
      targetSeconds: seconds,
      deadline: mode === 'deadline' ? deadline : undefined,
    }).then((payload) => {
      commandIdsRef.current.delete('start');
      applyActivity(payload.activity, payload.serverNow);
    }).catch((startError) => {
      setError(startError instanceof Error ? startError.message : 'Timer start failed');
    }).finally(() => {
      finishMutation();
    });
  }, [applyActivity, commandId, deadline, duration, finishMutation, loading, mode, post, startTick, taskId]);
  const pause = useCallback(() => {
    if (state !== 'running') return;
    if (activityRef.current) {
      void runTransition('pause');
      return;
    }
    clearTick();
    setRemaining(Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000)));
    setState('paused');
  }, [clearTick, runTransition, state]);

  const resume = useCallback(() => {
    if (state !== 'paused') return;
    if (activityRef.current) {
      void runTransition('resume');
      return;
    }
    setState('running');
    startTick(remaining);
  }, [remaining, runTransition, startTick, state]);

  const reset = useCallback(() => {
    completionFiredRef.current = false;
    if (activityRef.current && activityRef.current.state !== 'cancelled') {
      void runTransition('cancel');
      return;
    }
    clearTick();
    activityRef.current = null;
    setState('idle');
    setActiveMode(mode);
    const deadlineMs = mode === 'deadline' ? parseDeadline(deadline) : null;
    const seconds = deadlineMs
      ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
      : mode === 'deadline' ? 0 : duration;
    setTotal(seconds);
    setRemaining(seconds);
  }, [clearTick, deadline, duration, mode, runTransition]);

  useEffect(() => () => clearTick(), [clearTick]);

  useEffect(() => {
    if (state !== 'idle' || loading) return;
    setActiveMode(mode);
    const deadlineMs = mode === 'deadline' ? parseDeadline(deadline) : null;
    const seconds = deadlineMs
      ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
      : mode === 'deadline' ? 0 : duration;
    setTotal(seconds);
    setRemaining(seconds);
  }, [deadline, duration, loading, mode, state]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && state === 'running') tick();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [state, tick]);

  return {
    remaining,
    total,
    progress: total > 0 ? Math.min(1, (total - remaining) / total) : 0,
    state,
    mode: activeMode,
    loading,
    pending,
    error,
    start,
    pause,
    resume,
    reset,
  };
}
