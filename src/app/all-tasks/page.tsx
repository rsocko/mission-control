'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DashboardSkeleton } from '@/components/ui/Skeleton';
import { MobileAllTasksList } from '@/components/all-tasks/MobileAllTasksList';

export default function AllTasksPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <AllTasksPageInner />
    </Suspense>
  );
}

function AllTasksPageInner() {
  const router = useRouter();
  const [viewState, setViewState] = useState<'loading' | 'mobile' | 'desktop'>('loading');

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 639px)');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewState(mql.matches ? 'mobile' : 'desktop');

    const handler = (e: MediaQueryListEvent) => {
      setViewState(e.matches ? 'mobile' : 'desktop');
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Redirect desktop users to Dashboard — All Tasks is mobile-only
  useEffect(() => {
    if (viewState === 'desktop') {
      router.replace('/');
    }
  }, [viewState, router]);

  if (viewState !== 'mobile') {
    return null;
  }

  return <MobileAllTasksList />;
}
