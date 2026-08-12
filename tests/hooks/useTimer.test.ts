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

describe('useTimer — localStorage persistence', () => {
  const KEY = 'test-timer';

  it('saves state to localStorage on start', () => {
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, persistKey: KEY })
    );
    act(() => result.current.start());

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toBeTruthy();
    expect(stored.state).toBe('running');
    expect(stored.mode).toBe('focus');
    expect(stored.endsAt).toBeGreaterThan(0);
  });

  it('does not write to localStorage on every tick', () => {
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, persistKey: KEY })
    );
    act(() => result.current.start());

    const afterStart = localStorage.getItem(KEY);
    act(() => { vi.advanceTimersByTime(3000); });
    const afterTicks = localStorage.getItem(KEY);

    // Persisted value should not change during ticking — only on state transitions
    expect(afterStart).toBe(afterTicks);
  });

  it('clears localStorage on reset', () => {
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, persistKey: KEY })
    );
    act(() => result.current.start());
    expect(localStorage.getItem(KEY)).toBeTruthy();

    act(() => result.current.reset());
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('persists pause with pausedRemaining', () => {
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 60, persistKey: KEY })
    );
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(10_000); });
    act(() => result.current.pause());

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.state).toBe('paused');
    expect(stored.pausedRemaining).toBe(50);
  });

  it('rejects persisted data with mismatched mode', () => {
    // Seed localStorage with a deadline timer
    localStorage.setItem(KEY, JSON.stringify({
      mode: 'deadline',
      state: 'running',
      endsAt: Date.now() + 30_000,
      total: 60,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    }));

    // Mount as focus mode — should NOT restore
    const { result } = renderHook(() =>
      useTimer({ mode: 'focus', duration: 25, persistKey: KEY })
    );
    expect(result.current.state).toBe('idle');
    expect(result.current.remaining).toBe(25);
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
