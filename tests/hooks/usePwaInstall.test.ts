/**
 * usePwaInstall Hook — Unit Tests
 * Tests for #1092: PWA install prompts (iOS Safari, Chrome)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePwaInstall } from '@/lib/hooks/usePwaInstall';

beforeEach(() => {
  localStorage.clear();
  // Default: not standalone
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePwaInstall — default state', () => {
  it('reports not installable when no event fires and not iOS', () => {
    const { result } = renderHook(() => usePwaInstall());
    // After useEffect runs, isInstalled should be false (not standalone)
    expect(result.current.platform).toBe(null);
  });

  it('reports isInstalled when standalone mode is active', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(display-mode: standalone)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.isInstalled).toBe(true);
    expect(result.current.canPrompt).toBe(false);
  });
});

describe('usePwaInstall — Chrome/Chromium', () => {
  it('captures beforeinstallprompt and allows prompting', async () => {
    const { result } = renderHook(() => usePwaInstall());

    // Simulate Chrome firing beforeinstallprompt
    const mockPrompt = vi.fn().mockResolvedValue({ outcome: 'accepted' });
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperty(event, 'prompt', { value: mockPrompt });
    Object.defineProperty(event, 'userChoice', {
      value: Promise.resolve({ outcome: 'accepted' }),
    });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(result.current.canPrompt).toBe(true);
    expect(result.current.platform).toBe('chromium');

    // Trigger install
    let accepted = false;
    await act(async () => {
      accepted = await result.current.promptInstall();
    });

    expect(mockPrompt).toHaveBeenCalled();
    expect(accepted).toBe(true);
    expect(result.current.isInstalled).toBe(true);
    expect(result.current.canPrompt).toBe(false);
  });

  it('handles user dismissing the prompt', async () => {
    const { result } = renderHook(() => usePwaInstall());

    const mockPrompt = vi.fn().mockResolvedValue({ outcome: 'dismissed' });
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperty(event, 'prompt', { value: mockPrompt });
    Object.defineProperty(event, 'userChoice', {
      value: Promise.resolve({ outcome: 'dismissed' }),
    });

    act(() => {
      window.dispatchEvent(event);
    });

    let accepted = false;
    await act(async () => {
      accepted = await result.current.promptInstall();
    });

    expect(accepted).toBe(false);
    expect(result.current.isInstalled).toBe(false);
  });
});

describe('usePwaInstall — iOS Safari', () => {
  it('detects iOS Safari and sets platform', () => {
    Object.defineProperty(navigator, 'userAgent', {
      writable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });

    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.platform).toBe('ios');
    expect(result.current.canPrompt).toBe(true);
  });
});

describe('usePwaInstall — dismiss', () => {
  it('hides prompt after dismiss and respects 30-day cooldown', () => {
    // Simulate beforeinstallprompt
    const { result, unmount } = renderHook(() => usePwaInstall());

    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperty(event, 'prompt', {
      value: vi.fn().mockResolvedValue({ outcome: 'dismissed' }),
    });

    act(() => {
      window.dispatchEvent(event);
    });
    expect(result.current.canPrompt).toBe(true);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.canPrompt).toBe(false);
    expect(localStorage.getItem('mission-control:pwa-install-dismissed')).toBeTruthy();

    // Re-render — should still be dismissed
    unmount();
    const { result: result2 } = renderHook(() => usePwaInstall());
    expect(result2.current.canPrompt).toBe(false);
  });
});
