import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';

describe('usePrefersReducedMotion', () => {
  let matches = false;
  const listeners = new Set<() => void>();

  beforeEach(() => {
    matches = false;
    listeners.clear();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() {
        return matches;
      },
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  it('updates when the operating-system preference changes', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      matches = true;
      listeners.forEach((listener) => listener());
    });

    expect(result.current).toBe(true);
  });

  it('rechecks the preference when the window regains focus', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());

    act(() => {
      matches = true;
      window.dispatchEvent(new Event('focus'));
    });

    expect(result.current).toBe(true);
  });

  it('rechecks the preference when a visible page resumes', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    const visibilityState = vi.spyOn(document, 'visibilityState', 'get');

    act(() => {
      matches = true;
      visibilityState.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(result.current).toBe(true);

    act(() => {
      matches = false;
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(result.current).toBe(false);
  });
});
