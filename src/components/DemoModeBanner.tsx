'use client';

import { useEffect, useState } from 'react';

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
    <div className="flex flex-shrink-0 flex-col gap-2 border-b border-amber-800/40 bg-amber-900/30 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-1.5 sm:text-sm">
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <span className="shrink-0 text-amber-400 font-medium">
          🧪 {publicDemo ? 'Public Demo' : 'Demo Mode'}
        </span>
        <span className="min-w-0 text-amber-300/70">
          {publicDemo
            ? 'Showing sample data. Changes reset whenever the demo restarts.'
            : 'Showing sample data. Write-back to external APIs is disabled.'}
        </span>
      </div>
      {!publicDemo && (showConfirm ? (
        <div className="flex shrink-0 items-center justify-end gap-2">
          <span className="text-xs text-amber-300">Switch to Live?</span>
          <button onClick={switchToLive} className="min-h-10 rounded border border-green-700/50 bg-green-900/40 px-3 text-xs font-medium text-green-400 hover:bg-green-900/60">Yes</button>
          <button onClick={() => setShowConfirm(false)} className="min-h-10 rounded border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-3)]">Cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setShowConfirm(true)}
          disabled={switching}
          className="min-h-10 shrink-0 self-end rounded border border-amber-700/50 bg-amber-900/40 px-3 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/60 disabled:opacity-50 sm:self-auto"
        >
          {switching ? 'Switching...' : 'Switch to Live →'}
        </button>
      ))}
    </div>
  );
}
