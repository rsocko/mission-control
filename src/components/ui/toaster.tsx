'use client';

import { useEffect, useState } from 'react';
import { Toaster as SonnerToaster } from 'sonner';

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);

  return isMobile;
}

export function Toaster() {
  const isMobile = useIsMobile();

  return (
    <SonnerToaster
      position={isMobile ? 'top-center' : 'bottom-right'}
      closeButton={isMobile}
      swipeDirections={isMobile ? ['top', 'left', 'right'] : ['right']}
      toastOptions={{
        style: {
          background: 'var(--surface-2)',
          border: '1px solid var(--border-strong)',
          color: 'var(--text-primary)',
          borderRadius: 'var(--radius-lg)',
        },
        classNames: {
          error: '!border-red-500/40 !bg-red-950/80 !text-red-200',
          success: '!border-green-500/40 !bg-green-950/80 !text-green-200',
          warning: '!border-yellow-500/40 !bg-yellow-950/80 !text-yellow-200',
          info: '!border-blue-500/40 !bg-blue-950/80 !text-blue-200',
          closeButton: '!bg-white/10 !border-white/20',
        },
      }}
      theme="dark"
    />
  );
}
