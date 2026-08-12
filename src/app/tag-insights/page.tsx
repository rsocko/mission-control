'use client';

import dynamic from 'next/dynamic';

const TagInsightsExplorer = dynamic(
  () => import('@/components/tag-insights/TagInsightsExplorer'),
  {
    ssr: false,
    loading: () => (
      <div
        className="mx-auto mt-8 h-[32rem] max-w-7xl animate-pulse rounded-2xl bg-[var(--surface-1)]"
        aria-label="Loading tag insights"
      />
    ),
  },
);

export default function TagInsightsPage() {
  return <TagInsightsExplorer initialView="matrix" />;
}
