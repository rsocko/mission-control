import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalDayBoundsISO } from '@/lib/utils/date';

export async function GET() {
  try {
    const { todayStart, tomorrowStart } = getLocalDayBoundsISO();
    const repository = (await getWorkerPersistenceRepositories()).analytics.kpis;
    const count = await repository.countTasksCompletedIn({
      startInclusive: todayStart,
      endExclusive: tomorrowStart,
    });
    return NextResponse.json({ count });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch daily completions');
    return NextResponse.json({ count: 0 });
  }
}
