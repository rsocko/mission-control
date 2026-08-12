'use client';

import { AlertTriangle, Circle, Loader2, Wifi, WifiOff } from 'lucide-react';
import type { ConnectorConfig } from './types';

export interface ConnectorHealthResponse {
  overall: string;
  modules: Array<{ name: string; enabled: boolean; status: string; detail?: string }>;
  latencyMs?: number;
}

export interface ConnectorHealthState {
  requestKey: string;
  data: ConnectorHealthResponse | null;
}

export function ConnectionStatus({
  connector,
  healthState,
}: {
  connector: ConnectorConfig;
  healthState?: ConnectorHealthState;
}) {
  const hasCredentials = connector.hasCredentials === true;
  const usesHealthStatus = connector.type === 'document-intelligence';

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
  if (hasCredentials || hasTokens) {
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
