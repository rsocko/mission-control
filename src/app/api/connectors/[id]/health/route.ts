import { NextResponse } from 'next/server';
import db from '@/db';
import {
  connectorConfigs,
  financeInsightPublicationDelivery,
  financeInsightPublicationState,
  financeSyncState,
  syncJobs,
} from '@/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createDocumentClient } from '@/lib/connectors/document-intelligence/document-client';
import { getDocumentIntelligenceBaseUrl, getDocumentIntelligenceApiKey } from '@/lib/connectors/document-intelligence';
import { isDemoMode } from '@/lib/mode';
import { financeConnectorConfigFromRow } from '@/lib/connectors/monarch-money/config';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from '@/lib/connectors/monarch-money/client';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import { getFinanceDatasetHealth } from '@/lib/connectors/monarch-money/dataset-sync';
import { normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';
import logger from '@/lib/logger';

/**
 * GET /api/connectors/[id]/health
 * Returns module-level health for the Document Intelligence connector.
 * For non-DI connectors, returns a basic status based on last sync.
 */
export async function GET(
  request: Request,
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
      return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    }

    if (normalizeFinanceProviderAlias(connector.type)) {
      if (!isTrustedFinanceReadRequest(request)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      if (isDemoMode()) {
        const demoAsOf = new Date();
        const projection = getFinanceDatasetHealth(id, demoAsOf);
        return NextResponse.json({
          overall: connector.enabled ? 'healthy' : 'disabled',
          modules: [
            {
              name: 'Monarch Bridge',
              enabled: connector.enabled,
              status: connector.enabled ? 'healthy' : 'disabled',
              detail: 'Demo finance data is available',
            },
            {
              name: 'Tyrion Attribution',
              enabled: connector.enabled,
              status: connector.enabled ? 'healthy' : 'disabled',
              detail: 'Demo attribution is available',
            },
          ],
          bridge: {
            reachable: true,
            authenticated: true,
            authState: 'connected',
            mode: 'demo',
          },
          sync: {
            status: 'succeeded',
            lastAttemptAt: null,
            lastSuccessfulSyncAt: null,
            lastSuccessfulWindow: null,
            freshnessMinutes: null,
            stale: false,
            lastErrorCode: null,
            activeJob: null,
          },
          attribution: {
            status: 'healthy',
            lastAttemptAt: null,
            lastSuccessfulAt: null,
            lastErrorCode: null,
            policyVersion: null,
            engineVersion: null,
          },
          insights: {
            capture: {
              status: 'idle',
              lastAttemptAt: null,
              lastErrorCode: null,
            },
            evaluation: {
              status: 'idle',
              stage: 'idle',
              lastAttemptAt: null,
              lastSuccessfulAt: null,
              lastErrorCode: null,
              retryable: false,
            },
          },
          projection,
        });
      }
      const config = financeConnectorConfigFromRow(connector);
      const [[state], [activeJob], [publication], [delivery]] = await Promise.all([
        db.select().from(financeSyncState)
          .where(eq(financeSyncState.connectorId, id)).limit(1),
        db.select({
          id: syncJobs.id,
          status: syncJobs.status,
          attempt: syncJobs.attempt,
          maxAttempts: syncJobs.maxAttempts,
          availableAt: syncJobs.availableAt,
          startedAt: syncJobs.startedAt,
        }).from(syncJobs).where(and(
          eq(syncJobs.connectorId, id),
          inArray(syncJobs.status, ['queued', 'running']),
        )).orderBy(desc(syncJobs.createdAt)).limit(1),
        db.select({
          status: financeInsightPublicationState.lastCaptureOutcome,
          lastAttemptAt: financeInsightPublicationState.lastCaptureAttemptAt,
          lastErrorCode: financeInsightPublicationState.lastErrorCode,
        }).from(financeInsightPublicationState)
          .where(eq(financeInsightPublicationState.connectorId, id))
          .limit(1),
        db.select({
          status: financeInsightPublicationDelivery.evaluationState,
          stage: financeInsightPublicationDelivery.stage,
          lastAttemptAt: financeInsightPublicationDelivery.lastAttemptAt,
          lastSuccessfulAt: financeInsightPublicationDelivery.lastSuccessfulAt,
          lastErrorCode: financeInsightPublicationDelivery.lastErrorCode,
          retryable: financeInsightPublicationDelivery.lastErrorRetryable,
        }).from(financeInsightPublicationDelivery)
          .where(eq(financeInsightPublicationDelivery.connectorId, id))
          .orderBy(desc(financeInsightPublicationDelivery.updatedAt))
          .limit(1),
      ]);
      let bridge:
        | Awaited<ReturnType<MonarchBridgeClient['getHealth']>>
        | null = null;
      let bridgeErrorCode: string | null = null;
      if (connector.enabled) {
        try {
          bridge = await new MonarchBridgeClient(config).getHealth();
        } catch (error) {
          bridgeErrorCode = error instanceof MonarchBridgeError
            ? error.code
            : 'bridge_unavailable';
        }
      }
      const lastSuccessMs = state?.lastSuccessfulSyncAt
        ? Date.parse(state.lastSuccessfulSyncAt)
        : NaN;
      const freshnessMinutes = Number.isFinite(lastSuccessMs)
        ? Math.max(0, Math.floor((Date.now() - lastSuccessMs) / 60_000))
        : null;
      const staleAfterMinutes = Math.max((connector.pollIntervalMinutes ?? 240) * 2, 60);
      const stale = freshnessMinutes !== null && freshnessMinutes > staleAfterMinutes;
      const authenticated = bridge?.authenticated === true;
      const attributionStatus = state?.attributionStatus ?? 'idle';
      const projection = getFinanceDatasetHealth(id);
      const insightUnhealthy = Boolean(publication?.lastErrorCode)
        || Boolean(delivery?.lastErrorCode)
        || delivery?.status === 'failed'
        || delivery?.status === 'unavailable';
      const overall = !connector.enabled
        ? 'disabled'
        : bridgeErrorCode || !authenticated
          ? 'unhealthy'
          : state?.status === 'failed'
              || stale
              || attributionStatus === 'degraded'
              || attributionStatus === 'unavailable'
              || insightUnhealthy
              || projection.aggregate !== 'fresh'
            ? 'degraded'
            : 'healthy';
      return NextResponse.json({
        overall,
        modules: [
          {
            name: 'Monarch Bridge',
            enabled: connector.enabled,
            status: !connector.enabled
              ? 'disabled'
              : bridgeErrorCode
              ? 'unreachable'
              : authenticated
                ? bridge?.status === 'ok' ? 'healthy' : 'degraded'
                : 'authentication_required',
            detail: bridgeErrorCode
              ? `Bridge request failed (${bridgeErrorCode})`
              : `Authentication state: ${bridge?.authState ?? 'unknown'}`,
          },
          {
            name: 'Tyrion Attribution',
            enabled: connector.enabled,
            status: !connector.enabled ? 'disabled' : attributionStatus,
            detail: state?.attributionLastErrorCode
              ? `Attribution requires attention (${state.attributionLastErrorCode})`
              : attributionStatus === 'healthy'
                ? `Policy ${state?.attributionPolicyVersion ?? 'current'}`
                : 'Attribution has not completed yet',
          },
        ],
        bridge: bridge ? {
          reachable: bridge.reachable,
          authenticated: bridge.authenticated,
          authState: bridge.authState,
          mode: bridge.mode,
        } : {
          reachable: false,
          authenticated: false,
          authState: 'unknown',
          mode: null,
        },
        sync: {
          status: state?.status ?? 'idle',
          lastAttemptAt: state?.lastAttemptAt ?? null,
          lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt ?? null,
          lastSuccessfulWindow: state?.lastSuccessfulWindowStart && state.lastSuccessfulWindowEnd
            ? {
                start: state.lastSuccessfulWindowStart,
                end: state.lastSuccessfulWindowEnd,
              }
            : null,
          freshnessMinutes,
          stale,
          lastErrorCode: state?.lastErrorCode ?? bridgeErrorCode,
          activeJob: activeJob ? {
            id: activeJob.id,
            status: activeJob.status,
            retrying: activeJob.status === 'queued' && activeJob.attempt > 0,
            attempt: activeJob.attempt,
            maxAttempts: activeJob.maxAttempts,
            availableAt: activeJob.availableAt,
            startedAt: activeJob.startedAt,
          } : null,
        },
        attribution: {
          status: attributionStatus,
          lastAttemptAt: state?.attributionLastAttemptAt ?? null,
          lastSuccessfulAt: state?.attributionLastSuccessfulAt ?? null,
          lastErrorCode: state?.attributionLastErrorCode ?? null,
          policyVersion: state?.attributionPolicyVersion ?? null,
          engineVersion: state?.attributionEngineVersion ?? null,
        },
        insights: {
          capture: {
            status: publication?.status ?? 'idle',
            lastAttemptAt: publication?.lastAttemptAt ?? null,
            lastErrorCode: publication?.lastErrorCode ?? null,
          },
          evaluation: {
            status: delivery?.status ?? 'idle',
            stage: delivery?.stage ?? 'idle',
            lastAttemptAt: delivery?.lastAttemptAt ?? null,
            lastSuccessfulAt: delivery?.lastSuccessfulAt ?? null,
            lastErrorCode: delivery?.lastErrorCode ?? null,
            retryable: delivery?.retryable ?? false,
          },
        },
        projection,
      });
    }

    if (connector.type !== 'document-intelligence') {
      return NextResponse.json({
        overall: connector.enabled ? 'healthy' : 'disabled',
        modules: [],
      });
    }

    // Demo mode
    if (isDemoMode()) {
      return NextResponse.json({
        overall: 'healthy',
        modules: [
          { name: 'Action Queue', enabled: true, status: 'healthy', detail: '12 pending actions' },
          { name: 'Statement Tracking', enabled: true, status: 'healthy', detail: '2 missing statements' },
          { name: 'EOB Matching', enabled: true, status: 'healthy', detail: '3 unmatched EOBs' },
        ],
        stats: {
          actionQueue: { pending: 12, completed: 45, dismissed: 3 },
          statements: { missing: 2, tracked: 18 },
          eobMatching: { unmatched: 3, matched: 22 },
        },
        latencyMs: 42,
      });
    }

    const credentials = connector.credentials as Record<string, string> | null;
    const settings = typeof connector.settings === 'string'
      ? JSON.parse(connector.settings)
      : (connector.settings as Record<string, unknown> | null) || {};

    const baseUrl = getDocumentIntelligenceBaseUrl(settings);
    const apiKey = getDocumentIntelligenceApiKey(credentials, settings);

    const client = createDocumentClient({ baseUrl, apiKey });

    const start = Date.now();
    const modules: Array<{ name: string; enabled: boolean; status: string; detail?: string }> = [];

    // Check hub health
    let hubHealthy = false;
    try {
      const health = await client.fetchHealth();
      hubHealthy = health.status !== 'unhealthy';
    } catch (err) {
      return NextResponse.json({
        overall: 'unhealthy',
        modules: [{ name: 'Hub', enabled: true, status: 'unreachable', detail: err instanceof Error ? err.message : String(err) }],
        latencyMs: Date.now() - start,
      });
    }

    // Check modules based on settings
    const moduleSettings = settings.modules as { actionQueue?: boolean; statements?: boolean; eobMatching?: boolean } | undefined;
    const enabledModules = {
      actionQueue: moduleSettings?.actionQueue !== false,
      statements: moduleSettings?.statements !== false,
      eobMatching: moduleSettings?.eobMatching !== false,
    };

    if (enabledModules.actionQueue) {
      try {
        const actions = await client.fetchJson<unknown[]>('/api/action-queue/actions', { status: 'pending' });
        modules.push({ name: 'Action Queue', enabled: true, status: 'healthy', detail: `${actions.length} pending actions` });
      } catch (err) {
        modules.push({ name: 'Action Queue', enabled: true, status: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    } else {
      modules.push({ name: 'Action Queue', enabled: false, status: 'disabled' });
    }

    if (enabledModules.statements) {
      try {
        const missing = await client.fetchJson<unknown[]>('/api/statements/missing');
        modules.push({ name: 'Statement Tracking', enabled: true, status: 'healthy', detail: `${missing.length} missing statements` });
      } catch (err) {
        modules.push({ name: 'Statement Tracking', enabled: true, status: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    } else {
      modules.push({ name: 'Statement Tracking', enabled: false, status: 'disabled' });
    }

    if (enabledModules.eobMatching) {
      try {
        const unmatched = await client.fetchJson<unknown[]>('/api/eob/unmatched');
        modules.push({ name: 'EOB Matching', enabled: true, status: 'healthy', detail: `${unmatched.length} unmatched EOBs` });
      } catch (err) {
        modules.push({ name: 'EOB Matching', enabled: true, status: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    } else {
      modules.push({ name: 'EOB Matching', enabled: false, status: 'disabled' });
    }

    // Fetch stats (optional, non-fatal)
    let stats = null;
    try {
      stats = await client.fetchStats();
    } catch {
      // stats are optional
    }

    const hasErrors = modules.some(m => m.status === 'error');
    const overall = !hubHealthy ? 'unhealthy' : hasErrors ? 'degraded' : 'healthy';

    return NextResponse.json({
      overall,
      modules,
      stats,
      latencyMs: Date.now() - start,
    });
  } catch {
    logger.error(
      { route: 'connector_health', failure: 'unexpected' },
      'Connector health check failed',
    );
    return NextResponse.json(
      { error: 'Failed to check connector health', code: 'health_check_failed' },
      { status: 500 }
    );
  }
}
