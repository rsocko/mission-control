'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { ContextAppearance, ContextThemePreferences } from '@/types';
import {
  DEFAULT_CONTEXT_THEME_PREFERENCES,
  normalizeContextThemePreferences,
  resolveContextAppearance,
} from '@/lib/context-appearance';
import { uiLogger } from '@/lib/client-logger';

const backdropStyles: Record<ContextAppearance['backdrop'], string> = {
  none: 'none',
  aurora: [
    'radial-gradient(circle at 14% 2%, color-mix(in srgb, var(--context-accent) 42%, transparent), transparent 38%)',
    'radial-gradient(circle at 88% 8%, rgba(124,58,237,.24), transparent 36%)',
    'linear-gradient(135deg, rgba(4,18,31,.96), rgba(7,18,28,.82) 48%, rgba(3,7,18,.98))',
  ].join(','),
  ridge: 'linear-gradient(180deg, transparent, rgba(2,6,23,.35)), url("/backdrops/context/dusk-ridge.svg")',
  nebula: [
    'radial-gradient(circle at 18% 20%, color-mix(in srgb, var(--context-accent) 45%, transparent), transparent 28%)',
    'radial-gradient(circle at 72% 14%, rgba(192,132,252,.3), transparent 32%)',
    'radial-gradient(circle at 60% 55%, rgba(14,165,233,.18), transparent 38%)',
    'linear-gradient(145deg, #07111f, #11152b 48%, #030712)',
  ].join(','),
};

const solidSurfaceMixes: Record<ContextAppearance['strength'], {
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
}> = {
  whisper: {
    surface0: 'color-mix(in srgb, #0b1120 97%, var(--context-accent))',
    surface1: 'color-mix(in srgb, #111827 96%, var(--context-accent))',
    surface2: 'color-mix(in srgb, #1e293b 96%, var(--context-accent))',
    border: 'color-mix(in srgb, #1e293b 88%, var(--context-accent))',
  },
  frame: {
    surface0: 'color-mix(in srgb, #0b1120 94%, var(--context-accent))',
    surface1: 'color-mix(in srgb, #111827 93%, var(--context-accent))',
    surface2: 'color-mix(in srgb, #1e293b 94%, var(--context-accent))',
    border: 'color-mix(in srgb, #1e293b 78%, var(--context-accent))',
  },
  atmosphere: {
    surface0: 'color-mix(in srgb, #0b1120 91%, var(--context-accent))',
    surface1: 'color-mix(in srgb, #111827 90%, var(--context-accent))',
    surface2: 'color-mix(in srgb, #1e293b 92%, var(--context-accent))',
    border: 'color-mix(in srgb, #1e293b 76%, var(--context-accent))',
  },
  canvas: {
    surface0: 'color-mix(in srgb, #0b1120 88%, var(--context-accent))',
    surface1: 'color-mix(in srgb, #111827 87%, var(--context-accent))',
    surface2: 'color-mix(in srgb, #1e293b 89%, var(--context-accent))',
    border: 'color-mix(in srgb, #1e293b 70%, var(--context-accent))',
  },
};

const translucentSurfaceMixes = {
  atmosphere: {
    surface0: 'color-mix(in srgb, #0b1120 88%, transparent)',
    surface1: 'color-mix(in srgb, #111827 87%, transparent)',
    surface2: 'color-mix(in srgb, #1e293b 90%, transparent)',
  },
  canvas: {
    surface0: 'color-mix(in srgb, #0b1120 80%, transparent)',
    surface1: 'color-mix(in srgb, #111827 82%, transparent)',
    surface2: 'color-mix(in srgb, #1e293b 86%, transparent)',
  },
} as const;

export function getContextThemeSurfaceStyle(resolved: ContextAppearance): CSSProperties {
  const hasBackdrop = resolved.backdrop !== 'none'
    && (resolved.strength === 'atmosphere' || resolved.strength === 'canvas');
  const solidMixes = solidSurfaceMixes[resolved.strength];
  const surfaceMixes = hasBackdrop
    ? translucentSurfaceMixes[resolved.strength as keyof typeof translucentSurfaceMixes]
    : solidMixes;

  return {
    '--context-accent': resolved.accentColor,
    '--context-backdrop': backdropStyles[resolved.backdrop],
    '--context-header': [
      'linear-gradient(90deg,',
      'color-mix(in srgb, var(--context-accent) 14%, var(--surface-0)),',
      'color-mix(in srgb, var(--context-accent) 4%, var(--surface-0)) 58%,',
      'var(--surface-0))',
    ].join(' '),
    '--surface-0': surfaceMixes.surface0,
    '--surface-1': surfaceMixes.surface1,
    '--surface-2': surfaceMixes.surface2,
    '--border': solidMixes.border,
    '--border-subtle': 'color-mix(in srgb, #162032 84%, var(--context-accent))',
  } as CSSProperties;
}

export function ContextThemeSurface({
  kind,
  accentColor,
  appearance,
  active = true,
  className,
  children,
}: {
  kind: 'project' | 'list';
  accentColor?: string | null;
  appearance?: ContextAppearance | null;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [preferences, setPreferences] = useState<ContextThemePreferences>(
    DEFAULT_CONTEXT_THEME_PREFERENCES,
  );

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    fetch('/api/settings/context-themes', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        if (value) setPreferences(normalizeContextThemePreferences(value));
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          uiLogger.warn('Unable to load context theme preferences', { error });
        }
      });
    return () => controller.abort();
  }, [active]);

  const resolved = useMemo(
    () => resolveContextAppearance({ kind, accentColor, override: appearance, preferences }),
    [accentColor, appearance, kind, preferences],
  );
  if (!active) return <div className={className}>{children}</div>;
  const isBackdropStrength = resolved.strength === 'atmosphere' || resolved.strength === 'canvas';
  const hasBackdrop = isBackdropStrength && resolved.backdrop !== 'none';
  const style = getContextThemeSurfaceStyle(resolved);

  return (
    <div
      className={cn(
        'relative isolate min-h-0 overflow-hidden',
        className,
      )}
      data-context-theme={resolved.strength}
      data-context-backdrop={resolved.backdrop}
      style={style}
    >
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat transition-opacity duration-300',
          resolved.strength === 'whisper' && 'opacity-100',
          resolved.strength === 'frame' && 'opacity-0',
          resolved.strength === 'atmosphere' && (hasBackdrop
            ? 'opacity-55 [mask-image:linear-gradient(to_bottom,black_0%,black_36%,transparent_82%)]'
            : 'opacity-100'),
          resolved.strength === 'canvas' && (hasBackdrop ? 'opacity-80' : 'opacity-100'),
        )}
        style={{
          backgroundImage: hasBackdrop
            ? 'var(--context-backdrop)'
            : [
                'radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--context-accent) 18%, transparent), transparent 42%)',
                'linear-gradient(to bottom, color-mix(in srgb, var(--context-accent) 9%, transparent), transparent 36%)',
              ].join(','),
        }}
      />
      <div className="relative z-[1] flex h-full min-h-0 w-full">{children}</div>
      {resolved.strength === 'whisper' || resolved.strength === 'frame' ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-40"
          style={{
            boxShadow: resolved.strength === 'frame'
              ? 'inset 0 0 0 4px color-mix(in srgb, var(--context-accent) 72%, transparent)'
              : 'inset 0 0 0 1px color-mix(in srgb, var(--context-accent) 58%, transparent)',
          }}
        />
      ) : null}
    </div>
  );
}
