import { NextResponse } from 'next/server';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { financeConnectorConfigFromRow } from '@/lib/connectors/monarch-money/config';
import { MonarchBridgeClient, MonarchBridgeError } from '@/lib/connectors/monarch-money/client';
import { describeTyrionConnectionError } from '@/lib/connectors/monarch-money/connection-error';
import { getDocumentIntelligenceBaseUrl, getDocumentIntelligenceApiKey } from '@/lib/connectors/document-intelligence';
import { normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';
import { isDemoMode } from '@/lib/mode';

/**
 * POST /api/connectors/[id]/test
 * Tests connectivity for a given connector by pinging its external API.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const [connector] = await db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id))
      .limit(1);

    if (!connector) {
      return NextResponse.json(
        { success: false, error: 'Connector not found' },
        { status: 404 }
      );
    }

    // In demo mode, simulate a successful connection test
    if (isDemoMode()) {
      const demoDetails: Record<string, string> = {
        'microsoft-todo': '5 lists accessible',
        'github-issues': 'Authenticated as demo-user',
        'outlook-calendar': 'Connection OK — 3 calendars found',
        'outlook-email': 'Connection OK — Inbox accessible',
        'rymessage': 'RyMessage reachable at localhost',
        finance: 'Tyrion bridge reachable — authenticated',
        'finance-manager': 'Tyrion bridge reachable — authenticated',
        'monarch-money': 'Tyrion bridge reachable — authenticated',
        'home-assistant': '42 service domains accessible',
        'document-intelligence': 'OWL healthy — 3 Paperless-ngx modules active',
      };
      return NextResponse.json({
        success: true,
        latencyMs: 87 + Math.floor(Math.random() * 200),
        details: demoDetails[connector.type] || 'Connection OK',
      });
    }

    if (normalizeFinanceProviderAlias(connector.type)) {
      const start = Date.now();
      try {
        const health = await new MonarchBridgeClient(
          financeConnectorConfigFromRow(connector),
        ).getHealth();
        return NextResponse.json(health.authenticated
          ? {
              success: true,
              latencyMs: Date.now() - start,
              details: 'Tyrion bridge reachable and authenticated with Monarch',
            }
          : {
              success: false,
              latencyMs: Date.now() - start,
              error: 'Tyrion is reachable, but its Monarch session is not authenticated yet',
            });
      } catch (error) {
        const code = error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable';
        return NextResponse.json({
          success: false,
          latencyMs: Date.now() - start,
          error: describeTyrionConnectionError({ code }),
        });
      }
    }

    const credentials = connector.credentials as Record<string, string> | null;
    const settings = typeof connector.settings === 'string'
      ? JSON.parse(connector.settings)
      : (connector.settings as Record<string, unknown> | null);
    const result = await testConnector(connector.type, credentials || {}, settings || {});

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Connector test failed. Check credentials and try again.' },
      { status: 500 }
    );
  }
}

async function testConnector(
  type: string,
  credentials: Record<string, string>,
  settings: Record<string, unknown>
): Promise<{ success: boolean; latencyMs: number; error?: string; details?: string }> {
  const start = Date.now();

  try {
    switch (type) {
      case 'microsoft-todo': {
        const token = credentials.accessToken || credentials.access_token;
        if (!token) {
          return { success: false, latencyMs: 0, error: 'No access token configured' };
        }
        const res = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          const data = await res.json();
          return { success: true, latencyMs, details: `${data.value?.length || 0} lists accessible` };
        }
        if (res.status === 401) {
          return { success: false, latencyMs, error: 'Token expired or invalid ? re-authenticate' };
        }
        return { success: false, latencyMs, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      case 'github-issues': {
        const token = credentials.accessToken || credentials.access_token || credentials.token;
        if (!token) {
          return { success: false, latencyMs: 0, error: 'No access token configured' };
        }
        const res = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          },
          signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          const data = await res.json();
          return { success: true, latencyMs, details: `Authenticated as ${data.login}` };
        }
        if (res.status === 401) {
          return { success: false, latencyMs, error: 'Token expired or invalid' };
        }
        return { success: false, latencyMs, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      case 'outlook-calendar':
      case 'outlook-email': {
        const token = credentials.accessToken || credentials.access_token;
        if (!token) {
          return { success: false, latencyMs: 0, error: 'No access token configured' };
        }
        const endpoint = type === 'outlook-calendar'
          ? 'https://graph.microsoft.com/v1.0/me/calendars'
          : 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox';
        const res = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          return { success: true, latencyMs, details: 'Connection OK' };
        }
        if (res.status === 401) {
          return { success: false, latencyMs, error: 'Token expired ? re-authenticate' };
        }
        return { success: false, latencyMs, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      case 'rymessage': {
        const mode = settings.mode === 'sqlite' ? 'sqlite' : 'rest';

        if (mode === 'sqlite') {
          const sqlitePath = typeof settings.sqlitePath === 'string'
            ? settings.sqlitePath
            : (typeof settings.dbPath === 'string' ? settings.dbPath : '');
          if (!sqlitePath) {
            return { success: false, latencyMs: 0, error: 'No RyMessage SQLite path configured' };
          }

          const fs = await import('fs');
          const latencyMs = Date.now() - start;
          return fs.existsSync(sqlitePath)
            ? { success: true, latencyMs, details: `RyMessage database found at ${sqlitePath}` }
            : { success: false, latencyMs, error: 'RyMessage database file not found' };
        }

        const baseUrl = typeof settings.restUrl === 'string'
          ? settings.restUrl.replace(/\/+$/, '')
          : (typeof settings.apiUrl === 'string'
              ? settings.apiUrl.replace(/\/+$/, '')
              : 'http://localhost:1234/api/v1');
        const apiKey =
          credentials.apiKey ||
          credentials.api_key ||
          (typeof settings.apiKey === 'string' ? settings.apiKey : '') ||
          '';
        const headers: HeadersInit = apiKey ? { 'X-API-Key': apiKey } : {};
        const res = await fetch(`${baseUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          return { success: true, latencyMs, details: `RyMessage reachable at ${baseUrl}` };
        }
        return { success: false, latencyMs, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      case 'home-assistant': {
        const baseUrl = typeof settings.baseUrl === 'string'
          ? settings.baseUrl.replace(/\/+$/, '')
          : (process.env.HOME_ASSISTANT_URL || 'http://localhost:8123');
        const token =
          credentials.accessToken ||
          credentials.token ||
          (typeof settings.accessToken === 'string' ? settings.accessToken : '') ||
          process.env.HOME_ASSISTANT_TOKEN ||
          '';

        if (!token) {
          return { success: false, latencyMs: 0, error: 'No Home Assistant access token configured' };
        }

        const res = await fetch(`${baseUrl}/api/services`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          const data = await res.json();
          return { success: true, latencyMs, details: `${Array.isArray(data) ? data.length : 0} service domains accessible` };
        }
        if (res.status === 401) {
          return { success: false, latencyMs, error: 'Token expired or invalid' };
        }
        return { success: false, latencyMs, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      case 'document-intelligence': {
        const baseUrl = getDocumentIntelligenceBaseUrl(settings);
        const apiKey = getDocumentIntelligenceApiKey(credentials, settings);
        const headers: HeadersInit = apiKey
          ? { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey }
          : { Accept: 'application/json' };

        const res = await fetch(`${baseUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          const data = await res.json();
          const status = data.status || 'unknown';
          const moduleCount = data.modules ? Object.keys(data.modules).length : 0;
          const detail = moduleCount > 0
            ? `OWL ${status} — ${moduleCount} Paperless-ngx module${moduleCount !== 1 ? 's' : ''} reporting`
            : `OWL ${status}`;
          return { success: status !== 'unhealthy', latencyMs, details: detail };
        }
        if (res.status === 401 || res.status === 403) {
          return { success: false, latencyMs, error: 'Authentication failed -- check API key' };
        }
        return { success: false, latencyMs, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      default: {
        const latencyMs = Date.now() - start;
        return { success: false, latencyMs, error: `No test available for connector type: ${type}` };
      }
    }
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timeout') || message.includes('abort')) {
      return { success: false, latencyMs, error: 'Connection timed out (10s)' };
    }
    return { success: false, latencyMs, error: message };
  }
}
