'use client';

import React from 'react';
import { createPortal } from 'react-dom';

export const ConnectorModalFooterContext = React.createContext<HTMLElement | null>(null);

export function ConnectorActionFooter({ children }: { children: React.ReactNode }) {
  const footerTarget = React.useContext(ConnectorModalFooterContext);
  const content = (
    <div className={footerTarget
      ? 'flex w-full flex-wrap items-center justify-between gap-3'
      : 'mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3'}
    >
      {children}
    </div>
  );
  return footerTarget ? createPortal(content, footerTarget) : content;
}
