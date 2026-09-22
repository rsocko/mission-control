import { NextResponse } from 'next/server';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate') || getDefaultStartDate();
  const endDate = searchParams.get('endDate') || getLocalToday();
  const connectorId = searchParams.get('connectorId');
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate) || startDate > endDate) {
    return NextResponse.json({ error: 'A valid ascending YYYY-MM-DD range is required' }, { status: 400 });
  }

  try {
    const config = await getPersistedFinanceConnectorConfig(connectorId);
    const summary = await (
      await getWorkerPersistenceRepositories()
    ).finance.web.readSummary({ connectorId: config.id, startDate, endDate });

    return NextResponse.json({
      period: { startDate, endDate },
      ...summary,
    });
  } catch (error) {
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return ApiErrors.internal('Failed to generate summary', error);
  }
}

function getDefaultStartDate(): string {
  const today = getLocalToday();
  // Return first day of current month
  return today.slice(0, 8) + '01';
}
