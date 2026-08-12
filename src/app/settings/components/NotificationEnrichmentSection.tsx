'use client';

import React, { useState } from 'react';
import { Sparkles, RefreshCw, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Scope = 'unenriched' | 'all' | 'connector' | 'ids';

interface ReEnrichResult {
  success: boolean;
  processed: number;
  enriched: number;
  linked: number;
  aiEnriched: number;
  errors?: string[];
}

export function NotificationEnrichmentSection() {
  const [scope, setScope] = useState<Scope>('unenriched');
  const [enableAI, setEnableAI] = useState(false);
  const [limit, setLimit] = useState(100);
  const [connectorType, setConnectorType] = useState('');
  const [ids, setIds] = useState('');
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<ReEnrichResult | null>(null);

  async function handleReEnrich() {
    setRunning(true);
    setLastResult(null);
    try {
      const body: Record<string, unknown> = { scope, enableAI, limit };
      if (scope === 'connector' && connectorType) {
        body.connectorType = connectorType;
      }
      if (scope === 'ids' && ids.trim()) {
        body.ids = ids.split(',').map(id => id.trim()).filter(Boolean);
      }

      const res = await fetch('/api/notifications/re-enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const result: ReEnrichResult = await res.json();
      setLastResult(result);
      toast.success(`Re-enriched ${result.enriched} of ${result.processed} notifications`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Re-enrichment failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Sparkles size={20} className="text-purple-400" />
          Notification Enrichment
        </h2>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Re-run the notification parsing pipeline on existing notifications. Useful after parser upgrades, AI model changes, or to enrich older notifications.
        </p>
      </div>

      {/* Scope selector */}
      <div className="bg-[var(--surface-2)] rounded-lg p-4 space-y-4">
        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">Scope</label>
          <Select
            value={scope}
            onValueChange={value => setScope(value as Scope)}
          >
            <SelectTrigger aria-label="Enrichment scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unenriched">Unenriched only - notifications missing enrichment metadata</SelectItem>
              <SelectItem value="all">All - re-process all notifications (e.g. after parser upgrade)</SelectItem>
              <SelectItem value="connector">By connector - target a specific connector type</SelectItem>
              <SelectItem value="ids">By IDs - specific notification IDs</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {scope === 'connector' && (
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">Connector Type</label>
            <input
              type="text"
              value={connectorType}
              onChange={e => setConnectorType(e.target.value)}
              placeholder="e.g. github-notifications, github-issues"
              className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        )}

        {scope === 'ids' && (
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">Notification IDs</label>
            <input
              type="text"
              value={ids}
              onChange={e => setIds(e.target.value)}
              placeholder="Comma-separated IDs"
              className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        )}

        <div className="flex items-center gap-6">
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">Limit</label>
            <input
              type="number"
              value={limit}
              onChange={e => setLimit(Math.min(500, Math.max(1, parseInt(e.target.value) || 100)))}
              min={1}
              max={500}
              className="w-24 bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)]"
            />
          </div>

          <div className="flex items-center gap-2 pt-5">
            <input
              type="checkbox"
              id="enableAI"
              checked={enableAI}
              onChange={e => setEnableAI(e.target.checked)}
              className="rounded border-[var(--border)] bg-[var(--surface-1)]"
            />
            <label htmlFor="enableAI" className="text-sm text-[var(--text-primary)]">
              Enable AI enrichment
            </label>
            <span className="text-xs text-[var(--text-muted)]">(uses tokens)</span>
          </div>
        </div>

        <button
          onClick={handleReEnrich}
          disabled={running || (scope === 'connector' && !connectorType.trim()) || (scope === 'ids' && !ids.trim())}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
        >
          {running ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {running ? 'Re-enriching...' : 'Run Re-enrichment'}
        </button>
      </div>

      {/* Results */}
      {lastResult && (
        <div className="bg-[var(--surface-2)] rounded-lg p-4">
          <h3 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2 mb-3">
            <CheckCircle2 size={14} className="text-green-400" />
            Results
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Processed" value={lastResult.processed} />
            <Stat label="Enriched" value={lastResult.enriched} />
            <Stat label="Linked" value={lastResult.linked} />
            <Stat label="AI Enriched" value={lastResult.aiEnriched} />
          </div>
          {lastResult.errors && lastResult.errors.length > 0 && (
            <div className="mt-3 p-2 bg-red-900/20 border border-red-800/30 rounded text-xs text-red-300">
              <div className="flex items-center gap-1 mb-1 font-medium">
                <AlertTriangle size={12} />
                {lastResult.errors.length} error(s)
              </div>
              {lastResult.errors.slice(0, 3).map((err, i) => (
                <div key={i} className="truncate">{err}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-lg font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
    </div>
  );
}
