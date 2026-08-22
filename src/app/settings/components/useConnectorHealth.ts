'use client';

import { useEffect, useState } from 'react';
import type { ConnectorConfig } from './types';
import type { ConnectorHealthResponse, ConnectorHealthState } from './ConnectionStatus';
import { isFinanceConnectorType } from './types';

interface HealthTarget {
  id: string;
  requestKey: string;
}

function buildRequestKey(connector: ConnectorConfig, refresh: number) {
  return `${connector.id}:${connector.updatedAt}:${refresh}`;
}

export function useConnectorHealth(connectors: ConnectorConfig[]) {
  const [connectorHealth, setConnectorHealth] = useState<Record<string, ConnectorHealthState>>({});
  const [healthRefreshes, setHealthRefreshes] = useState<Record<string, number>>({});
  const targetSignature = JSON.stringify(
    connectors
      .filter(connector => (
        (connector.type === 'document-intelligence' || isFinanceConnectorType(connector.type))
        && connector.enabled
      ))
      .map(connector => ({
        id: connector.id,
        requestKey: buildRequestKey(connector, healthRefreshes[connector.id] || 0),
      }))
  );

  useEffect(() => {
    const healthTargets = JSON.parse(targetSignature) as HealthTarget[];
    let disposed = false;
    const controllers = new Map<string, AbortController>();

    const fetchHealth = async (target: HealthTarget, invalidateCachedState = false) => {
      if (controllers.has(target.id)) {
        return;
      }

      if (invalidateCachedState) {
        await Promise.resolve();
        if (disposed) {
          return;
        }
        setConnectorHealth(previous => {
          if (!previous[target.id]) {
            return previous;
          }
          const next = { ...previous };
          delete next[target.id];
          return next;
        });
      }

      const controller = new AbortController();
      controllers.set(target.id, controller);
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 30_000);

      try {
        const response = await fetch(`/api/connectors/${target.id}/health`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Health check failed with HTTP ${response.status}`);
        }

        const data = await response.json() as ConnectorHealthResponse;
        if (!disposed) {
          setConnectorHealth(previous => ({
            ...previous,
            [target.id]: { requestKey: target.requestKey, data },
          }));
        }
      } catch (error) {
        if (!disposed && (timedOut || !(error instanceof Error) || error.name !== 'AbortError')) {
          setConnectorHealth(previous => ({
            ...previous,
            [target.id]: { requestKey: target.requestKey, data: null },
          }));
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (controllers.get(target.id) === controller) {
          controllers.delete(target.id);
        }
      }
    };

    for (const target of healthTargets) {
      void fetchHealth(target, true);
    }

    const intervalId = window.setInterval(() => {
      for (const target of healthTargets) {
        void fetchHealth(target);
      }
    }, 60_000);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, [targetSignature]);

  const getHealthState = (connector: ConnectorConfig) => {
    if (
      connector.type !== 'document-intelligence'
      && !isFinanceConnectorType(connector.type)
    ) {
      return undefined;
    }

    const requestKey = buildRequestKey(connector, healthRefreshes[connector.id] || 0);
    const healthState = connectorHealth[connector.id];
    return healthState?.requestKey === requestKey ? healthState : undefined;
  };

  const refreshHealth = (id: string) => {
    setHealthRefreshes(previous => ({ ...previous, [id]: (previous[id] || 0) + 1 }));
  };

  return { getHealthState, refreshHealth };
}
