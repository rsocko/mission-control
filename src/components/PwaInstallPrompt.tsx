'use client';

import { useState } from 'react';
import { usePwaInstall } from '@/lib/hooks/usePwaInstall';
import { Button } from '@/components/ui/button';

/**
 * PWA install banner that appears at the bottom of the screen.
 * - Chrome/Edge: triggers native install prompt
 * - iOS Safari: shows manual "Add to Home Screen" instructions
 */
export function PwaInstallPrompt() {
  const { canPrompt, platform, isInstalled, promptInstall, dismiss } = usePwaInstall();
  const [showIosInstructions, setShowIosInstructions] = useState(false);

  if (!canPrompt || isInstalled) return null;

  const handleInstall = async () => {
    if (platform === 'chromium') {
      await promptInstall();
    } else if (platform === 'ios') {
      setShowIosInstructions(true);
    }
  };

  return (
    <div
      role="banner"
      aria-label="Install app prompt"
      className="fixed bottom-4 left-4 right-4 z-40 mx-auto max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-lg)] animate-in slide-in-from-bottom-4 duration-300"
    >
      {showIosInstructions ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Install Mission Control
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-sm text-[var(--text-secondary)]">
            <li>
              Tap the Share button{' '}
              <span aria-label="share icon" className="inline-block align-middle">
                <ShareIcon />
              </span>
            </li>
            <li>Scroll down and tap <strong>&quot;Add to Home Screen&quot;</strong></li>
            <li>Tap <strong>&quot;Add&quot;</strong> to confirm</li>
          </ol>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Got it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent-600)]">
            <AppIcon />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Install Mission Control
            </p>
            <p className="text-xs text-[var(--text-muted)] truncate">
              {platform === 'ios'
                ? 'Add to your Home Screen for quick access'
                : 'Install for offline access & notifications'}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss install prompt">
              Later
            </Button>
            <Button size="sm" onClick={handleInstall}>
              Install
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AppIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-white"
      aria-hidden="true"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[var(--text-secondary)]"
      aria-hidden="true"
    >
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}
