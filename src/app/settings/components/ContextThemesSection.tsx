'use client';

import { useEffect, useState } from 'react';
import { Palette, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { ContextThemePreferences } from '@/types';
import {
  CONTEXT_THEME_BACKDROPS,
  CONTEXT_THEME_STRENGTHS,
  DEFAULT_CONTEXT_THEME_PREFERENCES,
  normalizeContextThemePreferences,
} from '@/lib/context-appearance';

const labels = {
  whisper: 'Whisper',
  frame: 'Frame',
  atmosphere: 'Atmosphere',
  canvas: 'Canvas',
  none: 'None',
  aurora: 'Aurora',
  ridge: 'Dusk ridge',
  nebula: 'Nebula',
} as const;

export function ContextThemesSection() {
  const [settings, setSettings] = useState<ContextThemePreferences>(
    DEFAULT_CONTEXT_THEME_PREFERENCES,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings/context-themes')
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load context themes');
        setSettings(normalizeContextThemePreferences(await response.json()));
      })
      .catch(() => toast.error('Failed to load context theme settings'))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch('/api/settings/context-themes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error('Failed to save context themes');
      toast.success('Context theme defaults saved');
    } catch {
      toast.error('Failed to save context theme defaults');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/10 p-2 text-[var(--accent)]">
          <Palette size={18} />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-[var(--text-primary)]">Context Themes</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-tertiary)]">
            Set the default visual signal for project and list workspaces. Individual projects and lists can override these choices.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ThemeDefaultCard
          title="Project workspaces"
          detail="Projects use their project color as the accent."
          value={settings.projectStrength}
          disabled={loading}
          onChange={(projectStrength) => setSettings((current) => ({ ...current, projectStrength }))}
        />
        <ThemeDefaultCard
          title="Single-list workspaces"
          detail="Applied only when the dashboard is focused on one list."
          value={settings.listStrength}
          disabled={loading}
          onChange={(listStrength) => setSettings((current) => ({ ...current, listStrength }))}
        />
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Default backdrop</h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
              Used by Atmosphere and Canvas when a project or list has no specific backdrop.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={settings.backdropsEnabled}
              disabled={loading}
              onChange={(event) => setSettings((current) => ({
                ...current,
                backdropsEnabled: event.target.checked,
              }))}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            Enable backdrops
          </label>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CONTEXT_THEME_BACKDROPS.map((backdrop) => (
            <button
              key={backdrop}
              type="button"
              disabled={loading || !settings.backdropsEnabled}
              onClick={() => setSettings((current) => ({ ...current, defaultBackdrop: backdrop }))}
              className={`rounded-xl border px-3 py-3 text-left text-sm transition-colors disabled:opacity-45 ${
                settings.defaultBackdrop === backdrop
                  ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10 text-[var(--text-primary)]'
                  : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
              }`}
            >
              {labels[backdrop]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={loading || saving}
          onClick={() => void save()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white transition-opacity disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? 'Saving...' : 'Save defaults'}
        </button>
      </div>
    </section>
  );
}

function ThemeDefaultCard({
  title,
  detail,
  value,
  disabled,
  onChange,
}: {
  title: string;
  detail: string;
  value: ContextThemePreferences['projectStrength'];
  disabled: boolean;
  onChange: (value: ContextThemePreferences['projectStrength']) => void;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      <p className="mt-1 min-h-9 text-xs leading-relaxed text-[var(--text-muted)]">{detail}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {CONTEXT_THEME_STRENGTHS.map((strength) => (
          <button
            key={strength}
            type="button"
            disabled={disabled}
            onClick={() => onChange(strength)}
            className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
              value === strength
                ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10 text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
            }`}
          >
            {labels[strength]}
          </button>
        ))}
      </div>
    </div>
  );
}
