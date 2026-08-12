'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Save } from 'lucide-react';
import type { ConnectorConfig, SourceList } from './types';

interface BridgeStatus {
  initialized: boolean;
  transport: 'power-automate-standard' | 'power-automate-graph' | null;
  capabilityProfile: 'standard-v1' | 'extended-v1' | null;
  resetRequired: boolean;
  lastIngestAt: string | null;
  lastIngestMode: 'snapshot' | 'delta' | null;
  lastError: string | null;
  deltaCheckpointStored: boolean;
  pendingWriteBackCount: number;
}

export function WorkTodoBridgePanel({
  connector,
  sourceLists,
  onUpdate,
  onDelete,
}: {
  connector: ConnectorConfig;
  sourceLists: SourceList[];
  onUpdate: (id: string, updates: Partial<ConnectorConfig>) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [name, setName] = useState(connector.name);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function loadStatus() {
    setLoading(true);
    try {
      const response = await fetch(`/api/connectors/${connector.id}/work-todo`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load bridge status');
      setStatus(data);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load bridge status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    fetch(`/api/connectors/${connector.id}/work-todo`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load bridge status');
        if (active) {
          setStatus(data);
          setError('');
        }
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load bridge status');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connector.id]);

  async function saveName() {
    setWorking(true);
    setError('');
    try {
      await onUpdate(connector.id, { name: name.trim() || 'Microsoft To Do - Work' });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save connector');
    } finally {
      setWorking(false);
    }
  }

  async function resetDelta() {
    setWorking(true);
    setError('');
    try {
      const response = await fetch(`/api/connectors/${connector.id}/work-todo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-delta' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to reset delta state');
      await loadStatus();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Unable to reset delta state');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="border-t border-[var(--border-subtle)] px-4 py-4 bg-[var(--surface-0)]">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label
              htmlFor={`work-todo-name-${connector.id}`}
              className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block"
            >
              Display Name
            </label>
            <div className="flex gap-2">
              <input
                id={`work-todo-name-${connector.id}`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="flex-1 px-3 py-1.5 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none"
              />
              <button
                type="button"
                onClick={saveName}
                disabled={working || name === connector.name}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-40 flex items-center gap-1.5"
              >
                <Save size={13} /> Save
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 text-sm">
            <div className="font-medium text-[var(--text-primary)]">External courier connector</div>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              Power Automate owns Microsoft authentication. Scout moves validated envelopes;
              tasks remain attributed to this connector and its To Do lists.
            </p>
          </div>

          <div>
            <div className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2">
              Source Lists
            </div>
            <div className="space-y-1">
              {sourceLists.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">Lists appear after the first accepted baseline.</p>
              ) : sourceLists.map((list) => (
                <div key={list.id} className="flex justify-between rounded-lg bg-[var(--surface-1)] px-3 py-2 text-sm">
                  <span className="text-[var(--text-secondary)]">{list.name}</span>
                  <span className="text-[var(--text-muted)]">{list.taskCount} open</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="text-xs font-semibold text-[var(--text-tertiary)] uppercase">Bridge Status</div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" /> Loading...
            </div>
          ) : status ? (
            <div className="space-y-2 text-sm">
              <StatusRow label="Tier" value={status.capabilityProfile === 'extended-v1' ? 'Extended Graph delta' : 'Standard snapshot'} />
              <StatusRow
                label="Baseline"
                value={status.initialized ? 'Accepted' : 'Waiting for first pull'}
                good={status.initialized}
              />
              <StatusRow
                label="Last ingest"
                value={status.lastIngestAt
                  ? `${status.lastIngestMode} at ${new Date(status.lastIngestAt).toLocaleString()}`
                  : 'Never'}
              />
              <StatusRow label="Pending write-back" value={String(status.pendingWriteBackCount)} />
              {status.capabilityProfile === 'extended-v1' && (
                <StatusRow
                  label="Delta checkpoint"
                  value={status.resetRequired
                    ? 'Reset required'
                    : status.deltaCheckpointStored ? 'Stored; never displayed' : 'Waiting for baseline'}
                  good={!status.resetRequired && status.deltaCheckpointStored}
                  warning={status.resetRequired}
                />
              )}
              {status.lastError && (
                <div className="rounded-lg border border-red-800/40 bg-red-900/20 p-2 text-xs text-red-300">
                  {status.lastError}
                </div>
              )}
            </div>
          ) : null}

          {status?.capabilityProfile === 'extended-v1' && (
            <button
              type="button"
              onClick={resetDelta}
              disabled={working}
              className="w-full px-3 py-2 rounded-lg border border-amber-700/40 bg-amber-900/10 text-amber-300 text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {working ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Require fresh delta baseline
            </button>
          )}

          {error && (
            <div className="rounded-lg border border-red-800/40 bg-red-900/20 p-2 text-xs text-red-300 flex gap-2">
              <AlertTriangle size={14} className="shrink-0" /> {error}
            </div>
          )}

          <button
            type="button"
            onClick={() => onDelete(connector.id)}
            className="text-xs text-red-400 hover:text-red-300"
          >
            Remove connector
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  good,
  warning,
}: {
  label: string;
  value: string;
  good?: boolean;
  warning?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-[var(--surface-1)] px-3 py-2">
      <span className="text-[var(--text-tertiary)]">{label}</span>
      <span className={`flex items-center gap-1.5 ${
        warning ? 'text-amber-300' : good ? 'text-emerald-300' : 'text-[var(--text-secondary)]'
      }`}>
        {good && <CheckCircle2 size={13} />}
        {warning && <AlertTriangle size={13} />}
        {value}
      </span>
    </div>
  );
}
