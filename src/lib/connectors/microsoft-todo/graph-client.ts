import { connectorLogger } from '@/lib/logger';
import { getValidToken, getSubstrateToken, invalidateToken } from '@/lib/auth';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA_URL = 'https://graph.microsoft.com/beta';
const SUBSTRATE_BASE_URL = 'https://substrate.office.com/todob2/api/v1';

export { GRAPH_BASE_URL, GRAPH_BETA_URL, SUBSTRATE_BASE_URL };

/**
 * Fetch with retry logic for rate-limiting (429) and transient errors (5xx).
 * Respects Retry-After header from Microsoft Graph API.
 */
async function fetchWithRetry(
  url: string,
  getToken: () => Promise<string>,
  connectorId: string,
  options?: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | null = null;
  let didInvalidate = false;
  const method = options?.method?.toUpperCase() || 'GET';
  const canRetryAmbiguousOutcome = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const token = await getToken();
      const res = await fetch(url, {
        ...options,
        signal: options?.signal ?? AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
      });

      if (res.status === 401 && !didInvalidate && attempt < maxRetries) {
        didInvalidate = true;
        connectorLogger.warn({ attempt: attempt + 1, maxAttempts: maxRetries + 1 }, 'Graph fetch returned 401, invalidating token and retrying');
        await invalidateToken(connectorId);
        continue;
      }

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
        const delay = Math.min(retryAfter * 1000, 30000);
        connectorLogger.warn({ retryAfterSeconds: retryAfter, attempt: attempt + 1, maxAttempts: maxRetries + 1 }, 'Graph fetch rate limited, retrying');
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }

      if (res.status >= 500 && canRetryAmbiguousOutcome && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        connectorLogger.warn({ status: res.status, delayMs: delay, attempt: attempt + 1, maxAttempts: maxRetries + 1 }, 'Graph fetch server error, retrying');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!canRetryAmbiguousOutcome) {
        throw lastError;
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        connectorLogger.warn({ err: lastError, delayMs: delay, attempt: attempt + 1, maxAttempts: maxRetries + 1 }, 'Graph fetch network error, retrying');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

export function createGraphClient(connectorId: string) {
  return {
    graphFetch(path: string, options?: RequestInit): Promise<Response> {
      return fetchWithRetry(
        `${GRAPH_BASE_URL}${path}`,
        () => getValidToken(connectorId),
        connectorId,
        options,
      );
    },

    graphBetaFetch(path: string, options?: RequestInit): Promise<Response> {
      return fetchWithRetry(
        `${GRAPH_BETA_URL}${path}`,
        () => getValidToken(connectorId),
        connectorId,
        options,
      );
    },

    substrateFetch(path: string, options?: RequestInit): Promise<Response> {
      return fetchWithRetry(
        `${SUBSTRATE_BASE_URL}${path}`,
        () => getSubstrateToken(connectorId),
        connectorId,
        options,
      );
    },
  };
}

export type GraphClient = ReturnType<typeof createGraphClient>;
