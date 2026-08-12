/**
 * Document Intelligence HTTP client — API communication with retry support.
 */

export interface DocClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface DocHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  modules?: Record<string, { status: string; message?: string }>;
  version?: string;
}

export interface DocStatsResponse {
  actionQueue?: { pending: number; completed: number; dismissed: number };
  statements?: { missing: number; tracked: number };
  eobMatching?: { unmatched: number; matched: number };
}

export interface DocClient {
  fetchJson<T>(path: string, params?: Record<string, string | undefined>): Promise<T>;
  patchActionStatus(sourceId: string, status: 'pending' | 'done' | 'dismissed'): Promise<void>;
  fetchHealth(): Promise<DocHealthResponse>;
  fetchStats(): Promise<DocStatsResponse>;
}

export function createDocumentClient(options: DocClientOptions): DocClient {
  const { baseUrl, apiKey } = options;

  function buildUrl(path: string, params?: Record<string, string | undefined>): string {
    const url = new URL(`${baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  function getHeaders(): HeadersInit {
    if (!apiKey) {
      return { Accept: 'application/json' };
    }

    return {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-API-Key': apiKey,
    };
  }

  return {
    async fetchJson<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
      const response = await fetch(buildUrl(path, params), {
        headers: getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`OWL request failed: ${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    },

    async patchActionStatus(sourceId: string, status: 'pending' | 'done' | 'dismissed'): Promise<void> {
      const response = await fetch(buildUrl(`/api/action-queue/actions/${sourceId}`), {
        method: 'PATCH',
        headers: {
          ...getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        throw new Error(`OWL update failed: ${response.status} ${response.statusText}`);
      }
    },

    async fetchHealth(): Promise<DocHealthResponse> {
      const response = await fetch(buildUrl('/health'), {
        headers: getHeaders(),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<DocHealthResponse>;
    },

    async fetchStats(): Promise<DocStatsResponse> {
      const response = await fetch(buildUrl('/api/stats'), {
        headers: getHeaders(),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Stats fetch failed: ${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<DocStatsResponse>;
    },
  };
}
