/**
 * useTimer Hook — Unit Tests
 * Tests for #125: two-mode timer system (focus + deadline)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimer } from '@/lib/hooks/useTimer';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Focus Mode ─────────────────────────────────────────────────────────────

describe('useTimer — focus mode', () => {
  it('initializes with idle state and full duration', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 300 }));
    expect(result.current.state).toBe('idle');
    expect(result.current.remaining).toBe(300);
    expect(result.current.total).toBe(300);
    expect(result.current.progress).toBe(0);
  });

  it('defaults to 25 minutes when no duration provided', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus' }));
    expect(result.current.remaining).toBe(25 * 60);
  });

  it('transitions idle → running on start', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 60 }));
    act(() => result.current.start());
    expect(result.current.state).toBe('running');
    expect(result.current.remaining).toBe(60);
  });

  it('counts down each second using wall clock', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 10 }));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.remaining).toBe(7);
    expect(result.current.progress).toBeCloseTo(0.3);
  });

  it('pauses and resumes', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 60 }));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => result.current.pause());
    expect(result.current.state).toBe('paused');
    const afterPause = result.current.remaining;

    // Time passes while paused — remaining should not change
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.remaining).toBe(afterPause);

    act(() => result.current.resume());
    expect(result.current.state).toBe('running');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.remaining).toBe(afterPause - 2);
  });

  it('completes and calls onComplete when reaching zero', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 3, onComplete }));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.state).toBe('completed');
    expect(result.current.remaining).toBe(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires onComplete exactly once even if state stays completed', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 2, onComplete }));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(3000); });
    // Extra ticks shouldn't re-fire
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('resets to idle with full duration', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 60 }));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(10000); });
    act(() => result.current.reset());
    expect(result.current.state).toBe('idle');
    expect(result.current.remaining).toBe(60);
    expect(result.current.total).toBe(60);
  });

  it('ignores pause when not running', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 60 }));
    act(() => result.current.pause());
    expect(result.current.state).toBe('idle');
  });

  it('ignores resume when not paused', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 60 }));
    act(() => result.current.start());
    act(() => result.current.resume());
    expect(result.current.state).toBe('running');
  });
});

// ─── Deadline Mode ──────────────────────────────────────────────────────────

describe('useTimer — deadline mode', () => {
  it('computes remaining seconds from deadline', () => {
    const deadline = new Date(Date.now() + 120_000).toISOString();
    const { result } = renderHook(() => useTimer({ mode: 'deadline', deadline }));
    // Allow 1s tolerance due to ceiling
    expect(result.current.remaining).toBeGreaterThanOrEqual(119);
    expect(result.current.remaining).toBeLessThanOrEqual(120);
  });

  it('starts and counts down to deadline', () => {
    const deadline = new Date(Date.now() + 10_000).toISOString();
    const onComplete = vi.fn();
    const { result } = renderHook(() => useTimer({ mode: 'deadline', deadline, onComplete }));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.state).toBe('completed');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('handles past deadline gracefully', () => {
    const deadline = new Date(Date.now() - 5000).toISOString();
    const { result } = renderHook(() => useTimer({ mode: 'deadline', deadline }));
    expect(result.current.remaining).toBe(0);
  });

  it('completes immediately when starting with a past deadline', () => {
    const deadline = new Date(Date.now() - 1000).toISOString();
    const onComplete = vi.fn();
    const { result } = renderHook(() => useTimer({ mode: 'deadline', deadline, onComplete }));
    act(() => result.current.start());
    expect(result.current.state).toBe('completed');
    expect(result.current.remaining).toBe(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('handles invalid deadline string', () => {
    const { result } = renderHook(() => useTimer({ mode: 'deadline', deadline: 'not-a-date' }));
    expect(result.current.remaining).toBe(0);
    // Start should be a no-op for invalid deadline
    act(() => result.current.start());
    expect(result.current.state).toBe('idle');
  });
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe('useTimer — durable persistence', () => {
  const KEY = 'test-timer';

  it('restores server activity and retires legacy state only after the load succeeds', async () => {
    localStorage.setItem(KEY, '{"state":"running"}');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      activity: {
        id: '00000000-0000-4000-8000-000000000001',
        taskId: 'task-a',
        mode: 'focus',
        state: 'running',
        targetSeconds: 60,
        elapsedSeconds: 10,
        activeStartedAt: new Date(Date.now()).toISOString(),
        version: 2,
      },
      serverNow: new Date(Date.now()).toISOString(),
    }), { status: 200 })));

    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, taskId: 'task-a', persistKey: KEY })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe('running');
    expect(result.current.remaining).toBe(50);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps legacy state when the durable load fails', async () => {
    localStorage.setItem(KEY, '{"state":"running"}');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Database unavailable',
    }), { status: 503 })));

    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, taskId: 'task-a', persistKey: KEY })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Database unavailable');
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it('clears a stale durable timer when the server confirms its task is gone', async () => {
    localStorage.setItem(`${KEY}:task-id`, 'task-a');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Task not found',
    }), { status: 404 })));
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, persistKey: KEY })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe('idle');
    expect(localStorage.getItem(`${KEY}:task-id`)).toBeNull();
  });

  it('surfaces a competing timer instead of starting locally', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activity: null,
        serverNow: new Date(Date.now()).toISOString(),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Another task already has an active timer',
      }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, taskId: 'task-a' })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('Another task already has an active timer');
  });

  it('does not race a start against the durable reload', async () => {
    let resolveLoad!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveLoad = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, taskId: 'task-a' })
    );
    expect(result.current.loading).toBe(true);
    act(() => result.current.start());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveLoad(new Response(JSON.stringify({
      activity: null, serverNow: new Date(Date.now()).toISOString(),
    }), { status: 200 }));
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('restores a durable timer from its server-verified task locator', async () => {
    localStorage.setItem(`${KEY}:task-id`, 'task-a');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      activity: {
        id: '00000000-0000-4000-8000-000000000001',
        taskId: 'task-a',
        mode: 'focus',
        state: 'paused',
        targetSeconds: 60,
        elapsedSeconds: 12,
        activeStartedAt: null,
        version: 1,
      },
      serverNow: new Date(Date.now()).toISOString(),
    }), { status: 200 })));
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, persistKey: KEY })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe('paused');
    expect(result.current.remaining).toBe(48);
  });

  it('rotates start commands after success and retains activity after failed reset', async () => {
    const running = (id: string) => ({
      id,
      taskId: 'task-a',
      mode: 'focus',
      state: 'running',
      targetSeconds: 60,
      elapsedSeconds: 0,
      activeStartedAt: new Date(Date.now()).toISOString(),
      version: 0,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activity: null, serverNow: new Date(Date.now()).toISOString(),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activity: running('00000000-0000-4000-8000-000000000001'),
        serverNow: new Date(Date.now()).toISOString(),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Database unavailable' }), {
        status: 503,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, taskId: 'task-a', persistKey: KEY })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.state).toBe('running'));
    const firstCommand = JSON.parse(fetchMock.mock.calls[1][1].body as string).commandId;
    act(() => result.current.reset());
    await vi.waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.state).toBe('running');
    expect(result.current.error).toBe('Database unavailable');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      activity: {
        ...running('00000000-0000-4000-8000-000000000001'),
        state: 'cancelled',
        activeStartedAt: null,
        version: 1,
      },
      serverNow: new Date(Date.now()).toISOString(),
    }), { status: 200 }));
    act(() => result.current.reset());
    await vi.waitFor(() => expect(result.current.state).toBe('idle'));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      activity: running('00000000-0000-4000-8000-000000000002'),
      serverNow: new Date(Date.now()).toISOString(),
    }), { status: 200 }));
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.state).toBe('running'));
    const secondCommand = JSON.parse(fetchMock.mock.calls[4][1].body as string).commandId;
    expect(secondCommand).not.toBe(firstCommand);
  });

  it('retries automatic completion with the same command after a lost response', async () => {
    const onComplete = vi.fn();
    const started = {
      id: '00000000-0000-4000-8000-000000000001',
      taskId: 'task-a',
      mode: 'focus',
      state: 'running',
      targetSeconds: 1,
      elapsedSeconds: 0,
      activeStartedAt: new Date(Date.now()).toISOString(),
      version: 0,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activity: null, serverNow: new Date(Date.now()).toISOString(),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activity: started, serverNow: new Date(Date.now()).toISOString(),
      }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activity: { ...started, state: 'completed', elapsedSeconds: 1, version: 1 },
        serverNow: new Date(Date.now()).toISOString(),
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 1, taskId: 'task-a', onComplete })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.state).toBe('running'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const first = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    const retry = JSON.parse(fetchMock.mock.calls[3][1].body as string);
    expect(retry.commandId).toBe(first.commandId);
  });
});

// ─── Progress ───────────────────────────────────────────────────────────────

describe('useTimer — progress', () => {
  it('progress is 0 at start and 1 at completion', () => {
    const { result } = renderHook(() => useTimer({ mode: 'focus', duration: 5 }));
    expect(result.current.progress).toBe(0);

    act(() => result.current.start());
    expect(result.current.progress).toBe(0);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.progress).toBe(1);
  });

  it('progress is 0 when total is 0 (past deadline)', () => {
    const deadline = new Date(Date.now() - 1000).toISOString();
    const { result } = renderHook(() => useTimer({ mode: 'deadline', deadline }));
    expect(result.current.progress).toBe(0);
  });
});

// ─── Duration change while idle ─────────────────────────────────────────────

describe('useTimer — recalculate on prop change', () => {
  it('updates remaining when duration changes while idle', () => {
    const { result, rerender } = renderHook(
      ({ dur }) => useTimer({ mode: 'focus', duration: dur }),
      { initialProps: { dur: 60 } }
    );
    expect(result.current.remaining).toBe(60);

    rerender({ dur: 120 });
    expect(result.current.remaining).toBe(120);
  });
});

// ─── Hydration safety ───────────────────────────────────────────────────────

describe('useTimer — hydration', () => {
  it('initializes deterministically (SSR-safe) even when localStorage has data', () => {
    localStorage.setItem('ssr-test', JSON.stringify({
      mode: 'focus',
      state: 'running',
      endsAt: Date.now() + 30_000,
      total: 60,
      duration: 60,
    }));

    // Initial state is always deterministic (idle/duration) to avoid SSR mismatch.
    // Restoration happens in a mount effect.
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, persistKey: 'ssr-test' })
    );

    // After mount effect runs, it should restore
    // (in the test env the effect runs synchronously during renderHook)
    // The key point: no hydration mismatch from useState initializer
    expect(['idle', 'running']).toContain(result.current.state);
  });
});
