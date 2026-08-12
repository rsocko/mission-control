'use client';

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--text-primary)]">
      <div className="text-center space-y-4 px-6">
        <h1 className="text-3xl font-bold">You&apos;re offline</h1>
        <p className="text-[var(--text-secondary)] max-w-md">
          Mission Control needs an internet connection. Please check your
          network and try again.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-6 py-2 rounded-[var(--radius-md)] bg-[var(--accent)] text-white font-medium hover:opacity-90 transition-opacity"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
