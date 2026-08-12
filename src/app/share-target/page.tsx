'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Legacy share-target redirect.
 * The manifest now points share_target to /capture directly.
 * This page remains for backwards-compat: it forwards any share params to /capture.
 */
export default function ShareTargetPage() {
  return (
    <Suspense fallback={
      <div className="h-full flex items-center justify-center px-4">
        <Loader2 size={40} className="animate-spin text-[var(--accent-400)]" />
      </div>
    }>
      <ShareTargetRedirect />
    </Suspense>
  );
}

function ShareTargetRedirect() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const title = searchParams.get('title') || '';
    const text = searchParams.get('text') || '';
    const url = searchParams.get('url') || '';

    const params = new URLSearchParams();
    if (title) params.set('shared_title', title);
    if (text) params.set('shared_text', text);
    if (url) params.set('shared_url', url);

    const query = params.toString();
    router.replace(`/capture${query ? `?${query}` : ''}`);
  }, [searchParams, router]);

  return (
    <div className="h-full flex items-center justify-center px-4">
      <Loader2 size={40} className="animate-spin text-[var(--accent-400)]" />
      <p className="text-sm text-[var(--text-secondary)] ml-3">Redirecting...</p>
    </div>
  );
}
