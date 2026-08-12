'use client';

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Tags, Loader2, CheckCircle2, AlertTriangle, ArrowRight, RefreshCw,
} from 'lucide-react';

interface LabelNormalization {
  current: string;
  canonical: string;
  category: 'priority' | 'effort';
  issueCount: number;
  repo: string;
}

interface ScanResult {
  normalizations: LabelNormalization[];
  reposScanned: number;
  totalLabelsToNormalize: number;
  totalIssuesAffected: number;
  rateLimitWarning?: string;
}

/**
 * Label Health panel for GitHub connector settings.
 * Scans repos for non-canonical priority/effort labels and offers normalization.
 */
export function LabelHealthPanel({ connectorId }: { connectorId: string }) {
  const [status, setStatus] = useState<'idle' | 'scanning' | 'scanned' | 'normalizing' | 'done' | 'error'>('idle');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [normalizeResult, setNormalizeResult] = useState<{ succeeded: number; failed: number; errors: string[] } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const scan = useCallback(async () => {
    setStatus('scanning');
    setErrorMessage('');
    setScanResult(null);
    setSelected(new Set());
    setNormalizeResult(null);

    try {
      const res = await fetch(`/api/connectors/${connectorId}/label-scan`);
      if (!res.ok) throw new Error(await res.text());
      const data: ScanResult = await res.json();
      setScanResult(data);
      // Select all by default
      setSelected(new Set(data.normalizations.map(n => `${n.repo}:${n.current}`)));
      setStatus(data.totalLabelsToNormalize > 0 ? 'scanned' : 'done');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [connectorId]);

  const normalize = useCallback(async () => {
    if (!scanResult) return;
    setStatus('normalizing');

    const toNormalize = scanResult.normalizations.filter(n => selected.has(`${n.repo}:${n.current}`));
    try {
      const res = await fetch(`/api/connectors/${connectorId}/label-normalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normalizations: toNormalize }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setNormalizeResult(data);
      setStatus('done');

      const { toast } = await import('sonner');
      if (data.failed === 0) {
        toast.success(`Normalized ${data.succeeded} label${data.succeeded !== 1 ? 's' : ''} across your repos`);
      } else {
        toast.warning(`Normalized ${data.succeeded}, ${data.failed} failed`);
      }
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [connectorId, scanResult, selected]);

  function toggleItem(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div>
      <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1.5">
        <Tags size={10} /> Label Health
      </h4>

      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
        {/* Idle state */}
        {status === 'idle' && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-[var(--text-secondary)]">
              Scan repos for non-standard priority &amp; effort labels that could cause sync issues.
            </p>
            <motion.button
              onClick={scan}
              whileTap={{ scale: 0.97 }}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors flex items-center gap-1.5 shrink-0 ml-3"
            >
              <Tags size={10} /> Scan Labels
            </motion.button>
          </div>
        )}

        {/* Scanning */}
        {status === 'scanning' && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 size={10} className="animate-spin" /> Scanning repository labels…
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div>
            <p className="text-xs text-red-400 flex items-center gap-1 mb-2">
              <AlertTriangle size={10} /> {errorMessage}
            </p>
            <motion.button onClick={scan} whileTap={{ scale: 0.97 }}
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              <RefreshCw size={10} /> Retry
            </motion.button>
          </div>
        )}

        {/* Scan results */}
        {status === 'scanned' && scanResult && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border bg-amber-900/30 text-amber-400 border-amber-800/30">
                <AlertTriangle size={10} />
                {scanResult.totalLabelsToNormalize} non-standard label{scanResult.totalLabelsToNormalize !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                across {scanResult.totalIssuesAffected} issue{scanResult.totalIssuesAffected !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="space-y-1.5 mb-3 max-h-48 overflow-y-auto">
              {scanResult.normalizations.map(n => {
                const key = `${n.repo}:${n.current}`;
                const isSelected = selected.has(key);
                return (
                  <label key={key}
                    className="flex items-center gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-2.5 py-2 cursor-pointer hover:border-[var(--border-strong)] transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleItem(key)}
                      className="h-3.5 w-3.5 rounded border-[var(--border-strong)] bg-[var(--surface-0)] text-blue-600 focus:ring-blue-500/50 focus:ring-2 cursor-pointer"
                    />
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <code className="text-xs bg-red-900/20 text-red-300 px-1.5 py-0.5 rounded border border-red-800/30 truncate">
                        {n.current}
                      </code>
                      <ArrowRight size={10} className="text-[var(--text-muted)] shrink-0" />
                      <code className="text-xs bg-emerald-900/20 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-800/30 truncate">
                        {n.canonical}
                      </code>
                    </div>
                    <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
                      {n.issueCount} issue{n.issueCount !== 1 ? 's' : ''}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      n.category === 'priority'
                        ? 'bg-orange-900/30 text-orange-400 border border-orange-800/30'
                        : 'bg-blue-900/30 text-blue-400 border border-blue-800/30'
                    }`}>
                      {n.category}
                    </span>
                  </label>
                );
              })}
            </div>

            {scanResult.rateLimitWarning && (
              <p className="text-[11px] text-amber-400 flex items-center gap-1 mb-2">
                <AlertTriangle size={10} className="shrink-0" /> {scanResult.rateLimitWarning}
              </p>
            )}

            <div className="flex items-center gap-2">
              <motion.button
                onClick={normalize}
                disabled={selected.size === 0}
                whileTap={{ scale: 0.97 }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw size={10} /> Normalize {selected.size} Label{selected.size !== 1 ? 's' : ''}
              </motion.button>
              <motion.button
                onClick={() => { setStatus('idle'); setScanResult(null); }}
                whileTap={{ scale: 0.97 }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] transition-colors border border-[var(--border)]"
              >
                Dismiss
              </motion.button>
            </div>
          </div>
        )}

        {/* Normalizing */}
        {status === 'normalizing' && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 size={10} className="animate-spin" /> Normalizing labels across repos…
          </div>
        )}

        {/* Done */}
        <AnimatePresence>
          {status === 'done' && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {normalizeResult ? (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 size={10} />
                    {normalizeResult.succeeded} label{normalizeResult.succeeded !== 1 ? 's' : ''} normalized
                    {normalizeResult.failed > 0 && (
                      <span className="text-amber-400 ml-1">({normalizeResult.failed} failed)</span>
                    )}
                  </span>
                  <motion.button onClick={scan} whileTap={{ scale: 0.97 }}
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                    <RefreshCw size={10} /> Re-scan
                  </motion.button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 size={10} /> All labels are using canonical format
                  </span>
                  <motion.button onClick={scan} whileTap={{ scale: 0.97 }}
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                    <RefreshCw size={10} /> Re-scan
                  </motion.button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
