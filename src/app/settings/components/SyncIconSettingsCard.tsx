'use client';

import { RadioTower, Shuffle, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import {
  useSyncIconPreference,
  type SyncIconPreference,
} from '@/lib/hooks/useSyncIconPreference';

const options: Array<{
  value: SyncIconPreference;
  label: string;
  description: string;
  icon: typeof RadioTower;
}> = [
  {
    value: 'alternating',
    label: 'Alternating signal',
    description: 'Show directional waves that alternate between sending and receiving.',
    icon: RadioTower,
  },
  {
    value: 'particles',
    label: 'Particle streams',
    description: 'Show three asynchronous digital lanes moving to and from the satellite.',
    icon: Sparkles,
  },
  {
    value: 'both',
    label: 'Both (random per sync)',
    description: 'Choose one treatment when each sync starts and keep it for that sync.',
    icon: Shuffle,
  },
];

export function SyncIconSettingsCard() {
  const { preference, setPreference } = useSyncIconPreference();

  function selectPreference(next: SyncIconPreference) {
    try {
      setPreference(next);
    } catch {
      toast.error('Failed to save the sync icon preference');
    }
  }

  return (
    <section
      className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-5"
      aria-labelledby="sync-icon-animation-heading"
    >
      <h3
        id="sync-icon-animation-heading"
        className="mb-4 text-sm font-medium text-[var(--text-primary)]"
      >
        Sync icon animation
      </h3>

      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Sync icon animation">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = preference === option.value;
          return (
            <label
              key={option.value}
              className={`cursor-pointer rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? 'border-blue-500/60 bg-blue-500/10 ring-1 ring-blue-500/20'
                  : 'border-[var(--border)] bg-[var(--surface-1)] hover:border-blue-500/30'
              }`}
            >
              <input
                type="radio"
                name="sync-icon-animation"
                value={option.value}
                checked={selected}
                onChange={() => selectPreference(option.value)}
                className="sr-only"
              />
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                <Icon size={16} className={selected ? 'text-blue-400' : 'text-[var(--text-muted)]'} />
                {option.label}
              </span>
              <span className="mt-1.5 block text-xs leading-4 text-[var(--text-tertiary)]">
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
