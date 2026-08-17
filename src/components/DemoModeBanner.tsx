'use client';

import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';

/**
 * Banner displayed at top of app when running in demo mode.
 * Provides quick toggle to switch to live mode.
 */
export function DemoModeBanner() {
  const [mode, setMode] = useState<string | null>(null);
  const [publicDemo, setPublicDemo] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    fetch('/api/settings/mode')
      .then(r => r.json())
      .then(d => {
        setMode(d.mode);
        setPublicDemo(d.publicDemo === true);
      })
      .catch(() => setMode('demo'));
  }, []);

  if (mode !== 'demo') return null;

  async function switchToLive() {
    setSwitching(true);
    setShowConfirm(false);
    const response = await fetch('/api/settings/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'live' }),
    });
    if (response.ok) setMode('live');
    setSwitching(false);
  }

  return (
    <div className="flex min-h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-amber-800/40 bg-amber-900/30 px-3 text-xs sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 items-center gap-1.5 font-medium text-amber-400">
          <FlaskConical size={14} aria-hidden="true" />
          {publicDemo ? 'Public Demo' : 'Demo Mode'}
        </span>
        <span className="min-w-0 truncate text-amber-300/70">
          {publicDemo
            ? 'Sample data; changes reset on restart.'
            : 'Sample data; external write-back is disabled.'}
        </span>
      </div>
      {!publicDemo && (showConfirm ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden text-amber-300 sm:inline">Switch to Live?</span>
          <button onClick={switchToLive} aria-label="Confirm switch to Live" className="min-h-8 rounded border border-green-700/50 bg-green-900/40 px-2.5 font-medium text-green-400 hover:bg-green-900/60">Yes</button>
          <button onClick={() => setShowConfirm(false)} aria-label="Cancel switch to Live" className="min-h-8 rounded border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-3)]">Cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setShowConfirm(true)}
          disabled={switching}
          aria-label="Switch to Live"
          className="min-h-8 shrink-0 rounded border border-amber-700/50 bg-amber-900/40 px-2.5 font-medium text-amber-300 transition-colors hover:bg-amber-900/60 disabled:opacity-50"
        >
          {switching ? 'Switching...' : 'Live'}
        </button>
      ))}
    </div>
  );
}
