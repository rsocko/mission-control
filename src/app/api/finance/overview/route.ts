import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import { getFinanceOperationsOverview } from '@/lib/finance/operations';

export async function GET(request: Request) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const connectorId = new URL(request.url).searchParams.get('connectorId');
    const overview = await getFinanceOperationsOverview(connectorId);
    if (!overview) {
      return NextResponse.json(
        { error: 'Finance connector is not configured', code: 'connector_not_configured' },
        { status: 404 },
      );
    }
    return NextResponse.json(overview);
  } catch (error) {
    if (error instanceof Error && error.message === 'Finance connector was not found') {
      return NextResponse.json(
        { error: error.message, code: 'connector_not_found' },
        { status: 404 },
      );
    }
    if (error instanceof Error && error.message === 'Finance external URL is not approved') {
      return NextResponse.json(
        { error: 'Finance links are not configured safely', code: 'unsafe_external_link' },
        { status: 503 },
      );
    }
    return ApiErrors.internal('Failed to load finance operations overview', error);
  }
}
