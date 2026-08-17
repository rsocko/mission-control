'use client';

import { Layers } from 'lucide-react';
import { useNavigationBadgePreferences } from '@/lib/hooks/useNavigationBadges';
import { NAV_BADGE_OPTIONS } from '@/lib/navigation/badges';

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--accent-500)]' : 'bg-[var(--surface-4)]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export function NavBadgeSettingsCard() {
  const { preferences, setEnabled, setItemEnabled } = useNavigationBadgePreferences();

  return (
    <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Layers size={18} className="text-[var(--text-muted)]" />
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Navigation tab badges</h3>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] mb-3">
        Choose which actionable counts appear on desktop and mobile navigation.
      </p>

      <div className="divide-y divide-[var(--border)]">
        <div className="flex items-center justify-between gap-4 pb-3">
          <div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">Show navigation badges</p>
            <p className="text-xs text-[var(--text-tertiary)]">Master control for all badge counts</p>
          </div>
          <Toggle checked={preferences.enabled} onChange={setEnabled} label="Show navigation badges" />
        </div>
        {NAV_BADGE_OPTIONS.map((option) => (
          <div key={option.key} className="flex items-center justify-between gap-4 py-3 last:pb-0">
            <div>
              <p className="text-sm text-[var(--text-secondary)]">{option.label}</p>
              <p className="text-xs text-[var(--text-tertiary)]">{option.description}</p>
            </div>
            <Toggle
              checked={preferences.items[option.key]}
              onChange={(checked) => setItemEnabled(option.key, checked)}
              label={`Show ${option.label} badge`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
