'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import {
  claimInsightsDrilldownHistory,
  getInsightsReturnHref,
  hasInsightsDrilldownHistory,
} from '@/lib/navigation/insights';

export function InsightsBackLink() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const href = getInsightsReturnHref(searchParams);

  useEffect(() => {
    claimInsightsDrilldownHistory();
  }, []);

  if (!href) return null;

  const handleBack = () => {
    if (hasInsightsDrilldownHistory()) {
      router.back();
      return;
    }
    router.replace(href);
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent-400)] transition-colors hover:text-[var(--accent-300)]"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      Back to Insights
    </button>
  );
}
