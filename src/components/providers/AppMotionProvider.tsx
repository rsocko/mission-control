'use client';

import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';

export function AppMotionProvider({ children }: { children: ReactNode }) {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <MotionConfig reducedMotion={prefersReducedMotion ? 'always' : 'never'}>
      {children}
    </MotionConfig>
  );
}
