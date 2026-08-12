'use client';

import { Bell } from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { type BadgeMode, useBadgeMode } from '@/lib/hooks/useAppBadge';

const BADGE_OPTIONS: { value: BadgeMode; label: string; description: string }[] = [
  { value: 'unread_notifications', label: 'Unread notifications', description: 'Number of unread triage notifications' },
  { value: 'myday_incomplete', label: 'My Day incomplete', description: 'Tasks on today\'s list not yet done' },
  { value: 'overdue', label: 'Overdue', description: 'Tasks past their due date' },
  { value: 'off', label: 'Off', description: 'No badge count shown' },
];

export function BadgeSettingsCard() {
  const [badgeMode, setBadgeMode] = useBadgeMode();

  return (
    <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Bell size={18} className="text-[var(--text-muted)]" />
        <h3 className="text-sm font-medium text-[var(--text-primary)]">App badge count</h3>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] mb-3">
        Controls what number appears on the taskbar icon. Requires the app to be installed as a PWA.
      </p>

      <Select value={badgeMode} onValueChange={(v) => setBadgeMode(v as BadgeMode)}>
        <SelectTrigger className="flex-1 max-w-sm px-3 py-2 text-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-md text-[var(--text-primary)]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BADGE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <span>{opt.label}</span>
              <span className="ml-2 text-[var(--text-tertiary)]">— {opt.description}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
