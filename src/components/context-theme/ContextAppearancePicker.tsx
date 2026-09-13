'use client';

import { useEffect, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CONTEXT_THEME_BACKDROPS,
  CONTEXT_THEME_STRENGTHS,
  DEFAULT_CONTEXT_THEME_PREFERENCES,
  normalizeContextThemePreferences,
  resolveContextAppearance,
} from '@/lib/context-appearance';
import type { ContextAppearance, ContextThemePreferences } from '@/types';
import { uiLogger } from '@/lib/client-logger';

const strengthCopy: Record<ContextAppearance['strength'], { label: string; detail: string }> = {
  whisper: { label: 'Whisper', detail: 'Fine outline and a quiet header tint' },
  frame: { label: 'Frame', detail: 'A strong color boundary around the workspace' },
  atmosphere: { label: 'Atmosphere', detail: 'Backdrop fades through the upper workspace' },
  canvas: { label: 'Canvas', detail: 'Backdrop fills the entire working surface' },
};

const backdropCopy: Record<ContextAppearance['backdrop'], string> = {
  none: 'None',
  aurora: 'Aurora',
  ridge: 'Dusk ridge',
  nebula: 'Nebula',
};

const backdropPreview: Record<ContextAppearance['backdrop'], string> = {
  none: 'linear-gradient(135deg, var(--surface-1), var(--surface-2))',
  aurora: 'radial-gradient(circle at 20% 10%, #2dd4bf 0, transparent 40%), radial-gradient(circle at 82% 20%, #7c3aed 0, transparent 44%), #07111f',
  ridge: 'url("/backdrops/context/dusk-ridge.svg")',
  nebula: 'radial-gradient(circle at 18% 28%, #0ea5e9 0, transparent 35%), radial-gradient(circle at 70% 16%, #c084fc 0, transparent 38%), #080d22',
};

export function ContextAppearancePicker({
  value,
  kind,
  fallbackAccent,
  inheritLabel,
  onChange,
}: {
  value: ContextAppearance | null;
  kind: 'project' | 'list';
  fallbackAccent: string;
  inheritLabel: string;
  onChange: (value: ContextAppearance | null) => void;
}) {
  const [preferences, setPreferences] = useState<ContextThemePreferences>(
    DEFAULT_CONTEXT_THEME_PREFERENCES,
  );
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/settings/context-themes', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((stored) => {
        if (stored) setPreferences(normalizeContextThemePreferences(stored));
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          uiLogger.warn('Unable to load context theme preferences', { error });
        }
      });
    return () => controller.abort();
  }, []);

  const current = value ?? resolveContextAppearance({
    kind,
    accentColor: fallbackAccent,
    preferences,
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">Context appearance</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Color marks location. Action, status, and focus colors remain unchanged.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
            value === null
              ? 'border-[var(--accent)]/45 bg-[var(--accent)]/10 text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
          )}
        >
          <RotateCcw size={12} />
          {inheritLabel}
        </button>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">Accent</p>
        <div className="flex items-center gap-3">
          <input
            type="color"
            aria-label="Context accent color"
            value={current.accentColor ?? fallbackAccent}
            onChange={(event) => onChange({ ...current, accentColor: event.target.value })}
            className="h-10 w-12 cursor-pointer rounded-lg border border-[var(--border)] bg-transparent p-1"
          />
          <code className="text-xs uppercase text-[var(--text-secondary)]">
            {current.accentColor ?? fallbackAccent}
          </code>
        </div>
      </div>

      <fieldset>
        <legend className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">Strength</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CONTEXT_THEME_STRENGTHS.map((strength) => (
            <button
              key={strength}
              type="button"
              onClick={() => onChange({
                ...current,
                strength,
                backdrop: strength === 'whisper' || strength === 'frame' ? 'none' : current.backdrop === 'none' ? 'aurora' : current.backdrop,
              })}
              className={cn(
                'rounded-xl border p-3 text-left transition-colors',
                value?.strength === strength
                  ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10'
                  : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)]',
              )}
            >
              <span className="flex items-center justify-between gap-2 text-sm font-medium text-[var(--text-primary)]">
                {strengthCopy[strength].label}
                {value?.strength === strength ? <Check size={14} className="text-[var(--accent)]" /> : null}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-[var(--text-muted)]">
                {strengthCopy[strength].detail}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">Backdrop</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CONTEXT_THEME_BACKDROPS.map((backdrop) => (
            <button
              key={backdrop}
              type="button"
              onClick={() => onChange({
                ...current,
                strength: current.strength === 'whisper' || current.strength === 'frame'
                  ? 'atmosphere'
                  : current.strength,
                backdrop,
              })}
              className={cn(
                'overflow-hidden rounded-xl border text-left transition-colors',
                value?.backdrop === backdrop
                  ? 'border-[var(--accent)]/60'
                  : 'border-[var(--border)] hover:border-[var(--border-strong)]',
              )}
            >
              <span
                aria-hidden="true"
                className="block h-14 bg-cover bg-center bg-no-repeat"
                style={{ background: backdropPreview[backdrop] }}
              />
              <span className="block bg-[var(--surface-0)] px-2 py-1.5 text-xs text-[var(--text-secondary)]">
                {backdropCopy[backdrop]}
              </span>
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
