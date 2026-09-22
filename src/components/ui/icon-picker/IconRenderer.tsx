'use client';

import { memo, useState } from 'react';
import { parseIconValue, getIconUrl } from './types';
import { cn } from '@/lib/utils/cn';

export interface IconRendererProps {
  /** Stored icon value (emoji, "lucide:rocket", etc.) */
  value: string | null | undefined;
  /** Icon size in pixels. Default: 20 */
  size?: number;
  /** Optional color override (hex). Used to tint SVG icons. */
  color?: string;
  /** Extra className on the wrapper */
  className?: string;
  /** Fallback content when value is empty or icon fails to load */
  fallback?: React.ReactNode;
}

/**
 * Universal icon renderer — displays any icon from the icon picker.
 *
 * Handles emoji (as text), Lucide/MDI/Phosphor (via Iconify CDN),
 * Dashboard Icons and Simple Icons (via their respective CDNs).
 *
 * @example
 * <IconRenderer value="lucide:rocket" size={24} color="#3b82f6" />
 * <IconRenderer value="🚀" size={20} />
 * <IconRenderer value="dash:nextcloud" size={32} />
 */
export const IconRenderer = memo(function IconRenderer({
  value,
  size = 20,
  color,
  className,
  fallback = null,
}: IconRendererProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const parsed = parseIconValue(value);
  if (!parsed) return <>{fallback}</>;

  if (parsed.source === 'emoji') {
    return (
      <span
        className={cn('inline-flex items-center justify-center leading-none select-none', className)}
        style={{ fontSize: size * 0.85, width: size, height: size }}
        role="img"
        aria-label={`Emoji: ${parsed.name}`}
      >
        {parsed.name}
      </span>
    );
  }

  const url = getIconUrl(parsed, color);
  if (!url || failedUrl === url) return <>{fallback}</>;

  if (!color && ['lucide', 'mdi', 'ph'].includes(parsed.source)) {
    return (
      <>
        <span
          role="img"
          aria-label={`${parsed.source}:${parsed.name}`}
          className={cn('inline-block flex-shrink-0 bg-current', className)}
          style={{
            width: size,
            height: size,
            maskImage: `url("${url}")`,
            WebkitMaskImage: `url("${url}")`,
            maskPosition: 'center',
            WebkitMaskPosition: 'center',
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
            maskSize: 'contain',
            WebkitMaskSize: 'contain',
          }}
        />
        {/*
         * CSS mask-image has no load/error event of its own, so a failed
         * Iconify request would otherwise render as a permanently blank box
         * instead of the caller-provided fallback. Probe the same URL with
         * an invisible <img> purely to detect failure and swap to fallback.
         */}
        <img
          src={url}
          alt=""
          aria-hidden="true"
          width={0}
          height={0}
          style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
          onError={() => setFailedUrl(url)}
        />
      </>
    );
  }

  return (
    <img
      src={url}
      alt={`${parsed.source}:${parsed.name}`}
      width={size}
      height={size}
      loading="lazy"
      className={cn('inline-block flex-shrink-0', className)}
      style={{ width: size, height: size }}
      onError={() => setFailedUrl(url)}
    />
  );
});
