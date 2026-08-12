/**
 * Home Assistant REST API client — state fetching and connection testing.
 */

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HAClientOptions {
  baseUrl: string;
  accessToken: string;
}

export interface HAClient {
  fetchStates(): Promise<HomeAssistantState[]>;
  testConnection(): Promise<{ ok: boolean; serviceCount?: number; status?: number; error?: string }>;
}

export function createHAClient(options: HAClientOptions): HAClient {
  const { baseUrl, accessToken } = options;

  function buildHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  return {
    async fetchStates(): Promise<HomeAssistantState[]> {
      const response = await fetch(`${baseUrl}/api/states`, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch Home Assistant states: HTTP ${response.status}`);
      }

      const payload = await response.json() as unknown;
      return Array.isArray(payload) ? payload as HomeAssistantState[] : [];
    },

    async testConnection(): Promise<{ ok: boolean; serviceCount?: number; status?: number; error?: string }> {
      try {
        const response = await fetch(`${baseUrl}/api/services`, {
          headers: buildHeaders(),
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          return { ok: false, status: response.status };
        }

        const services = await response.json() as unknown[];
        return { ok: true, serviceCount: services.length };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  };
}
