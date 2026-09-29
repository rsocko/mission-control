'use client';

import { useEffect } from 'react';
import {
  COMPLETION_FEEDBACK_EVENT,
  getCompletionSoundPreferences,
  playCompletionSound,
  unlockCompletionAudio,
} from '@/lib/completion-sounds';

export function CompletionSoundController() {
  useEffect(() => {
    const unlock = () => {
      const preferences = getCompletionSoundPreferences();
      if (
        preferences.muted
        || (preferences.completionSound === 'none' && preferences.rewardSound === 'none')
      ) {
        return;
      }
      void unlockCompletionAudio();
    };
    const handleFeedback = (event: Event) => {
      const preferences = getCompletionSoundPreferences();
      if (preferences.muted) return;
      const reward = (event as CustomEvent<{ reward?: boolean }>).detail?.reward === true;
      void playCompletionSound(reward ? preferences.rewardSound : preferences.completionSound);
    };

    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    window.addEventListener(COMPLETION_FEEDBACK_EVENT, handleFeedback);
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
      window.removeEventListener(COMPLETION_FEEDBACK_EVENT, handleFeedback);
    };
  }, []);

  return null;
}
