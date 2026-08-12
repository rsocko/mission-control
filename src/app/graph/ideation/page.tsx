'use client';

import dynamic from 'next/dynamic';

const IdeationCanvas = dynamic(
  () => import('@/components/ideation/IdeationCanvas'),
  {
    ssr: false,
    loading: () => <div className="h-full min-h-[620px] animate-pulse bg-[var(--surface-0)]" />,
  },
);

export default function IdeationPage() {
  return <IdeationCanvas />;
}
