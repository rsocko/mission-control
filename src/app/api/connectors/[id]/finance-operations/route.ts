import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  isTrustedFinanceReadRequest,
  trustedFinanceMutationActor,
} from '@/lib/connectors/monarch-money/finance-request';
import {
  SyncOperatorError,
  enqueueFinanceOperatorCanary,
  getFinanceSyncControlStatus,
  quarantineFinanceConnectorSync,
  releaseFinanceConnectorQuarantine,
  rollbackFinanceOperatorCanary,
} from '@/lib/sync/operator-control';
import {
  FinanceCutoverOperatorError,
  enableFinanceInsightCutoverForOperator,
  getFinanceInsightCutoverReadiness,
  rollbackFinanceInsightCutoverForOperator,
} from '@/lib/finance-insights/cutover-operator';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const operatorRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('quarantine-scheduler') }).strict(),
  z.object({ action: z.literal('authorize-canary') }).strict(),
  z.object({ action: z.literal('release-scheduler') }).strict(),
  z.object({ action: z.literal('rollback-canary') }).strict(),
  z.object({
    action: z.literal('enable-insight-cutover'),
    sourceGeneration: z.string().min(1).max(160),
  }).strict(),
  z.object({
    action: z.literal('rollback-insight-cutover'),
    sourceGeneration: z.string().min(1).max(160),
  }).strict(),
]);

function errorResponse(error: unknown) {
  if (error instanceof SyncOperatorError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof FinanceCutoverOperatorError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: 'invalid_finance_operator_request' }, { status: 400 });
  }
  return NextResponse.json({ error: 'finance_operator_request_failed' }, { status: 500 });
}

export async function GET(request: NextRequest, context: RouteContext) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  const sourceGeneration = request.nextUrl.searchParams.get('sourceGeneration') ?? undefined;
  try {
    return NextResponse.json({
      sync: await getFinanceSyncControlStatus(id),
      cutover: await getFinanceInsightCutoverReadiness(id, sourceGeneration),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const actor = trustedFinanceMutationActor(request);
  if (!actor) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  try {
    const body = operatorRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success) {
      return NextResponse.json(
        { error: 'invalid_finance_operator_request' },
        { status: 400 },
      );
    }
    const idempotencyKey = request.headers.get('idempotency-key');
    switch (body.data.action) {
      case 'quarantine-scheduler':
        return NextResponse.json(await quarantineFinanceConnectorSync({
          connectorId: id,
          actorType: actor,
          idempotencyKey,
        }));
      case 'authorize-canary':
        {
          const result = await enqueueFinanceOperatorCanary({
            connectorId: id,
            actorType: actor,
            idempotencyKey,
          });
          return NextResponse.json({
            jobId: result.job.id,
            status: result.job.status,
            source: result.job.source,
            maxAttempts: result.job.maxAttempts,
            replayed: result.replayed,
          }, { status: 202 });
        }
      case 'release-scheduler':
        return NextResponse.json(await releaseFinanceConnectorQuarantine({
          connectorId: id,
          actorType: actor,
          idempotencyKey,
        }));
      case 'rollback-canary':
        return NextResponse.json(await rollbackFinanceOperatorCanary({
          connectorId: id,
          actorType: actor,
          idempotencyKey,
        }));
      case 'enable-insight-cutover':
        return NextResponse.json(await enableFinanceInsightCutoverForOperator({
          connectorId: id,
          sourceGeneration: body.data.sourceGeneration,
          actorType: actor,
          idempotencyKey,
        }));
      case 'rollback-insight-cutover':
        return NextResponse.json(await rollbackFinanceInsightCutoverForOperator({
          connectorId: id,
          sourceGeneration: body.data.sourceGeneration,
          actorType: actor,
          idempotencyKey,
        }));
    }
    return NextResponse.json(
      { error: 'invalid_finance_operator_request' },
      { status: 400 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
