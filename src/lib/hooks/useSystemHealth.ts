'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { uiLogger } from '@/lib/client-logger';

export type OverallHealth = 'healthy' | 'attention' | 'informational';

export interface ConnectorHealthInfo {
  id: string;
  type: string;
  name: string;
  status: string;
  message: string;
  lastSyncAt?: string;
}

export interface SystemHealthData {
  overall: OverallHealth;
  message: string;
  connectors: ConnectorHealthInfo[];
  disabledFeatures: string[];
  database?: {
    status: 'healthy' | 'degraded' | 'critical' | 'error';
  };
  runtime?: {
    degradations?: string[];
  };
}

const HEALTH_REFRESH_INTERVAL_MS = 60_000;

export function useSystemHealth(enabled: boolean): SystemHealthData | null {
  const [health, setHealth] = useState<SystemHealthData | null>(null);
  const requestIdRef = useRef(0);

  const refreshHealth = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestIdRef.current;
    try {
      const response = await fetch('/api/health?detail=summary', {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) {
        throw new Error(`Health request failed with HTTP ${response.status}`);
      }
      const nextHealth = await response.json() as SystemHealthData;
      if (requestId === requestIdRef.current) setHealth(nextHealth);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId !== requestIdRef.current) return;
      uiLogger.error('Failed to fetch health status', { err: error });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const initialTimer = window.setTimeout(() => {
      void refreshHealth(controller.signal);
    }, 2_000);
    const interval = window.setInterval(() => {
      void refreshHealth(controller.signal);
    }, HEALTH_REFRESH_INTERVAL_MS);
    const handleSyncComplete = () => {
      void refreshHealth(controller.signal);
    };
    window.addEventListener('mission-control:sync-complete', handleSyncComplete);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      window.removeEventListener('mission-control:sync-complete', handleSyncComplete);
      controller.abort();
    };
  }, [enabled, refreshHealth]);

  return health;
}
