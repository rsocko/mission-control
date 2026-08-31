import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { syncScheduler } from '@/lib/sync';
import { ConnectorOperationBusyError } from '@/lib/sync/connector-lock';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { FINANCE_PROVIDER_ALIASES, normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  FinanceInsightBackfillError,
  runFinanceInsightTransactionBackfill,
} from '@/lib/connectors/monarch-money/transaction-backfill';

async function getFinanceConnectorConfig(connectorId?: string) {
  const repositories = await getWorkerPersistenceRepositories();
  let resolvedId = connectorId;
  if (!resolvedId) {
    const ids = await repositories.finance.insights.connectors.listEnabledConnectorIds(
      FINANCE_PROVIDER_ALIASES,
      2,
    );
    if (ids.length === 0) throw new Error('Finance connector is not configured');
    if (ids.length > 1) {
      throw new Error('connectorId is required when multiple finance connectors are enabled');
    }
    [resolvedId] = ids;
  }
  const config = await repositories.connectors.get(resolvedId!);
  if (!config || !config.enabled || normalizeFinanceProviderAlias(config.type) === null) {
    throw new Error('Finance connector is not configured');
  }
  return config;
}

export async function POST(request: Request) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const body = await request.json().catch(() => ({})) as {
      connectorId?: unknown;
      full?: unknown;
      insightBackfill?: unknown;
    };
    const connectorId = typeof body.connectorId === 'string' ? body.connectorId : undefined;
    const config = await getFinanceConnectorConfig(connectorId);
    if (body.insightBackfill !== undefined) {
      if (
        body.full === true
        || typeof body.insightBackfill !== 'object'
        || body.insightBackfill === null
        || Array.isArray(body.insightBackfill)
      ) {
        return NextResponse.json(
          { error: 'finance_insight_backfill_request_invalid' },
          { status: 400 },
        );
      }
      const backfill = body.insightBackfill as Record<string, unknown>;
      const result = await syncScheduler.runExclusiveConnectorOperation(
        config.id,
        () => runFinanceInsightTransactionBackfill({
          config,
          idempotencyKey: typeof backfill.idempotencyKey === 'string'
            ? backfill.idempotencyKey
            : '',
          horizonMonths: typeof backfill.horizonMonths === 'number'
            ? backfill.horizonMonths
            : undefined,
          maxWindows: typeof backfill.maxWindows === 'number'
            ? backfill.maxWindows
            : undefined,
          signal: request.signal,
        }),
      );
      return NextResponse.json({ insightBackfill: result });
    }
    const result = await syncScheduler.runSync(config.id, {
      full: body.full === true,
      signal: request.signal,
      source: 'api',
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ConnectorOperationBusyError) {
      return ApiErrors.conflict('Connector has an active operation');
    }
    if (error instanceof FinanceInsightBackfillError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Sync failed', error);
  }
}
