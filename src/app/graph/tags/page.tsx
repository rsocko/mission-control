'use client';

import dynamic from 'next/dynamic';

const TagInsightsExplorer = dynamic(
  () => import('@/components/tag-insights/TagInsightsExplorer'),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-full min-h-[620px] animate-pulse bg-[var(--surface-1)]"
        aria-label="Loading tag relationships"
      />
    ),
  },
);

export default function TagsGraphPage() {
  return <TagInsightsExplorer initialView="galaxy" />;
}
