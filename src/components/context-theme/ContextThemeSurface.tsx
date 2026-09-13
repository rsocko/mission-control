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
  const isBackdrop = resolved.strength === 'atmosphere' || resolved.strength === 'canvas';
  const style = {
    '--context-accent': resolved.accentColor,
    '--context-backdrop': backdropStyles[resolved.backdrop],
    boxShadow: resolved.strength === 'whisper'
      ? 'inset 0 0 0 1px color-mix(in srgb, var(--context-accent) 55%, transparent)'
      : resolved.strength === 'frame'
        ? 'inset 0 0 0 5px color-mix(in srgb, var(--context-accent) 72%, transparent)'
        : undefined,
  } as CSSProperties;

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
          resolved.strength === 'atmosphere' && 'opacity-55 [mask-image:linear-gradient(to_bottom,black_0%,black_36%,transparent_82%)]',
          resolved.strength === 'canvas' && 'opacity-80',
        )}
        style={{
          backgroundImage: isBackdrop
            ? 'var(--context-backdrop)'
            : 'linear-gradient(to bottom, color-mix(in srgb, var(--context-accent) 10%, transparent), transparent 24%)',
        }}
      />
      <div className="relative z-[1] flex h-full min-h-0 w-full">{children}</div>
    </div>
  );
}
