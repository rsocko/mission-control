export interface QuickAddPreferences {
  naturalLanguageDates: boolean;
  preserveText: boolean;
}

export const QUICK_ADD_PREFERENCES_KEY = 'mc:quick-add-preferences';
export const QUICK_ADD_PREFERENCES_EVENT = 'mission-control:quick-add-preferences-changed';

export const DEFAULT_QUICK_ADD_PREFERENCES: QuickAddPreferences = {
  naturalLanguageDates: true,
  preserveText: false,
};

export function getQuickAddPreferences(): QuickAddPreferences {
  if (typeof window === 'undefined') return DEFAULT_QUICK_ADD_PREFERENCES;
  try {
    const stored = JSON.parse(localStorage.getItem(QUICK_ADD_PREFERENCES_KEY) || '{}') as Partial<QuickAddPreferences>;
    return {
      naturalLanguageDates: stored.naturalLanguageDates ?? DEFAULT_QUICK_ADD_PREFERENCES.naturalLanguageDates,
      preserveText: stored.preserveText ?? DEFAULT_QUICK_ADD_PREFERENCES.preserveText,
    };
  } catch {
    return DEFAULT_QUICK_ADD_PREFERENCES;
  }
}

export function setQuickAddPreferences(preferences: QuickAddPreferences): void {
  localStorage.setItem(QUICK_ADD_PREFERENCES_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent(QUICK_ADD_PREFERENCES_EVENT, { detail: preferences }));
}
