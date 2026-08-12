import { NextResponse } from 'next/server';
import {
  getDocumentIntelligenceBaseUrl,
  getDocumentIntelligenceApiKey,
} from '@/lib/connectors/document-intelligence';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from '@/lib/connectors/monarch-money/client';
import { describeTyrionConnectionError } from '@/lib/connectors/monarch-money/connection-error';
import { sanitizeFinanceConnectorWrite } from '@/lib/connectors/monarch-money/config';

/**
 * POST /api/connectors/test-pre-save
 * Tests connectivity for a connector type BEFORE it has been saved to the database.
 * This avoids CORS issues by proxying the external request through the server.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, credentials, settings } = body as {
      type: string;
      credentials?: Record<string, string>;
      settings?: Record<string, unknown>;
    };

    if (!type) {
      return NextResponse.json(
        { success: false, error: 'Missing connector type' },
        { status: 400 }
      );
    }

    const result = await testUnsavedConnector(type, credentials || {}, settings || {});
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, error: `Test failed: ${message}` },
      { status: 500 }
    );
  }
}

async function testUnsavedConnector(
  type: string,
  credentials: Record<string, string>,
  settings: Record<string, unknown>
): Promise<{ success: boolean; latencyMs: number; error?: string; details?: string }> {
  const start = Date.now();

  try {
    switch (type) {
      case 'document-intelligence': {
        const baseUrl = getDocumentIntelligenceBaseUrl(settings);
        const apiKey = getDocumentIntelligenceApiKey(credentials, settings);

        const headers: Record<string, string> = apiKey
          ? { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey }
          : { Accept: 'application/json' };

        const res = await fetch(`${baseUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });

        const latencyMs = Date.now() - start;
        if (res.ok) {
          const data = await res.json();
          const status = (data as Record<string, unknown>).status || 'unknown';
          const modules = (data as Record<string, unknown>).modules;
          const moduleCount = modules ? Object.keys(modules as object).length : 0;
          const detail = moduleCount > 0
            ? `OWL ${status} — ${moduleCount} Paperless-ngx module${moduleCount !== 1 ? 's' : ''} reporting`
            : `OWL ${status}`;
          return { success: status !== 'unhealthy', latencyMs, details: String(detail) };
        }
        if (res.status === 401 || res.status === 403) {
          return { success: false, latencyMs, error: 'Authentication failed -- check API key' };
        }
        return { success: false, latencyMs, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      case 'finance-manager':
      case 'finance':
      case 'monarch-money': {
        const config = sanitizeFinanceConnectorWrite({ type, credentials, settings });
        const health = await new MonarchBridgeClient(config).getHealth();
        const latencyMs = Date.now() - start;
        if (health.authenticated) {
          return { success: true, latencyMs, details: 'Tyrion bridge reachable and authenticated with Monarch' };
        }
        return {
          success: false,
          latencyMs,
          error: 'Tyrion is reachable, but its Monarch session is not authenticated',
        };
      }

      default: {
        const latencyMs = Date.now() - start;
        return { success: false, latencyMs, error: `No pre-save test for connector type: ${type}` };
      }
    }
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    if (err instanceof MonarchBridgeError) {
      return {
        success: false,
        latencyMs,
        error: describeTyrionConnectionError(err),
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timeout') || message.includes('abort')) {
      return { success: false, latencyMs, error: 'Connection timed out (10s)' };
    }
    return { success: false, latencyMs, error: message };
  }
}
