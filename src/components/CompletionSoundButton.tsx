'use client';

import { Volume2, VolumeX } from 'lucide-react';
import {
  setCompletionSoundPreferences,
  useCompletionSoundPreferences,
} from '@/lib/completion-sounds';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/lib/toast';

export function CompletionSoundButton({ mobile = false }: { mobile?: boolean }) {
  const preferences = useCompletionSoundPreferences();
  const configured = preferences.completionSound !== 'none' || preferences.rewardSound !== 'none';
  if (!configured) return null;

  const label = preferences.muted ? 'Unmute completion sounds' : 'Mute completion sounds';
  const toggleMuted = () => {
    try {
      setCompletionSoundPreferences({ muted: !preferences.muted });
    } catch {
      toast.error('Could not update completion sound mute');
    }
  };
  const button = (
    <button
      type="button"
      onClick={toggleMuted}
      className={mobile
        ? 'flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]'
        : 'flex rounded-[var(--radius-sm)] p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]'}
      aria-label={`${label} (M)`}
      aria-pressed={preferences.muted}
    >
      {preferences.muted ? <VolumeX size={mobile ? 18 : 14} /> : <Volume2 size={mobile ? 18 : 14} />}
    </button>
  );

  return mobile ? button : <Tooltip content={label} shortcut="M">{button}</Tooltip>;
}
