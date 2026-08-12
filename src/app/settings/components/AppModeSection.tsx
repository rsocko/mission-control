'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Loader2, Settings2, FlaskConical, Wifi,
  AlertTriangle, RotateCcw, CheckCircle2, Inbox,
} from 'lucide-react';

function AppModeSection() {
  const [mode, setMode] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [publicDemo, setPublicDemo] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/mode')
      .then(r => r.json())
      .then(d => { setMode(d.mode); setPublicDemo(d.publicDemo === true); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function switchMode(newMode: string, clearDemoData = false) {
    if (publicDemo) return;
    setActionInProgress('switching');
    setMessage(null);
    let switched = false;
    try {
      const res = await fetch('/api/settings/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode, clearDemoData }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new Error(data.error || 'Could not switch app mode');
      }
      setMode(newMode);
      setMessage(data.message || `Switched to ${newMode} mode`);
      switched = true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not switch app mode');
    }
    setActionInProgress(null);
    if (switched) {
      setTimeout(() => window.location.reload(), 800);
    }
  }

  async function resetDemo() {
    setConfirmAction(null);
    setActionInProgress('resetting');
    setMessage(null);
    try {
      const res = await fetch('/api/settings/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-demo' }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      setMessage(data.message || 'Demo data reset');
    } catch {
      setMessage('Demo data reset');
    }
    setActionInProgress(null);
  }

  async function clearAllData() {
    setConfirmAction(null);
    setActionInProgress('clearing');
    setMessage(null);
    try {
      const res = await fetch('/api/settings/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear-data' }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      setMessage(data.message || 'All data cleared');
    } catch {
      setMessage('All data cleared');
    }
    setActionInProgress(null);
  }

  async function clearTriageSamples() {
    setConfirmAction(null);
    setActionInProgress('clearing-triage');
    setMessage(null);
    try {
      const res = await fetch('/api/settings/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear-triage-samples' }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      setMessage(data.message || 'Triage sample data cleared');
    } catch {
      setMessage('Triage sample data cleared');
    }
    setActionInProgress(null);
  }

  if (loading) return <div className="text-[var(--text-muted)] text-sm">Loading...</div>;

  return (
    <div>
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-1">App Mode</h2>
      <p className="text-sm text-[var(--text-tertiary)] mb-6">
        {publicDemo
          ? 'This public environment is locked to disposable sample data.'
          : 'Switch between demo (sample data) and live (real connectors) modes.'}
      </p>

      {message && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 rounded-lg bg-emerald-900/30 border border-emerald-800/30 text-sm text-emerald-400 flex items-center gap-2">
          <CheckCircle2 size={14} /> {message}
        </motion.div>
      )}

      {/* Mode Toggle */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <motion.button
          onClick={() => mode !== 'demo' && switchMode('demo')}
          disabled={publicDemo || !!actionInProgress}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          className={`p-4 rounded-xl border-2 text-left transition-colors ${
            mode === 'demo'
              ? 'border-amber-500/50 bg-amber-900/20 ring-1 ring-amber-500/20'
              : 'border-[var(--border)] hover:border-amber-500/30 hover:bg-amber-900/10'
          } ${actionInProgress ? 'opacity-50' : ''}`}
        >
          <div className="flex items-center gap-2 mb-1">
            <FlaskConical size={18} className="text-amber-400" />
            <span className="font-medium text-[var(--text-primary)]">Demo Mode</span>
            {mode === 'demo' && <span className="ml-auto text-xs font-medium text-amber-400 bg-amber-900/40 px-2 py-0.5 rounded-full border border-amber-800/30">Active</span>}
          </div>
          <p className="text-xs text-[var(--text-tertiary)] mt-1">Sample data for testing and development. External API write-back is disabled.</p>
        </motion.button>

        <motion.button
          onClick={() => mode !== 'live' && switchMode('live')}
          disabled={publicDemo || !!actionInProgress}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          className={`p-4 rounded-xl border-2 text-left transition-colors ${
            mode === 'live'
              ? 'border-emerald-500/50 bg-emerald-900/20 ring-1 ring-emerald-500/20'
              : 'border-[var(--border)] hover:border-emerald-500/30 hover:bg-emerald-900/10'
          } ${actionInProgress ? 'opacity-50' : ''}`}
        >
          <div className="flex items-center gap-2 mb-1">
            <Wifi size={18} className="text-emerald-400" />
            <span className="font-medium text-[var(--text-primary)]">Live Mode</span>
            {mode === 'live' && <span className="ml-auto text-xs font-medium text-emerald-400 bg-emerald-900/40 px-2 py-0.5 rounded-full border border-emerald-800/30">Active</span>}
          </div>
          <p className="text-xs text-[var(--text-tertiary)] mt-1">Real data from connected sources. Full sync and write-back enabled.</p>
        </motion.button>
      </div>

      {/* Data Management */}
      <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Data Management</h3>
      {publicDemo && (
        <div className="mb-3 p-3 rounded-xl bg-amber-900/20 border border-amber-800/30 text-sm text-amber-300">
          Demo data is reset automatically whenever this environment is redeployed or restarted.
        </div>
      )}
      <div className="space-y-3">
        <div className="flex items-center justify-between p-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
              <RotateCcw size={13} className="text-amber-400" /> Reset Demo Data
            </p>
            <p className="text-xs text-[var(--text-tertiary)] ml-5">Clears all data and repopulates with fresh sample data.</p>
          </div>
          {confirmAction === 'reset' ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-400">Are you sure?</span>
              <button onClick={resetDemo} className="px-2 py-1 text-xs font-medium rounded-md bg-amber-900/40 hover:bg-amber-900/60 text-amber-400 border border-amber-800/30">Yes, Reset</button>
              <button onClick={() => setConfirmAction(null)} className="px-2 py-1 text-xs font-medium rounded-md bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)]">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmAction('reset')}
              disabled={publicDemo || !!actionInProgress}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-900/30 hover:bg-amber-900/50 text-amber-400 border border-amber-800/30 disabled:opacity-50"
            >
              {actionInProgress === 'resetting' ? <><Loader2 size={12} className="inline animate-spin mr-1" /> Resetting...</> : 'Reset'}
            </button>
          )}
        </div>

        <div className="flex items-center justify-between p-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
              <Inbox size={13} className="text-blue-400" /> Clear Triage Sample Data
            </p>
            <p className="text-xs text-[var(--text-tertiary)] ml-5">Removes only the 4 built-in sample triage items. Real captured items are untouched.</p>
          </div>
          {confirmAction === 'clear-triage' ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-blue-400">Remove samples?</span>
              <button onClick={clearTriageSamples} className="px-2 py-1 text-xs font-medium rounded-md bg-blue-900/40 hover:bg-blue-900/60 text-blue-400 border border-blue-800/30">Yes, Clear</button>
              <button onClick={() => setConfirmAction(null)} className="px-2 py-1 text-xs font-medium rounded-md bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)]">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmAction('clear-triage')}
              disabled={publicDemo || !!actionInProgress}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-900/30 hover:bg-blue-900/50 text-blue-400 border border-blue-800/30 disabled:opacity-50"
            >
              {actionInProgress === 'clearing-triage' ? <><Loader2 size={12} className="inline animate-spin mr-1" /> Clearing...</> : 'Clear Samples'}
            </button>
          )}
        </div>

        <div className="flex items-center justify-between p-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
              <AlertTriangle size={13} className="text-red-400" /> Clear All Data
            </p>
            <p className="text-xs text-[var(--text-tertiary)] ml-5">Remove all tasks, alerts, connectors, tags, and triage items. Start fresh.</p>
          </div>
          {confirmAction === 'clear' ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-400">Cannot be undone!</span>
              <button onClick={clearAllData} className="px-2 py-1 text-xs font-medium rounded-md bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800/40">Yes, Clear All</button>
              <button onClick={() => setConfirmAction(null)} className="px-2 py-1 text-xs font-medium rounded-md bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)]">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmAction('clear')}
              disabled={publicDemo || !!actionInProgress}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-800/30 disabled:opacity-50"
            >
              {actionInProgress === 'clearing' ? <><Loader2 size={12} className="inline animate-spin mr-1" /> Clearing...</> : 'Clear All'}
            </button>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="mt-8 p-4 bg-blue-900/20 rounded-xl border border-blue-800/30">
        <h4 className="text-sm font-medium text-blue-300 mb-2 flex items-center gap-2">
          <Settings2 size={13} /> How it works
        </h4>
        <ul className="text-xs text-blue-400/80 space-y-1.5 list-disc list-inside">
          <li><strong className="text-blue-300">Demo mode</strong> shows sample data and prevents write-back to external services</li>
          <li><strong className="text-blue-300">Live mode</strong> enables full sync with connected sources (requires configured connectors)</li>
          <li>You can override the mode with <code className="bg-blue-900/40 px-1.5 py-0.5 rounded text-blue-300">MC_MODE=demo|live</code> in <code className="bg-blue-900/40 px-1.5 py-0.5 rounded text-blue-300">.env.local</code></li>
          <li>Switching to Live does not automatically remove demo data -- use &quot;Clear Triage Sample Data&quot; or &quot;Clear All&quot; to clean up</li>
        </ul>
      </div>
    </div>
  );
}


export { AppModeSection };
