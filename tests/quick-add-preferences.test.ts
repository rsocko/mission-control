import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QUICK_ADD_PREFERENCES,
  getQuickAddPreferences,
  QUICK_ADD_PREFERENCES_EVENT,
  QUICK_ADD_PREFERENCES_KEY,
  setQuickAddPreferences,
} from '@/lib/quick-add-preferences';

describe('Quick Add preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses safe defaults when no preferences are stored', () => {
    expect(getQuickAddPreferences()).toEqual(DEFAULT_QUICK_ADD_PREFERENCES);
  });

  it('persists preferences and notifies mounted entry points', () => {
    const listener = vi.fn();
    window.addEventListener(QUICK_ADD_PREFERENCES_EVENT, listener);

    setQuickAddPreferences({ naturalLanguageDates: false, preserveText: true });

    expect(JSON.parse(localStorage.getItem(QUICK_ADD_PREFERENCES_KEY) || '{}')).toEqual({
      naturalLanguageDates: false,
      preserveText: true,
    });
    expect(getQuickAddPreferences()).toEqual({
      naturalLanguageDates: false,
      preserveText: true,
    });
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(QUICK_ADD_PREFERENCES_EVENT, listener);
  });

  it('falls back when stored data is invalid', () => {
    localStorage.setItem(QUICK_ADD_PREFERENCES_KEY, '{invalid');
    expect(getQuickAddPreferences()).toEqual(DEFAULT_QUICK_ADD_PREFERENCES);
  });
});
