'use client';

import { useState } from 'react';
import { Play, Volume2, VolumeX } from 'lucide-react';
import {
  COMPLETION_SOUND_OPTIONS,
  REWARD_SOUND_OPTIONS,
  playCompletionSound,
  setCompletionSoundPreferences,
  useCompletionSoundPreferences,
  type CompletionSoundId,
  type RewardSoundId,
} from '@/lib/completion-sounds';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { settingsLogger } from '@/lib/client-logger';

function SoundPicker<T extends CompletionSoundId | RewardSoundId>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_36px] sm:items-center">
      <div className="min-w-0">
        <label className="text-sm text-[var(--text-primary)]">{label}</label>
        <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{description}</p>
      </div>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        onClick={() => void playCompletionSound(value)}
        disabled={value === 'none'}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={`Preview ${label.toLowerCase()}`}
        title="Preview"
      >
        <Play size={14} />
      </button>
    </div>
  );
}

export function CompletionSoundSettingsCard() {
  const preferences = useCompletionSoundPreferences();
  const [error, setError] = useState('');
  const soundsEnabled = preferences.completionSound !== 'none' || preferences.rewardSound !== 'none';

  function update(updates: Parameters<typeof setCompletionSoundPreferences>[0]) {
    try {
      setCompletionSoundPreferences(updates);
      setError('');
    } catch (error) {
      settingsLogger.error('Failed to save completion sound preferences', { error });
      setError('Could not save sound preferences. Browser storage may be unavailable.');
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-5" aria-labelledby="completion-sounds-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {preferences.muted ? <VolumeX size={18} className="text-[var(--text-muted)]" /> : <Volume2 size={18} className="text-[var(--text-muted)]" />}
            <h3 id="completion-sounds-heading" className="text-sm font-medium text-[var(--text-primary)]">Completion sounds</h3>
          </div>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            Optional, device-local cues. Reward sounds replace the routine cue when the reward popup opens.
          </p>
        </div>
        {soundsEnabled && (
          <button
            type="button"
            onClick={() => update({ muted: !preferences.muted })}
            className="min-h-9 shrink-0 rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)]"
            aria-pressed={preferences.muted}
          >
            {preferences.muted ? 'Unmute' : 'Mute'}
          </button>
        )}
      </div>
      <div className="mt-4 space-y-4">
        <SoundPicker
          label="Task completion"
          description="A brief cue after a task is successfully completed."
          value={preferences.completionSound}
          options={COMPLETION_SOUND_OPTIONS}
          onChange={(completionSound) => update({ completionSound })}
        />
        <div className="border-t border-[var(--border-subtle)] pt-4">
          <SoundPicker
            label="Reward milestone"
            description="A distinct cue only when the every-X-tasks reward popup appears."
            value={preferences.rewardSound}
            options={REWARD_SOUND_OPTIONS}
            onChange={(rewardSound) => update({ rewardSound })}
          />
        </div>
        <p className="text-xs text-[var(--text-muted)]">Press M anywhere outside a text field to quickly mute or unmute configured sounds.</p>
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      </div>
    </section>
  );
}

