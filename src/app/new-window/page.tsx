'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';

/**
 * /new-window?target=/some-path
 *
 * Trampoline page used by PWA taskbar shortcuts configured to open in a new window.
 * When the browser navigates the existing window here (via launch_handler: navigate-existing),
 * this page immediately spawns a new standalone window for the target URL and then
 * navigates the original window back so it returns to wherever it was.
 */
function NewWindowLauncher() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const target = searchParams.get('target') || '/';
    window.open(target, '_blank');

    // Navigate back to restore the original window's location.
    // If there's history, go back; otherwise just go to the dashboard.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.replace('/');
    }
  }, [searchParams]);

  return (
    <div className="flex items-center justify-center h-screen bg-[var(--background)]">
      <p className="text-sm text-[var(--text-tertiary)]">Opening new window...</p>
    </div>
  );
}

export default function NewWindowPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen bg-[var(--background)]">
          <p className="text-sm text-[var(--text-tertiary)]">Opening new window...</p>
        </div>
      }
    >
      <NewWindowLauncher />
    </Suspense>
  );
}
