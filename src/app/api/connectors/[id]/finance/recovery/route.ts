import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { isFinanceConnectorType } from '@/lib/connectors/monarch-money/config';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { verifyFinanceConnectionRecovery } from '@/lib/connectors/monarch-money/connection-recovery';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const rawBody = await request.text();
  let body: unknown = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }
  if (
    body === null
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).length > 0
  ) {
    return NextResponse.json(
      { error: 'Recovery verification does not accept request fields' },
      { status: 400 },
    );
  }

  const { id } = await params;
  const connector = await getCorePersistenceRepositories().connectors.get(id);
  if (!connector || !isFinanceConnectorType(connector.type)) {
    return ApiErrors.notFound('Finance connector');
  }
  if (!connector.enabled) {
    return NextResponse.json({ error: 'Finance connector is disabled' }, { status: 409 });
  }

  try {
    const result = await verifyFinanceConnectionRecovery({
      config: connector,
      signal: request.signal,
    });
    return NextResponse.json(result, { status: result.recovered ? 200 : 409 });
  } catch (error) {
    return ApiErrors.internal('Recovery verification failed', error);
  }
}
