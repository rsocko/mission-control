'use client';

import Image from 'next/image';
import { Plug } from 'lucide-react';
import { CONNECTOR_ICONS } from './types';
import { IconRenderer } from '@rsocko/icon-picker/renderer';

export function ConnectorBrandIcon({ type, size = 18 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICONS[type];
  if (!src) return <Plug size={size} className="text-[var(--text-muted)]" />;
  if (src.includes(':')) {
    return (
      <IconRenderer
        value={src}
        size={size}
        className="shrink-0"
        fallback={<Plug size={size} className="text-[var(--text-muted)]" />}
      />
    );
  }
  return <Image src={src} alt="" width={size} height={size} className="shrink-0" aria-hidden="true" />;
}
