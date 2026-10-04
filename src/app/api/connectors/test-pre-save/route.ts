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
import { createHAClient } from '@/lib/connectors/home-assistant/ha-client';
import {
  normalizeHomeAssistantSettings,
  readHomeAssistantCredentials,
} from '@/lib/connectors/home-assistant/settings';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { createCompanionActionClient } from '@/lib/connectors/rymessage/companion-action-client';
import {
  normalizeTrustedOrigin,
  normalizeTrustedOrigins,
} from '@/lib/connectors/rymessage/action-contract-v2';

/**
 * POST /api/connectors/test-pre-save
 * Tests connectivity for a connector type BEFORE it has been saved to the database.
 * This avoids CORS issues by proxying the external request through the server.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, connectorId, credentials, settings } = body as {
      type: string;
      connectorId?: string;
      credentials?: Record<string, string>;
      settings?: Record<string, unknown>;
    };

    if (!type) {
      return NextResponse.json(
        { success: false, error: 'Missing connector type' },
        { status: 400 }
      );
    }

    let effectiveCredentials = credentials || {};
    if (type === 'home-assistant' && connectorId && !effectiveCredentials.accessToken) {
      const stored = await getCorePersistenceRepositories().connectors.get(connectorId);
      if (!stored || stored.type !== 'home-assistant') {
        return NextResponse.json(
          { success: false, error: 'Home Assistant connector not found' },
          { status: 404 },
        );
      }
      effectiveCredentials = {
        ...stored.credentials,
        ...effectiveCredentials,
      };
    }
    const result = await testUnsavedConnector(type, effectiveCredentials, settings || {});
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
): Promise<{
  success: boolean;
  latencyMs: number;
  error?: string;
  details?: string;
  sources?: Record<string, unknown>;
}> {
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

      case 'home-assistant': {
        const normalized = normalizeHomeAssistantSettings(settings);
        const { accessToken } = readHomeAssistantCredentials(credentials, settings);
        if (!accessToken) {
          return { success: false, latencyMs: 0, error: 'A long-lived access token is required' };
        }
        const result = await createHAClient({
          baseUrl: normalized.baseUrl,
          accessToken,
        }).testConnection();
        const latencyMs = Date.now() - start;
        if (!result.ok) {
          return { success: false, latencyMs, error: result.error || 'Connection failed' };
        }
        const available = Object.values(result.sources || {}).filter(source => source.available).length;
        return {
          success: true,
          latencyMs,
          details: `Connected — ${available} of 3 notification sources available`,
          sources: result.sources,
        };
      }

      case 'rymessage': {
        if (settings.mode !== 'companion') {
          return {
            success: false,
            latencyMs: Date.now() - start,
            error: 'RyMessage setup requires Companion mode',
          };
        }
        const baseUrl = typeof settings.companionBaseUrl === 'string'
          ? settings.companionBaseUrl.trim().replace(/\/+$/, '')
          : '';
        if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
          return {
            success: false,
            latencyMs: Date.now() - start,
            error: 'Enter an absolute HTTP(S) Companion URL',
          };
        }
        const trustedMissionControlOrigin = normalizeTrustedOrigin(
          settings.trustedMissionControlOrigin,
        );
        if (!trustedMissionControlOrigin) {
          return {
            success: false,
            latencyMs: Date.now() - start,
            error: 'Enter the exact Mission Control HTTP(S) origin provisioned in Companion',
          };
        }
        const trustedTaskOrigins = normalizeTrustedOrigins(settings.trustedTaskOrigins);
        if (!trustedTaskOrigins) {
          return {
            success: false,
            latencyMs: Date.now() - start,
            error: 'Enter only exact HTTP(S) trusted task origins',
          };
        }
        const credentialEnv = typeof settings.credentialEnv === 'string'
          ? settings.credentialEnv
          : 'RYMESSAGE_COMPANION_ACTION_FEED_TOKEN';
        if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(credentialEnv)) {
          return {
            success: false,
            latencyMs: Date.now() - start,
            error: 'The credential environment variable name is invalid',
          };
        }
        const credential = process.env[credentialEnv];
        if (!credential) {
          return {
            success: false,
            latencyMs: Date.now() - start,
            error: `${credentialEnv} is not available to the Mission Control web runtime`,
          };
        }
        const page = await createCompanionActionClient({
          baseUrl,
          credential,
          maxRetries: 0,
          trustedMissionControlOrigin,
          trustedTaskOrigins,
        }).fetchPageV2(null);
        return {
          success: true,
          latencyMs: Date.now() - start,
          details: `Connected to Companion ActionV2 ${page.schemaVersion}`,
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
