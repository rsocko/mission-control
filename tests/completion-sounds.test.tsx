import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_SOUND_PREFERENCES_EVENT,
  COMPLETION_SOUND_PREFERENCES_KEY,
  DEFAULT_COMPLETION_SOUND_PREFERENCES,
  getCompletionSoundPreferences,
  isRewardMilestone,
  setCompletionSoundPreferences,
} from '@/lib/completion-sounds';

describe('completion sound preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults both completion and reward sounds to off', () => {
    expect(getCompletionSoundPreferences()).toEqual(DEFAULT_COMPLETION_SOUND_PREFERENCES);
  });

  it('persists sound choices and announces same-tab updates', () => {
    const changed = vi.fn();
    window.addEventListener(COMPLETION_SOUND_PREFERENCES_EVENT, changed);

    setCompletionSoundPreferences({
      completionSound: 'soft-tap',
      rewardSound: 'gentle-rise',
    });

    expect(getCompletionSoundPreferences()).toEqual({
      completionSound: 'soft-tap',
      rewardSound: 'gentle-rise',
      muted: false,
    });
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener(COMPLETION_SOUND_PREFERENCES_EVENT, changed);
  });

  it('rejects malformed stored preferences and safely returns defaults', () => {
    localStorage.setItem(COMPLETION_SOUND_PREFERENCES_KEY, JSON.stringify({
      completionSound: 'air-horn',
      rewardSound: 'none',
      muted: false,
    }));

    expect(getCompletionSoundPreferences()).toEqual(DEFAULT_COMPLETION_SOUND_PREFERENCES);
  });

  it('recognizes a reward milestone only once at the configured threshold', () => {
    expect(isRewardMilestone(5, 5, 0)).toBe(true);
    expect(isRewardMilestone(5, 5, 1)).toBe(false);
    expect(isRewardMilestone(6, 5, 0)).toBe(false);
    expect(isRewardMilestone(0, 5, 0)).toBe(false);
    expect(isRewardMilestone(5, 0, 0)).toBe(false);
  });
});
