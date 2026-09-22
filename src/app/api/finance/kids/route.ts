import { NextResponse } from 'next/server';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export async function GET(request: Request) {
  try {
    const connectorId = new URL(request.url).searchParams.get('connectorId');
    const config = await getPersistedFinanceConnectorConfig(connectorId);
    const today = getLocalToday();
    const monthStart = today.slice(0, 7) + '-01';
    const kidsWithSpending = await (
      await getWorkerPersistenceRepositories()
    ).finance.web.listKidsWithSpending(config.id, monthStart);
    return NextResponse.json({ kids: kidsWithSpending });
  } catch (error) {
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to fetch kids', error);
  }
}
