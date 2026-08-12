'use client';

import Image from 'next/image';
import { SOURCE_META } from '@/components/triage/types';

interface TriageSourceIconProps {
  source: string;
  size?: number;
  className?: string;
  decorative?: boolean;
}

/**
 * Renders the full-color brand SVG for a triage source when available,
 * falling back to the Lucide icon otherwise.
 */
export function TriageSourceIcon({
  source,
  size = 14,
  className,
  decorative = false,
}: TriageSourceIconProps) {
  const meta = SOURCE_META[source] || SOURCE_META.web;
  if (meta.iconPath) {
    return (
      <Image
        src={meta.iconPath}
        alt={decorative ? '' : meta.label}
        width={size}
        height={size}
        className={className}
      />
    );
  }
  const Icon = meta.icon;
  return decorative
    ? <Icon size={size} className={className} aria-hidden="true" />
    : <Icon size={size} className={className} role="img" aria-label={meta.label} />;
}
