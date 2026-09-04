import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { focusItems, tasks, sourceLists } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { dbLogger } from '@/lib/logger';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { ApiErrors } from '@/lib/api-error';
import { requireTaskEditPolicy, resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';
import { appendPlanningSignalInTransaction } from '@/db/task-history';

const MAX_SLOTS = 3;

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
    // Fetch today's focus items
    const todayItems = await db.select({
      id: focusItems.id,
      taskId: focusItems.taskId,
      scope: focusItems.scope,
      date: focusItems.date,
      slot: focusItems.slot,
      addedAt: focusItems.addedAt,
      isAiSuggested: focusItems.isAiSuggested,
      // Task fields
      title: tasks.title,
      status: tasks.status,
      microStatus: tasks.microStatus,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
    })
      .from(focusItems)
      .innerJoin(tasks, eq(focusItems.taskId, tasks.id))
      .where(and(eq(focusItems.scope, 'today'), eq(focusItems.date, date)))
      .orderBy(focusItems.slot);

    // Fetch this week's focus items
    const weekItems = await db.select({
      id: focusItems.id,
      taskId: focusItems.taskId,
      scope: focusItems.scope,
      date: focusItems.date,
      slot: focusItems.slot,
      addedAt: focusItems.addedAt,
      isAiSuggested: focusItems.isAiSuggested,
      // Task fields
      title: tasks.title,
      status: tasks.status,
      microStatus: tasks.microStatus,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
    })
      .from(focusItems)
      .innerJoin(tasks, eq(focusItems.taskId, tasks.id))
      .where(and(eq(focusItems.scope, 'week'), eq(focusItems.date, weekMonday)))
      .orderBy(focusItems.slot);

    // Resolve authoritative list display names
    const allItems = [...todayItems, ...weekItems];
    const editPolicies = await resolveTaskEditPolicies(allItems.map((item) => ({
      id: item.taskId,
      sourceId: item.sourceId,
      connectorType: item.connectorType,
      connectorInstanceId: item.connectorInstanceId,
    })));
    const slIds = [...new Set(allItems.map((i) => i.sourceListId).filter(Boolean))] as string[];
    const slNameMap = new Map<string, string>();
    if (slIds.length > 0) {
      const slRows = db.select({
        sourceId: sourceLists.sourceId,
        connectorInstanceId: sourceLists.connectorInstanceId,
        name: sourceLists.name,
        userDisplayName: sourceLists.userDisplayName,
      }).from(sourceLists).where(inArray(sourceLists.sourceId, slIds)).all();
      for (const sl of slRows) {
        slNameMap.set(`${sl.connectorInstanceId}:${sl.sourceId}`, resolveSourceListDisplayName(sl));
      }
    }

    function resolveItem(item: typeof todayItems[number]) {
      const resolved = item.sourceListId ? slNameMap.get(`${item.connectorInstanceId}:${item.sourceListId}`) : undefined;
      return {
        ...item,
        sourceListName: resolved || item.sourceListName,
        editPolicy: requireTaskEditPolicy(editPolicies, item.taskId),
      };
    }

    return NextResponse.json({
      date,
      weekMonday,
      today: todayItems.map(resolveItem),
      week: weekItems.map(resolveItem),
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

    // Check current count for this scope/date
    const existing = await db.select({
      id: focusItems.id,
      slot: focusItems.slot,
      taskId: focusItems.taskId,
    })
      .from(focusItems)
      .where(and(eq(focusItems.scope, scope), eq(focusItems.date, effectiveDate)))
      .orderBy(focusItems.slot);

    // Check if task already in focus for this scope
    if (existing.some(e => e.taskId === taskId)) {
      return ApiErrors.conflict('Task is already in Focus 3');
    }

    // Enforce max 3
    if (existing.length >= MAX_SLOTS) {
      return ApiErrors.conflict('Focus 3 is full. Remove an item first.');
    }

    // Find next open slot (1, 2, or 3)
    const usedSlots = new Set(existing.map(e => e.slot));
    let slot = 1;
    while (usedSlots.has(slot) && slot <= MAX_SLOTS) slot++;

    const id = `focus-${crypto.randomUUID().slice(0, 8)}`;

    const addedAt = new Date().toISOString();
    runTransaction((tx) => {
      tx.insert(focusItems).values({
        id,
        taskId,
        scope,
        date: effectiveDate,
        slot,
        addedAt,
        isAiSuggested: isAiSuggested || false,
      }).run();
      if (scope === 'today') {
        appendPlanningSignalInTransaction(tx, {
          taskId,
          eventType: 'focus_committed',
          date: effectiveDate,
          occurredAt: addedAt,
          provenance: 'focus-items-api',
          metadata: { origin: isAiSuggested ? 'accepted-ai-suggestion' : 'explicit-local' },
        });
      }
    });

    return NextResponse.json({ id, slot }, { status: 201 });
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
    if (itemId) {
      runTransaction((tx) => {
        const item = tx.select().from(focusItems).where(eq(focusItems.id, itemId)).get();
        if (!item) return;
        tx.delete(focusItems).where(eq(focusItems.id, itemId)).run();
        if (item.scope === 'today') {
          appendPlanningSignalInTransaction(tx, {
            taskId: item.taskId,
            eventType: 'focus_withdrawn',
            date: item.date,
            occurredAt: removedAt,
            provenance: 'focus-items-api',
            metadata: { origin: 'explicit-local' },
          });
        }
      });
    } else if (taskId && scope) {
      const date = searchParams.get('date') || getLocalToday();
      const effectiveDate = scope === 'week' ? getWeekMonday(date) : date;
      runTransaction((tx) => {
        const result = tx.delete(focusItems).where(
          and(eq(focusItems.taskId, taskId), eq(focusItems.scope, scope), eq(focusItems.date, effectiveDate))
        ).run();
        if (scope === 'today' && result.changes > 0) {
          appendPlanningSignalInTransaction(tx, {
            taskId,
            eventType: 'focus_withdrawn',
            date: effectiveDate,
            occurredAt: removedAt,
            provenance: 'focus-items-api',
            metadata: { origin: 'explicit-local' },
          });
        }
      });
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

    // Get the item we're moving
    const [item] = await db.select().from(focusItems).where(eq(focusItems.id, id));
    if (!item) {
      return ApiErrors.notFound('Focus item');
    }

    // Check if target slot is occupied
    const [occupant] = await db.select().from(focusItems).where(
      and(
        eq(focusItems.scope, item.scope),
        eq(focusItems.date, item.date),
        eq(focusItems.slot, slot),
      )
    );

    if (occupant && occupant.id !== id) {
      // Swap slots atomically — use a sentinel slot (0) to avoid unique constraint violation
      // on the (scope, date, slot) index during the swap
      try {
        runTransaction((tx) => {
          tx.update(focusItems).set({ slot: 0 }).where(eq(focusItems.id, occupant.id)).run();
          tx.update(focusItems).set({ slot }).where(eq(focusItems.id, id)).run();
          tx.update(focusItems).set({ slot: item.slot }).where(eq(focusItems.id, occupant.id)).run();
        });
      } catch (err) {
        dbLogger.error({ err, itemId: id, occupantId: occupant.id, fromSlot: item.slot, toSlot: slot, op: 'reorderFocusItems' },
          'Transaction rolled back: focus item slot swap failed');
        throw err;
      }
    } else {
      await db.update(focusItems).set({ slot }).where(eq(focusItems.id, id));
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update focus item', error);
  }
}
