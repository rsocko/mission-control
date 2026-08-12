'use client';

import {
  getMCNativeBridge,
  requestMCNativeBridge,
  type NativeBridgeWindow,
} from '@/lib/native/bridge';

/**
 * Utility to trigger haptic feedback on mobile devices.
 * Uses the versioned iOS bridge when available, then falls back to vibration.
 *
 * Covers:
 * - F-28: Add haptic feedback on swipe threshold
 * - #1525: Tiered haptic intensity (light=tap, medium=swipe, heavy=destructive)
 * - #1526: Respect system haptic / reduced-motion preferences
 */

export type HapticIntensity = 'light' | 'medium' | 'heavy';
export type HapticFeedbackPattern =
  | 'taskComplete'
  | 'defer'
  | 'priority'
  | 'refreshThreshold'
  | 'delete'
  | 'triageComplete';

const DURATIONS: Record<HapticIntensity, number | number[]> = {
  light: 5,
  medium: 15,
  heavy: [10, 30, 10],
};

const PATTERNS: Record<HapticFeedbackPattern, {
  fallback: number | number[];
  payload: {
    type: 'success' | 'impact' | 'warning' | 'selection';
    intensity?: number;
  };
}> = {
  taskComplete: {
    fallback: 15,
    payload: { type: 'success' },
  },
  defer: {
    fallback: 5,
    payload: { type: 'impact', intensity: 0.35 },
  },
  priority: {
    fallback: 15,
    payload: { type: 'impact', intensity: 0.75 },
  },
  refreshThreshold: {
    fallback: 5,
    payload: { type: 'selection', intensity: 0.3 },
  },
  delete: {
    fallback: [10, 30, 10],
    payload: { type: 'warning' },
  },
  triageComplete: {
    fallback: [5, 45, 10, 45, 15],
    payload: { type: 'success', intensity: 1 },
  },
};

/** Cached reduced-motion preference (evaluated once per page load). */
let _prefersReducedMotion: boolean | null = null;

function prefersReducedMotion(): boolean {
  if (_prefersReducedMotion === null) {
    _prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
  }
  return _prefersReducedMotion;
}

function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

function requestNativeHaptic(
  payload: (typeof PATTERNS)[HapticFeedbackPattern]['payload'],
  fallback: number | number[],
) {
  if (typeof window === 'undefined') {
    vibrate(fallback);
    return;
  }

  const windowObject = window as unknown as NativeBridgeWindow;
  const configuredOrigin = window.location.origin;
  const bridge = getMCNativeBridge(windowObject, configuredOrigin);
  if (!bridge?.capabilities.includes('haptics')) {
    vibrate(fallback);
    return;
  }

  void requestMCNativeBridge({
    action: 'hapticFeedback',
    configuredOrigin,
    payload,
    windowObject,
  }).then((response) => {
    if (!response.ok) {
      vibrate(fallback);
    }
  }).catch(() => {
    vibrate(fallback);
  });
}

export function triggerHaptic(intensity: HapticIntensity = 'medium') {
  if (prefersReducedMotion()) return;
  vibrate(DURATIONS[intensity]);
}

export function triggerHapticFeedback(pattern: HapticFeedbackPattern) {
  if (prefersReducedMotion()) return;
  const configuration = PATTERNS[pattern];
  requestNativeHaptic(configuration.payload, configuration.fallback);
}

/** Reset the cached preference (useful if the user toggles the setting at runtime). */
export function resetHapticPreference() {
  _prefersReducedMotion = null;
}
