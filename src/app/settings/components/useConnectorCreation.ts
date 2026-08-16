'use client';

import { useCallback, useState } from 'react';

export type ConnectorCreationStatus = 'idle' | 'creating' | 'success' | 'error';

async function readCreationResponse(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
  }
  const text = await response.text();
  return text ? { error: text } : {};
}

export function useConnectorCreation() {
  const [status, setStatus] = useState<ConnectorCreationStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [connector, setConnector] = useState<Record<string, unknown> | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setConnector(null);
  }, []);

  const markCreating = useCallback(() => {
    setStatus('creating');
    setError(null);
  }, []);

  const markSuccess = useCallback((created?: Record<string, unknown> | null) => {
    setConnector(created ?? null);
    setStatus('success');
    setError(null);
  }, []);

  const markError = useCallback((creationError: unknown, fallback = 'Failed to create connector') => {
    const message = creationError instanceof Error ? creationError.message : String(creationError || fallback);
    setStatus('error');
    setError(message);
    return new Error(message);
  }, []);

  const create = useCallback(async (payload: Record<string, unknown>) => {
    markCreating();
    try {
      const response = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readCreationResponse(response);
      if (!response.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : 'Failed to create connector');
      }
      markSuccess(data);
      return data;
    } catch (creationError) {
      throw markError(creationError);
    }
  }, [markCreating, markError, markSuccess]);

  return {
    status,
    error,
    connector,
    create,
    reset,
    markCreating,
    markSuccess,
    markError,
  };
}
