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

export type DocActionStatus = 'pending' | 'completed' | 'dismissed';

export type DocActionFeedback =
  | { feedback_type: 'not_an_action' }
  | { feedback_type: 'misclassified'; corrected_action_type: string }
  | { feedback_type: 'wrong_urgency'; corrected_urgency: string }
  | { feedback_type: 'wrong_amount'; corrected_amount: number | null };

export interface DocActionPage<T> {
  actions?: T[];
  items?: T[];
  results?: T[];
  next_cursor?: string | null;
  nextCursor?: string | null;
  page?: number;
  total_pages?: number;
  totalPages?: number;
}

export interface DocClient {
  fetchJson<T>(path: string, params?: Record<string, string | undefined>): Promise<T>;
  fetchAllActions<T>(status?: string): Promise<T[]>;
  patchActionStatus(sourceId: string, status: DocActionStatus): Promise<void>;
  snoozeAction(sourceId: string, until: string): Promise<void>;
  submitActionFeedback(sourceId: string, feedback: DocActionFeedback): Promise<void>;
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

  async function request(
    path: string,
    init: RequestInit = {},
    params?: Record<string, string | undefined>,
  ): Promise<Response> {
    const response = await fetch(buildUrl(path, params), {
      ...init,
      headers: {
        ...getHeaders(),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(
        `OWL request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
      );
    }
    return response;
  }

  async function postJson(path: string, body: unknown): Promise<void> {
    await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  return {
    async fetchJson<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
      const response = await request(path, {}, params);
      return response.json() as Promise<T>;
    },

    async fetchAllActions<T>(status = 'all'): Promise<T[]> {
      const all: T[] = [];
      let cursor: string | undefined;
      let page = 1;
      let offset = 0;
      let paginationMode: 'unknown' | 'array-offset' | 'envelope' = 'unknown';
      const seenPageKeys = new Set<string>();

      while (true) {
        const response = await request('/api/action-queue/actions', {}, {
          status,
          limit: '100',
          cursor,
          page: paginationMode === 'envelope' && !cursor ? String(page) : undefined,
          offset: paginationMode !== 'envelope' && !cursor ? String(offset) : undefined,
        });
        const payload = await response.json() as T[] | DocActionPage<T>;
        if (Array.isArray(payload)) {
          paginationMode = 'array-offset';
          const pageKey = `array:${JSON.stringify(payload)}`;
          if (seenPageKeys.has(pageKey)) {
            throw new Error('OWL pagination repeated an offset page');
          }
          seenPageKeys.add(pageKey);
          all.push(...payload);
          if (payload.length < 100) break;
          offset += payload.length;
          continue;
        }

        paginationMode = 'envelope';
        const actions = payload.actions ?? payload.items ?? payload.results ?? [];
        all.push(...actions);
        const nextCursor = payload.next_cursor ?? payload.nextCursor ?? undefined;
        const totalPages = payload.total_pages ?? payload.totalPages;
        const nextPage = nextCursor
          ? page
          : typeof totalPages === 'number' && page < totalPages
            ? page + 1
            : null;
        if (!nextCursor && nextPage === null) break;

        const pageKey = nextCursor ? `cursor:${nextCursor}` : `page:${nextPage}`;
        if (seenPageKeys.has(pageKey)) {
          throw new Error('OWL pagination repeated a page token');
        }
        seenPageKeys.add(pageKey);
        cursor = nextCursor;
        if (nextPage !== null) page = nextPage;
      }

      return all;
    },

    async patchActionStatus(sourceId: string, status: DocActionStatus): Promise<void> {
      await request(`/api/action-queue/actions/${encodeURIComponent(sourceId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      });
    },

    async snoozeAction(sourceId: string, until: string): Promise<void> {
      await postJson(
        `/api/action-queue/actions/${encodeURIComponent(sourceId)}/snooze`,
        { until },
      );
    },

    async submitActionFeedback(sourceId: string, feedback: DocActionFeedback): Promise<void> {
      await postJson(
        `/api/action-queue/actions/${encodeURIComponent(sourceId)}/feedback`,
        feedback,
      );
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
