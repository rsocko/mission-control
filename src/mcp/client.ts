/**
 * Shared HTTP client for calling Mission Control's REST API.
 */

const MC_BASE_URL = process.env.MC_BASE_URL || 'http://localhost:3099';
const MC_API_KEY = process.env.MC_API_KEY;

export interface McResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (MC_API_KEY) {
    headers['X-MC-API-Key'] = MC_API_KEY;
  }
  return headers;
}

export async function mcFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<McResponse<T>> {
  const url = `${MC_BASE_URL}${path}`;
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...getHeaders(),
        ...(options.headers as Record<string, string> | undefined),
      },
    });

    const text = await response.text();
    let data: T | undefined;
    try {
      data = JSON.parse(text) as T;
    } catch {
      // Non-JSON response
    }

    if (!response.ok) {
      const errorMsg = data && typeof data === 'object' && 'error' in data
        ? String((data as Record<string, unknown>).error)
        : `HTTP ${response.status}: ${text.slice(0, 200)}`;
      return { ok: false, status: response.status, error: errorMsg };
    }

    return { ok: true, status: response.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function mcGet<T = unknown>(path: string) {
  return mcFetch<T>(path, { method: 'GET' });
}

export function mcPost<T = unknown>(path: string, body: unknown) {
  return mcFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function mcPatch<T = unknown>(path: string, body: unknown) {
  return mcFetch<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
