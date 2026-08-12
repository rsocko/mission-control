'use client';

import { Suspense } from 'react';

import CapturePageInner from './CapturePageInner';

export default function CapturePage() {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <CapturePageInner />
    </Suspense>
  );
}
