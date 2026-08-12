import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test the module fresh each time to reset the cached preference
let triggerHaptic: typeof import('@/lib/utils/haptics').triggerHaptic;
let triggerHapticFeedback: typeof import('@/lib/utils/haptics').triggerHapticFeedback;
let resetHapticPreference: typeof import('@/lib/utils/haptics').resetHapticPreference;

describe('haptics utility', () => {
  let vibrateSpy: ReturnType<typeof vi.fn>;
  let matchMediaSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset module cache so _prefersReducedMotion starts as null
    vi.resetModules();

    vibrateSpy = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', {
      value: vibrateSpy,
      writable: true,
      configurable: true,
    });

    matchMediaSpy = vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(window, 'matchMedia', {
      value: matchMediaSpy,
      writable: true,
      configurable: true,
    });

    const mod = await import('@/lib/utils/haptics');
    triggerHaptic = mod.triggerHaptic;
    triggerHapticFeedback = mod.triggerHapticFeedback;
    resetHapticPreference = mod.resetHapticPreference;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).isMCNativeApp;
    delete (window as unknown as Record<string, unknown>).MCNativeContext;
    delete (window as unknown as Record<string, unknown>).mcNativeBridge;
  });

  it('triggers vibration with light intensity (5ms)', () => {
    triggerHaptic('light');
    expect(vibrateSpy).toHaveBeenCalledWith(5);
  });

  it('triggers vibration with medium intensity (15ms)', () => {
    triggerHaptic('medium');
    expect(vibrateSpy).toHaveBeenCalledWith(15);
  });

  it('triggers vibration with heavy intensity (pattern)', () => {
    triggerHaptic('heavy');
    expect(vibrateSpy).toHaveBeenCalledWith([10, 30, 10]);
  });

  it('defaults to medium intensity', () => {
    triggerHaptic();
    expect(vibrateSpy).toHaveBeenCalledWith(15);
  });

  it('does not vibrate when prefers-reduced-motion is enabled', async () => {
    vi.resetModules();
    matchMediaSpy = vi.fn(() => ({ matches: true }));
    Object.defineProperty(window, 'matchMedia', {
      value: matchMediaSpy,
      writable: true,
      configurable: true,
    });

    const mod = await import('@/lib/utils/haptics');
    mod.triggerHaptic('medium');
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it('caches the reduced-motion preference', () => {
    triggerHaptic('light');
    triggerHaptic('medium');
    // matchMedia should only be called once (cached after first call)
    expect(matchMediaSpy).toHaveBeenCalledTimes(1);
  });

  it('resets cached preference when resetHapticPreference is called', async () => {
    triggerHaptic('light');
    expect(matchMediaSpy).toHaveBeenCalledTimes(1);

    resetHapticPreference();
    triggerHaptic('light');
    // Should have been called again after reset
    expect(matchMediaSpy).toHaveBeenCalledTimes(2);
  });

  it('does not throw when navigator.vibrate is unavailable', () => {
    Object.defineProperty(navigator, 'vibrate', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    expect(() => triggerHaptic('medium')).not.toThrow();
  });

  it.each([
    ['taskComplete', { type: 'success' }],
    ['defer', { type: 'impact', intensity: 0.35 }],
    ['priority', { type: 'impact', intensity: 0.75 }],
    ['refreshThreshold', { type: 'selection', intensity: 0.3 }],
    ['delete', { type: 'warning' }],
    ['triageComplete', { type: 'success', intensity: 1 }],
  ] as const)('maps %s to the versioned native payload', async (pattern, payload) => {
    const request = installNativeBridge({ delivered: true });

    triggerHapticFeedback(pattern);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('hapticFeedback', payload);
    });
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it('falls back once when native delivery fails', async () => {
    const request = installNativeBridge(new Error('engine unavailable'));

    triggerHapticFeedback('triageComplete');

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(vibrateSpy).toHaveBeenCalledOnce();
    });
    expect(vibrateSpy).toHaveBeenCalledWith([5, 45, 10, 45, 15]);
  });

  it('does not bypass native accessibility suppression', async () => {
    const request = installNativeBridge({ delivered: false });

    triggerHapticFeedback('taskComplete');

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it('falls back when the bridge does not advertise haptics', () => {
    installNativeBridge({ delivered: true }, ['badge']);

    triggerHapticFeedback('taskComplete');

    expect(vibrateSpy).toHaveBeenCalledWith(15);
  });

  function installNativeBridge(
    outcome: { delivered: boolean } | Error,
    capabilities = ['haptics'],
  ) {
    const request = vi.fn(async (action: string) => {
      if (outcome instanceof Error) throw outcome;
      return {
        version: 1,
        requestId: '8cf177a0-e46a-46fa-824c-4c34004e2423',
        action,
        ok: true,
        result: outcome,
      };
    });
    const nativeWindow = window as unknown as Record<string, unknown>;
    nativeWindow.isMCNativeApp = true;
    nativeWindow.MCNativeContext = Object.freeze({
      platform: 'ios',
      contractVersion: 1,
    });
    nativeWindow.mcNativeBridge = Object.freeze({
      contractVersion: 1,
      capabilities: Object.freeze(capabilities),
      supportedActions: Object.freeze(['hapticFeedback']),
      request,
      addEventListener: vi.fn(() => () => undefined),
    });
    return request;
  }
});
