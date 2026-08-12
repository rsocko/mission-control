import { connectorLogger } from '@/lib/logger';

export interface HttpClientOptions {
  /** Base URL for all requests */
  baseUrl: string;
  /** Function that returns a valid auth token */
  getToken: () => Promise<string>;
  /** Connector ID for logging context */
  connectorId: string;
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Optional callback when a token is invalidated */
  onTokenInvalid?: () => Promise<void>;
}

/**
 * Shared HTTP client with:
 * - Bearer auth injection
 * - 429 rate-limit retry with exponential backoff
 * - 5xx server error retries
 * - 401 token invalidation + retry
 * - JSON parsing/serialization
 * - Structured error logging
 */
export function createHttpClient(options: HttpClientOptions) {
  const { baseUrl, getToken, connectorId, maxRetries = 3, onTokenInvalid } = options;

  async function fetchWithRetry(
    path: string,
    requestOptions?: RequestInit,
  ): Promise<Response> {
    let lastError: Error | null = null;
    let didInvalidate = false;
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const token = await getToken();
        const res = await fetch(url, {
          ...requestOptions,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(requestOptions?.headers || {}),
          },
        });

        // 401: token expired/revoked — invalidate and retry once
        if (res.status === 401 && !didInvalidate && attempt < maxRetries) {
          didInvalidate = true;
          connectorLogger.warn({ connectorId, attempt: attempt + 1 }, 'HTTP 401 — invalidating token');
          if (onTokenInvalid) await onTokenInvalid();
          continue;
        }

        // 429: rate limited — respect Retry-After
        if (res.status === 429 && attempt < maxRetries) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
          const delay = Math.min(retryAfter * 1000, 30000);
          connectorLogger.warn({ connectorId, retryAfterSeconds: retryAfter, attempt: attempt + 1 }, 'HTTP 429 — rate limited');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        // 5xx: server error — exponential backoff
        if (res.status >= 500 && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          connectorLogger.warn({ connectorId, status: res.status, delayMs: delay, attempt: attempt + 1 }, 'HTTP 5xx — server error');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        return res;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          connectorLogger.warn({ connectorId, err: lastError, delayMs: delay, attempt: attempt + 1 }, 'HTTP network error — retrying');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }

    throw lastError || new Error(`Request to ${url} failed after ${maxRetries} retries`);
  }

  return {
    /** Raw fetch with auth + retry */
    fetch: fetchWithRetry,

    /** GET request, returns parsed JSON */
    async getJson<T = unknown>(path: string): Promise<T> {
      const res = await fetchWithRetry(path);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GET ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      return res.json() as Promise<T>;
    },

    /** POST request with JSON body, returns parsed JSON */
    async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
      const res = await fetchWithRetry(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`POST ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      return res.json() as Promise<T>;
    },

    /** PATCH request with JSON body, returns parsed JSON */
    async patchJson<T = unknown>(path: string, body: unknown): Promise<T> {
      const res = await fetchWithRetry(path, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`PATCH ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      return res.json() as Promise<T>;
    },

    /** DELETE request */
    async delete(path: string): Promise<void> {
      const res = await fetchWithRetry(path, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '');
        throw new Error(`DELETE ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      }
    },
  };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
