'use client';

import { useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  setToastPreferences, useToastPreferences, type ToastPreferences,
} from '@/lib/toast-preferences';
import { settingsLogger } from '@/lib/client-logger';

export function ToastSettingsCard() {
  const { preferences, muted } = useToastPreferences();
  const [error, setError] = useState('');

  function update(updates: Partial<ToastPreferences>) {
    try {
      setToastPreferences(updates);
      setError('');
    } catch (error) {
      settingsLogger.error('Failed to save toast preferences', { error });
      setError('Could not save toast preferences. Browser storage may be unavailable.');
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-5" aria-labelledby="toast-settings-heading">
      <h3 id="toast-settings-heading" className="text-sm font-medium text-[var(--text-primary)]">Toast notifications</h3>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        Preferences apply to this browser, not push notifications. Mobile toasts stay at the top.
        Errors, warnings, progress, and actions such as Undo remain visible in quiet modes.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <label id="toast-position-label" className="mb-1 block text-sm">Desktop position</label>
          <Select value={preferences.desktopPosition} onValueChange={(value) => {
            if (value === 'bottom-left' || value === 'top-right') update({ desktopPosition: value });
          }}>
            <SelectTrigger aria-labelledby="toast-position-label"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="bottom-left">Bottom-left (clear of navigation)</SelectItem>
              <SelectItem value="top-right">Top-right</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label id="toast-mode-label" className="mb-1 block text-sm">Toast volume</label>
          <Select value={preferences.mode} onValueChange={(value) => {
            if (value === 'all' || value === 'errors-only') update({ mode: value });
          }}>
            <SelectTrigger aria-labelledby="toast-mode-label"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All notifications</SelectItem>
              <SelectItem value="errors-only">Errors only (plus warnings and actions)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="mb-2 text-xs text-[var(--text-tertiary)]" role="status">
            {muted
              ? `Routine toasts muted until ${new Date(preferences.mutedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
              : 'Temporarily mute routine confirmations without changing your volume preference.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {[15, 60].map((minutes) => (
              <button key={minutes} type="button" onClick={() => update({ mutedUntil: Date.now() + minutes * 60_000 })}
                className="rounded-md border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--surface-3)]">
                Mute for {minutes === 60 ? '1 hour' : '15 minutes'}
              </button>
            ))}
            {muted && (
              <button type="button" onClick={() => update({ mutedUntil: 0 })}
                className="rounded-md border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--surface-3)]">
                Unmute
              </button>
            )}
          </div>
        </div>
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      </div>
    </section>
  );
}
