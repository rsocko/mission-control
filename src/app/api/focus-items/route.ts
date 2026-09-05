import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalToday } from '@/lib/utils/date';
import { buildSourceListNameMap, resolveTaskListName } from '@/lib/utils/resolve-task-list-names';
import { ApiErrors } from '@/lib/api-error';
import { requireTaskEditPolicy, resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';

type FocusScope = 'today' | 'week';

const MAX_SLOTS = 3;
const PROVENANCE = 'focus-items-api';

async function focusRepository() {
  const { dailyPlanning } = await getWorkerPersistenceRepositories();
  if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
  return dailyPlanning.focus;
}

/**
 * Get the Monday of the week for a given YYYY-MM-DD date.
 */
function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * GET /api/focus-items — Get focus items for today and this week
 * Query params: ?date=YYYY-MM-DD (optional, defaults to today)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();
  const weekMonday = getWeekMonday(date);

  try {
    const board = await (await focusRepository()).listBoard({ date, weekMonday });
    const allItems = [...board.today, ...board.week];

    const editPolicies = await resolveTaskEditPolicies(allItems.map((item) => ({
      id: item.taskId,
      sourceId: item.sourceId,
      connectorType: item.connectorType,
      connectorInstanceId: item.connectorInstanceId,
    })));
    // Resolve authoritative list display names
    const slNameMap = await buildSourceListNameMap(allItems);

    function resolveItem(item: typeof allItems[number]) {
      return {
        ...item,
        sourceListName: resolveTaskListName(item, slNameMap),
        editPolicy: requireTaskEditPolicy(editPolicies, item.taskId),
      };
    }

    return NextResponse.json({
      date,
      weekMonday,
      today: board.today.map(resolveItem),
      week: board.week.map(resolveItem),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch focus items', error);
  }
}

/**
 * POST /api/focus-items — Add a task to Focus 3
 * Body: { taskId, scope: 'today'|'week', date?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, scope, isAiSuggested } = body;
    const date = body.date || getLocalToday();

    if (!taskId || !scope) {
      return ApiErrors.badRequest('taskId and scope are required');
    }
    if (scope !== 'today' && scope !== 'week') {
      return ApiErrors.badRequest('scope must be "today" or "week"');
    }

    const effectiveDate = scope === 'week' ? getWeekMonday(date) : date;

    // Capacity, duplicate detection, slot allocation, the insert and the
    // commitment signal are one serialized unit inside persistence.
    const result = await (await focusRepository()).add({
      id: `focus-${crypto.randomUUID().slice(0, 8)}`,
      taskId,
      scope,
      date: effectiveDate,
      addedAt: new Date().toISOString(),
      isAiSuggested: isAiSuggested || false,
      maxSlots: MAX_SLOTS,
      signal: {
        provenance: PROVENANCE,
        metadata: { origin: isAiSuggested ? 'accepted-ai-suggestion' : 'explicit-local' },
      },
    });

    if (result.outcome === 'duplicate') {
      return ApiErrors.conflict('Task is already in Focus 3');
    }
    if (result.outcome === 'full') {
      return ApiErrors.conflict('Focus 3 is full. Remove an item first.');
    }

    return NextResponse.json({ id: result.id, slot: result.slot }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to add focus item', error);
  }
}

/**
 * DELETE /api/focus-items — Remove a task from Focus 3
 * Query params: ?id=focus-xxx  OR  ?taskId=xxx&scope=today|week
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get('id');
  const taskId = searchParams.get('taskId');
  const scope = searchParams.get('scope');

  try {
    const removedAt = new Date().toISOString();
    const signal = { provenance: PROVENANCE, metadata: { origin: 'explicit-local' } };
    const repository = await focusRepository();

    if (itemId) {
      await repository.removeById({ id: itemId, removedAt, signal });
    } else if (taskId && scope) {
      // An unknown scope matches no row, exactly as the previous delete did.
      if (scope === 'today' || scope === 'week') {
        const date = searchParams.get('date') || getLocalToday();
        await repository.removeByTask({
          taskId,
          scope: scope satisfies FocusScope,
          date: scope === 'week' ? getWeekMonday(date) : date,
          removedAt,
          signal,
        });
      }
    } else {
      return ApiErrors.badRequest('id or (taskId + scope) is required');
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to remove focus item', error);
  }
}

/**
 * PATCH /api/focus-items — Reorder a focus item's slot
 * Body: { id, slot }
 */
export async function PATCH(request: Request) {
  try {
    const { id, slot } = await request.json();

    if (!id || !slot || slot < 1 || slot > MAX_SLOTS) {
      return ApiErrors.badRequest('id and slot (1-3) are required');
    }

    const result = await (await focusRepository()).moveToSlot({ id, slot });
    if (result.outcome === 'not-found') {
      return ApiErrors.notFound('Focus item');
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update focus item', error);
  }
}
