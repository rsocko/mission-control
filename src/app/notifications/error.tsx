'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';

export default function NotificationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Notifications page error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <AlertCircle size={32} className="text-red-400" />
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">Something went wrong</h2>
      <p className="text-sm text-[var(--text-secondary)] text-center max-w-md">
        There was an error loading notifications. This may be a temporary issue.
      </p>
      <button
        onClick={reset}
        className="px-4 py-2 text-sm bg-[var(--accent)] text-white rounded-md hover:bg-blue-500 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
