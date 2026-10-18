import { ApiErrors } from '@/lib/api-error';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalToday } from '@/lib/utils/date';

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

async function repository() {
  const { dailyPlanning } = await getWorkerPersistenceRepositories();
  if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
  return dailyPlanning.myDay;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { taskId?: unknown; date?: unknown };
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    const date = typeof body.date === 'string' ? body.date : getLocalToday();
    if (!taskId) return ApiErrors.badRequest('taskId is required');
    if (!isValidDate(date)) return ApiErrors.badRequest('date must be a valid YYYY-MM-DD date');

    await (await repository()).excludeSuggestion({
      id: `mdse-${crypto.randomUUID().slice(0, 8)}`,
      taskId,
      date,
      excludedAt: new Date().toISOString(),
    });
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to hide suggestion for today', error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId')?.trim() ?? '';
    const date = searchParams.get('date') ?? getLocalToday();
    if (!taskId) return ApiErrors.badRequest('taskId is required');
    if (!isValidDate(date)) return ApiErrors.badRequest('date must be a valid YYYY-MM-DD date');

    await (await repository()).restoreSuggestion({ taskId, date });
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to restore suggestion', error);
  }
}
