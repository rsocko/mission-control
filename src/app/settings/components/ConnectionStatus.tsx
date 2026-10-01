'use client';

import { AlertTriangle, Circle, Loader2, Wifi, WifiOff } from 'lucide-react';
import type { ConnectorConfig } from './types';
import type { FinanceConnectionRecoveryView } from '@/lib/connectors/monarch-money/recovery-contract';

export interface ConnectorHealthResponse {
  overall: string;
  modules: Array<{ name: string; enabled: boolean; status: string; detail?: string }>;
  latencyMs?: number;
  recovery?: FinanceConnectionRecoveryView | null;
}

export interface ConnectorHealthState {
  requestKey: string;
  data: ConnectorHealthResponse | null;
}

type ExplicitConnectionOutcome = {
  status: 'success' | 'failed';
  error: string | null;
};

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getExplicitConnectionOutcome(
  connector: ConnectorConfig,
): ExplicitConnectionOutcome | null {
  const testOutcome = connector.lastTestStatus
    ? {
        status: connector.lastTestStatus,
        error: connector.lastTestError ?? null,
        at: parseTimestamp(connector.lastTestAt),
      }
    : null;
  const syncOutcome = connector.lastSyncStatus
    ? {
        status: connector.lastSyncStatus,
        error: connector.lastSyncError ?? null,
        at: parseTimestamp(connector.lastSyncAt),
      }
    : null;

  if (!testOutcome) return syncOutcome;
  if (!syncOutcome) return testOutcome;

  if (testOutcome.at !== null && syncOutcome.at !== null && syncOutcome.at > testOutcome.at) {
    return syncOutcome;
  }
  return testOutcome;
}

export function ConnectionStatus({
  connector,
  healthState,
}: {
  connector: ConnectorConfig;
  healthState?: ConnectorHealthState;
}) {
  const hasCredentials = connector.hasCredentials === true;
  const usesHealthStatus = connector.type === 'document-intelligence'
    || connector.type === 'finance-manager'
    || connector.type === 'finance'
    || connector.type === 'monarch-money';

  if (!connector.enabled) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--text-muted)] font-medium">
        <Circle size={6} /> Disabled
      </span>
    );
  }

  if (connector.type === 'scout') {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400 font-medium border border-emerald-800/30">
        <Wifi size={8} /> Active
      </span>
    );
  }

  if (usesHealthStatus) {
    if (!healthState) {
      return (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--text-muted)] font-medium border border-[var(--border)]">
          <Loader2 size={8} className="animate-spin" /> Checking
        </span>
      );
    }

    if (healthState.data?.overall === 'healthy') {
      return (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400 font-medium border border-emerald-800/30">
          <Wifi size={8} /> Active
        </span>
      );
    }

    if (healthState.data?.overall === 'degraded') {
      return (
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 font-medium border border-amber-800/30">
          <AlertTriangle size={8} /> Degraded
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-900/30 text-red-400 font-medium border border-red-800/30">
        <WifiOff size={8} /> Unhealthy
      </span>
    );
  }

  let connectorSettings: Record<string, unknown> = {};
  if (typeof connector.settings === 'string') {
    try {
      connectorSettings = JSON.parse(connector.settings) as Record<string, unknown>;
    } catch {
      connectorSettings = {};
    }
  } else {
    connectorSettings = connector.settings || {};
  }

  const hasTokens = connectorSettings.hasTokens;
  const explicitOutcome = getExplicitConnectionOutcome(connector);
  if (explicitOutcome?.status === 'failed') {
    const isTokenIssue = /token|expired|401|unauthorized|re-authenticate/i.test(
      explicitOutcome.error ?? '',
    );
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-900/30 text-red-400 font-medium border border-red-800/30">
        <WifiOff size={8} /> {isTokenIssue ? 'Token Expired' : 'Connection Failed'}
      </span>
    );
  }

  if (explicitOutcome?.status === 'success' || hasCredentials || hasTokens) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400 font-medium border border-emerald-800/30">
        <Wifi size={8} /> Active
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 font-medium border border-amber-800/30">
      <WifiOff size={8} /> Not Connected
    </span>
  );
}
