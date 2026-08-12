'use client';

import dynamic from 'next/dynamic';

const UniverseGraph = dynamic(
  () => import('@/components/graph/universe/UniverseGraph'),
  {
    ssr: false,
    loading: () => <div className="h-full min-h-[620px] animate-pulse bg-[#020617]" />,
  },
);

export default function UniversePage() {
  return <UniverseGraph />;
}
