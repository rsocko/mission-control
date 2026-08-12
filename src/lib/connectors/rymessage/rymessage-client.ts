/**
 * RyMessage REST/SQLite API client — fetches actions from the Action Center.
 */

type RawActionRecord = Record<string, unknown>;

const DEFAULT_API_URL = 'http://localhost:1234/api/v1';

export interface RyMessageClientOptions {
  mode: 'webhook' | 'sqlite' | 'rest';
  restUrl?: string;
  sqlitePath?: string;
  apiKey?: string;
}

export interface RyMessageClient {
  fetchActions(since?: Date): Promise<RawActionRecord[]>;
  testRest(): Promise<{ ok: boolean; status?: number }>;
  testSqlite(): Promise<{ exists: boolean; path: string }>;
}

export function createRyMessageClient(options: RyMessageClientOptions): RyMessageClient {
  const baseUrl = (options.restUrl || DEFAULT_API_URL).replace(/\/$/, '');

  function getAuthHeaders(): HeadersInit {
    return options.apiKey
      ? { 'X-API-Key': options.apiKey }
      : {};
  }

  function isRecord(value: unknown): value is RawActionRecord {
    return typeof value === 'object' && value !== null;
  }

  function extractActionArray(payload: unknown): RawActionRecord[] {
    if (Array.isArray(payload)) {
      return payload.filter(isRecord);
    }
    if (!isRecord(payload)) {
      return [];
    }

    const candidates = [payload.actions, payload.items, payload.data, payload.results];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter(isRecord);
      }
    }

    return [];
  }

  async function fetchActionsViaRest(since?: Date): Promise<RawActionRecord[]> {
    const params = new URLSearchParams({ limit: '50' });
    if (since) {
      params.set('since', since.toISOString());
    }

    try {
      const response = await fetch(`${baseUrl}/actions?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        return [];
      }

      const payload = await response.json() as unknown;
      return extractActionArray(payload);
    } catch {
      return [];
    }
  }

  async function fetchActionsViaSqlite(since?: Date): Promise<RawActionRecord[]> {
    void since;
    if (!options.sqlitePath) {
      return [];
    }

    let db: import('better-sqlite3').Database | null = null;

    try {
      const Database = (await import('better-sqlite3')).default;
      db = new Database(options.sqlitePath, { readonly: true });

      const columns = new Set(
        (db.prepare('PRAGMA table_info(extracted_actions)').all() as Array<{ name: string }>).map((row) => row.name)
      );
      const orderColumn = [
        'updated_at',
        'created_at',
        'last_seen_at',
        'first_seen_at',
        'updatedAt',
        'createdAt',
        'lastSeenAt',
        'firstSeenAt',
      ].find((column) => columns.has(column));

      const query = orderColumn
        ? `SELECT * FROM extracted_actions ORDER BY ${orderColumn} DESC LIMIT 200`
        : 'SELECT * FROM extracted_actions LIMIT 200';
      return db.prepare(query).all() as RawActionRecord[];
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  return {
    async fetchActions(since?: Date): Promise<RawActionRecord[]> {
      if (options.mode === 'rest') {
        return fetchActionsViaRest(since);
      }
      if (options.mode === 'sqlite') {
        return fetchActionsViaSqlite(since);
      }
      return [];
    },

    async testRest(): Promise<{ ok: boolean; status?: number }> {
      try {
        const response = await fetch(`${baseUrl}/health`, {
          headers: getAuthHeaders(),
        });
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false };
      }
    },

    async testSqlite(): Promise<{ exists: boolean; path: string }> {
      const fs = await import('fs');
      const path = options.sqlitePath || '';
      return { exists: !!path && fs.existsSync(path), path };
    },
  };
}
