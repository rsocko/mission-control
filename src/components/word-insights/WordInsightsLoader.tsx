'use client';

import dynamic from 'next/dynamic';

const WordInsightsView = dynamic(() => import('./WordInsightsView'), {
  ssr: false,
  loading: () => (
    <div
      className="flex h-full items-center justify-center bg-slate-950 text-slate-300"
      role="status"
    >
      <span className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400" />
      Loading word insights
    </div>
  ),
});

export default function WordInsightsLoader() {
  return <WordInsightsView />;
}
