'use client';

import { Layers } from 'lucide-react';
import { useNavBadgesVisible } from '@/components/layout/MobileBottomNav';

export function NavBadgeSettingsCard() {
  const [visible, setVisible] = useNavBadgesVisible();

  return (
    <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Layers size={18} className="text-[var(--text-muted)]" />
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Navigation tab badges</h3>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] mb-3">
        Show count badges (Triage, Sort) on the bottom navigation bar icons.
      </p>

      <label className="flex items-center gap-3 cursor-pointer">
        <button
          role="switch"
          aria-checked={visible}
          onClick={() => setVisible(!visible)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            visible ? 'bg-[var(--accent-500)]' : 'bg-[var(--surface-4)]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              visible ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span className="text-sm text-[var(--text-secondary)]">
          {visible ? 'Badges visible' : 'Badges hidden'}
        </span>
      </label>
    </div>
  );
}
