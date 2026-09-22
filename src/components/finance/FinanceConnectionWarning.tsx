'use client';

import { useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { FinanceConnectionRecoveryView } from '@/lib/connectors/monarch-money/recovery-contract';

export function FinanceConnectionWarning({
  connectorId,
  recovery,
  onVerified,
}: {
  connectorId: string;
  recovery: FinanceConnectionRecoveryView;
  onVerified: () => void | Promise<void>;
}) {
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    setVerifying(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/connectors/${encodeURIComponent(connectorId)}/finance/recovery`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      const result = await response.json() as { recovered?: boolean; reason?: string };
      if (!response.ok || result.recovered !== true) {
        throw new Error(
          result.reason === 'bounded_sync_failed'
            ? 'The bounded Finance refresh failed. Stale data remains visible.'
            : 'Recovery is not verified yet. Reconnect Monarch in Tyrion, then try again.',
        );
      }
      await onVerified();
    } catch (verificationError) {
      setError(
        verificationError instanceof Error
          ? verificationError.message
          : 'Recovery verification failed.',
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section
      role="alert"
      aria-label="Monarch connection warning"
      className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-amber-100">Finance data may be stale</h2>
          <p className="mt-1 text-sm text-amber-100/80">{recovery.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {recovery.reconnectUrl && (
              <a
                href={recovery.reconnectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-amber-300 px-3 py-2 text-xs font-semibold text-amber-950 focus-visible:ring-2 focus-visible:ring-amber-100"
              >
                Reconnect Monarch <ExternalLink size={13} aria-hidden="true" />
              </a>
            )}
            <button
              type="button"
              onClick={() => void verify()}
              disabled={verifying}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-amber-300/40 px-3 py-2 text-xs font-semibold text-amber-100 focus-visible:ring-2 focus-visible:ring-amber-100 disabled:opacity-60"
            >
              {verifying
                ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />
                : <RefreshCw size={13} aria-hidden="true" />}
              Verify recovery
            </button>
          </div>
          {error && <p className="mt-2 text-xs font-medium text-red-200">{error}</p>}
        </div>
      </div>
    </section>
  );
}
