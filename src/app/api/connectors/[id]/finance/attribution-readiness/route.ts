import { NextRequest, NextResponse } from 'next/server';
import {
  isTrustedFinanceReadRequest,
  trustedFinanceMutationActor,
} from '@/lib/connectors/monarch-money/finance-request';
import {
  FinanceAttributionReadinessError,
  getFinanceAttributionPolicyReadiness,
  previewFinanceAttributionPolicy,
} from '@/lib/connectors/monarch-money/attribution-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  if (error instanceof FinanceAttributionReadinessError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json(
    { error: 'finance_attribution_readiness_unavailable' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  try {
    return NextResponse.json(await getFinanceAttributionPolicyReadiness(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  try {
    return NextResponse.json(await previewFinanceAttributionPolicy(id));
  } catch (error) {
    return errorResponse(error);
  }
}
