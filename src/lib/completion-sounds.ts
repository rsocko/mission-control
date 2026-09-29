'use client';

import { useEffect, useState } from 'react';
import { settingsLogger } from '@/lib/client-logger';

export type CompletionSoundId = 'none' | 'soft-tap' | 'clear-ping' | 'warm-chime';
export type RewardSoundId = 'none' | 'gentle-rise' | 'quiet-resolve' | 'soft-fanfare';

export interface CompletionSoundPreferences {
  completionSound: CompletionSoundId;
  rewardSound: RewardSoundId;
  muted: boolean;
}

export const COMPLETION_SOUND_PREFERENCES_KEY = 'mc:completion-sound-preferences';
export const COMPLETION_SOUND_PREFERENCES_EVENT = 'mission-control:completion-sound-preferences-changed';
export const TASK_COMPLETED_EVENT = 'mc:task-completed';
export const COMPLETION_FEEDBACK_EVENT = 'mc:completion-feedback';

export const DEFAULT_COMPLETION_SOUND_PREFERENCES: CompletionSoundPreferences = {
  completionSound: 'none',
  rewardSound: 'none',
  muted: false,
};

export const COMPLETION_SOUND_OPTIONS: ReadonlyArray<{ value: CompletionSoundId; label: string }> = [
  { value: 'none', label: 'Off' },
  { value: 'soft-tap', label: 'Soft tap' },
  { value: 'clear-ping', label: 'Clear ping' },
  { value: 'warm-chime', label: 'Warm chime' },
];

export const REWARD_SOUND_OPTIONS: ReadonlyArray<{ value: RewardSoundId; label: string }> = [
  { value: 'none', label: 'Off' },
  { value: 'gentle-rise', label: 'Gentle rise' },
  { value: 'quiet-resolve', label: 'Quiet resolve' },
  { value: 'soft-fanfare', label: 'Soft fanfare' },
];

const COMPLETION_SOUND_IDS = new Set(COMPLETION_SOUND_OPTIONS.map(({ value }) => value));
const REWARD_SOUND_IDS = new Set(REWARD_SOUND_OPTIONS.map(({ value }) => value));

export function getCompletionSoundPreferences(): CompletionSoundPreferences {
  if (typeof window === 'undefined') return DEFAULT_COMPLETION_SOUND_PREFERENCES;
  try {
    const raw = localStorage.getItem(COMPLETION_SOUND_PREFERENCES_KEY);
    if (!raw) return DEFAULT_COMPLETION_SOUND_PREFERENCES;
    const value: unknown = JSON.parse(raw);
    if (
      !value || typeof value !== 'object'
      || !('completionSound' in value) || typeof value.completionSound !== 'string'
      || !COMPLETION_SOUND_IDS.has(value.completionSound as CompletionSoundId)
      || !('rewardSound' in value) || typeof value.rewardSound !== 'string'
      || !REWARD_SOUND_IDS.has(value.rewardSound as RewardSoundId)
      || !('muted' in value) || typeof value.muted !== 'boolean'
    ) {
      throw new Error('Invalid completion sound preferences');
    }
    return {
      completionSound: value.completionSound as CompletionSoundId,
      rewardSound: value.rewardSound as RewardSoundId,
      muted: value.muted,
    };
  } catch (error) {
    settingsLogger.warn('Unable to read completion sound preferences; using defaults', { error });
    return DEFAULT_COMPLETION_SOUND_PREFERENCES;
  }
}

export function setCompletionSoundPreferences(updates: Partial<CompletionSoundPreferences>): void {
  const next = { ...getCompletionSoundPreferences(), ...updates };
  localStorage.setItem(COMPLETION_SOUND_PREFERENCES_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(COMPLETION_SOUND_PREFERENCES_EVENT));
}

export function useCompletionSoundPreferences(): CompletionSoundPreferences {
  const [preferences, setPreferences] = useState(DEFAULT_COMPLETION_SOUND_PREFERENCES);

  useEffect(() => {
    const refresh = () => setPreferences(getCompletionSoundPreferences());
    const onStorage = (event: StorageEvent) => {
      if (event.key === COMPLETION_SOUND_PREFERENCES_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener(COMPLETION_SOUND_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(COMPLETION_SOUND_PREFERENCES_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return preferences;
}

type SoundId = Exclude<CompletionSoundId | RewardSoundId, 'none'>;
type AudioContextConstructor = typeof AudioContext;

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!AudioContextClass) return null;
  audioContext ??= new AudioContextClass();
  return audioContext;
}

export async function unlockCompletionAudio(): Promise<void> {
  const context = getAudioContext();
  if (!context || context.state !== 'suspended') return;
  await context.resume();
}

interface Tone {
  frequency: number;
  at: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
}

const SOUND_TONES: Record<SoundId, Tone[]> = {
  'soft-tap': [
    { frequency: 520, at: 0, duration: 0.12, gain: 0.035, type: 'sine' },
  ],
  'clear-ping': [
    { frequency: 740, at: 0, duration: 0.22, gain: 0.04, type: 'sine' },
  ],
  'warm-chime': [
    { frequency: 440, at: 0, duration: 0.28, gain: 0.032, type: 'sine' },
    { frequency: 660, at: 0.07, duration: 0.32, gain: 0.024, type: 'sine' },
  ],
  'gentle-rise': [
    { frequency: 440, at: 0, duration: 0.28, gain: 0.03, type: 'sine' },
    { frequency: 554, at: 0.11, duration: 0.3, gain: 0.03, type: 'sine' },
    { frequency: 659, at: 0.22, duration: 0.38, gain: 0.025, type: 'sine' },
  ],
  'quiet-resolve': [
    { frequency: 392, at: 0, duration: 0.34, gain: 0.028, type: 'triangle' },
    { frequency: 523, at: 0.13, duration: 0.38, gain: 0.028, type: 'sine' },
    { frequency: 659, at: 0.27, duration: 0.42, gain: 0.022, type: 'sine' },
  ],
  'soft-fanfare': [
    { frequency: 523, at: 0, duration: 0.25, gain: 0.026, type: 'triangle' },
    { frequency: 659, at: 0.13, duration: 0.3, gain: 0.026, type: 'triangle' },
    { frequency: 784, at: 0.27, duration: 0.42, gain: 0.022, type: 'sine' },
  ],
};

export async function playCompletionSound(sound: CompletionSoundId | RewardSoundId): Promise<boolean> {
  if (sound === 'none') return false;
  const context = getAudioContext();
  if (!context) return false;

  try {
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') return false;

    const start = context.currentTime + 0.01;
    for (const tone of SOUND_TONES[sound]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const toneStart = start + tone.at;
      const toneEnd = toneStart + tone.duration;
      oscillator.type = tone.type ?? 'sine';
      oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(tone.gain, toneStart + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneEnd + 0.02);
    }
    return true;
  } catch (error) {
    settingsLogger.warn('Unable to play completion sound', { error });
    return false;
  }
}

export function notifyTaskCompleted(): void {
  window.dispatchEvent(new CustomEvent(TASK_COMPLETED_EVENT));
}

export function notifyCompletionFeedback(reward: boolean): void {
  window.dispatchEvent(new CustomEvent(COMPLETION_FEEDBACK_EVENT, { detail: { reward } }));
}

export function isRewardMilestone(count: number, threshold: number, lastTriggeredAt: number): boolean {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(threshold) || count <= 0 || threshold <= 0) {
    return false;
  }
  const currentMultiple = Math.floor(count / threshold);
  return count % threshold === 0 && currentMultiple > lastTriggeredAt;
}
