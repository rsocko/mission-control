'use client';

import Image from 'next/image';
import { House, Plug } from 'lucide-react';
import { CONNECTOR_ICONS } from './types';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';

export function ConnectorBrandIcon({ type, size = 18 }: { type: string; size?: number }) {
  if (type === 'home-assistant') {
    return <House size={size} className="shrink-0 text-sky-400" aria-hidden="true" />;
  }
  const src = CONNECTOR_ICONS[type];
  if (!src) return <Plug size={size} className="text-[var(--text-muted)]" />;
  if (src.startsWith('dash:')) {
    return <IconRenderer value={src} size={size} className="shrink-0" />;
  }
  return <Image src={src} alt="" width={size} height={size} className="shrink-0" aria-hidden="true" />;
}
