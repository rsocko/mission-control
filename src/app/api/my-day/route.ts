import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { connectorRegistry } from '@/lib/connectors/registry-runtime';
import type { MicrosoftTodoConnector } from '@/lib/connectors/microsoft-todo';
import { getLocalDateBoundsISO, getLocalToday } from '@/lib/utils/date';
import logger from '@/lib/logger';
import { buildSourceListNameMap, resolveTaskListName } from '@/lib/utils/resolve-task-list-names';
import { ApiErrors } from '@/lib/api-error';
import { isPublicDemoMode } from '@/lib/public-demo';
import { requireTaskEditPolicy, resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';
import { NEXT_7_DAYS } from '@/lib/tasks/due-window';
import {
  finalizePlanningSignalsIfDue,
  planningFrictionEventTypes,
} from '@/lib/planning-signals';

const SUGGESTION_LIMIT = 200;
const CARRIED_FORWARD_MINIMUM = 3;
const FRICTION_WINDOW_DAYS = 90;
const PROVENANCE = 'my-day-api';

async function myDayRepository() {
  const { dailyPlanning } = await getWorkerPersistenceRepositories();
  if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
  return dailyPlanning.myDay;
}

type MyDayRepository = Awaited<ReturnType<typeof myDayRepository>>;
type DayView = Awaited<ReturnType<MyDayRepository['dayView']>>;
type SuggestionRecord = DayView['suggestions']['overdue'][number];

function isValidDateParameter(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

/**
 * Compute yesterday's date string from a given YYYY-MM-DD date.
 */
function getYesterday(date: string): string {
  return addDays(date, -1);
}

/**
 * Compute a date N days from now.
 */
function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * GET /api/my-day — Get today's items with full task details + tags
 * Also returns grouped suggestions (yesterday, overdue, dueToday, dueThisWeek,
 * highPriority, aiRecommended, recentlyAdded, carriedForward)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();
  if (!isValidDateParameter(date)) {
    return ApiErrors.badRequest('date must be a valid YYYY-MM-DD date');
  }

  try {
    try {
      await finalizePlanningSignalsIfDue();
    } catch (error) {
      logger.warn({ err: error }, 'Planning signal finalization will retry later');
    }

    const repository = await myDayRepository();
    const { dayStart, nextDayStart } = getLocalDateBoundsISO(date);
    // Auto-inclusion is best-effort maintenance: a reader must not fail because
    // background sync or maintenance currently owns the writer lock.
    const autoInclude = await repository.includeCompletedTasks({
      date,
      dayStart,
      nextDayStart,
    });
    if (autoInclude.outcome === 'skipped-write-contention') {
      logger.warn(
        { date },
        'Skipped My Day completed-task auto-include because SQLite is write-contended',
      );
    }

    const { items, suggestions } = await repository.dayView({
      date,
      yesterday: getYesterday(date),
      dueThrough: addDays(date, NEXT_7_DAYS),
      activitySince: addDays(date, -2),
      frictionSince: getLocalDateBoundsISO(addDays(date, -FRICTION_WINDOW_DAYS)).dayStart,
      frictionEventTypes: planningFrictionEventTypes(),
      carriedForwardMinimum: CARRIED_FORWARD_MINIMUM,
      suggestionLimit: SUGGESTION_LIMIT,
    });

    // Resolve authoritative list display names (userDisplayName takes priority)
    const suggestionGroups = {
      planningSignals: suggestions.planningSignals,
      planningNext: suggestions.planningNext,
      yesterday: suggestions.yesterday,
      overdue: suggestions.overdue,
      dueToday: suggestions.dueToday,
      dueThisWeek: suggestions.dueThisWeek,
      highPriority: suggestions.highPriority,
      aiRecommended: [...suggestions.aiRecommended].sort((a, b) => {
        const pOrder: Record<string, number> = {
          critical: 0, high: 1, medium: 2, low: 3, none: 4,
        };
        return (pOrder[a.priority] ?? 4) - (pOrder[b.priority] ?? 4);
      }),
      recentlyAdded: suggestions.recentlyAdded,
      carriedForward: suggestions.carriedForward,
      repeatedlyRescheduled: suggestions.repeatedlyRescheduled,
    };
    const allSuggestions = Object.values(suggestionGroups).flat();
    const slNameMap = await buildSourceListNameMap([...items, ...allSuggestions]);

    const itemsWithTags = items.map(({ projectPhases, ...item }) => ({
      ...item,
      hasDescription: Boolean(item.hasDescription),
      sourceListName: resolveTaskListName(item, slNameMap),
      projectPhaseMemberships: item.hubProjectIds.flatMap((
        projectId,
      ): Array<{ projectId: string; phaseId: string | null; phaseName: string | null }> => {
        const memberships = projectPhases.filter(
          (membership) => membership.projectId === projectId,
        );
        return memberships.length
          ? memberships.map(({ phaseId, phaseName }) => ({ projectId, phaseId, phaseName }))
          : [{ projectId, phaseId: null, phaseName: null }];
      }),
    }));

    // Helper to pick suggestion fields (already excludes anything in My Day)
    function pickSuggestionFields(task: SuggestionRecord) {
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        microStatus: task.microStatus,
        priority: task.priority,
        planningHorizon: task.planningHorizon,
        dueDate: task.dueDate,
        pushCount: task.pushCount,
        connectorType: task.connectorType,
        connectorInstanceId: task.connectorInstanceId,
        sourceId: task.sourceId,
        sourceListName: resolveTaskListName(task, slNameMap),
        metadata: task.metadata,
        localDisposition: task.localDisposition,
      };
    }

    const shapedGroups = {
      planningSignals: suggestionGroups.planningSignals
        .map((task) => ({
          ...pickSuggestionFields(task),
          planningSignalCount: task.planningSignalCount,
        }))
        .sort((left, right) => right.planningSignalCount - left.planningSignalCount),
      planningNext: suggestionGroups.planningNext.map(pickSuggestionFields),
      yesterday: suggestionGroups.yesterday.map((task) => {
        const fields = pickSuggestionFields(task);
        // Yesterday's carry-over group has never exposed localDisposition.
        delete (fields as Partial<typeof fields>).localDisposition;
        return fields;
      }),
      overdue: suggestionGroups.overdue.map(pickSuggestionFields),
      dueToday: suggestionGroups.dueToday.map(pickSuggestionFields),
      dueThisWeek: suggestionGroups.dueThisWeek.map(pickSuggestionFields),
      highPriority: suggestionGroups.highPriority.map(pickSuggestionFields),
      aiRecommended: suggestionGroups.aiRecommended.map(pickSuggestionFields),
      recentlyAdded: suggestionGroups.recentlyAdded.map(pickSuggestionFields),
      carriedForward: suggestionGroups.carriedForward.map(pickSuggestionFields),
      repeatedlyRescheduled: suggestionGroups.repeatedlyRescheduled.map(pickSuggestionFields),
    };

    const policyTasks = [
      ...itemsWithTags.map((item) => ({
        id: item.taskId,
        sourceId: item.sourceId,
        connectorType: item.connectorType,
        connectorInstanceId: item.connectorInstanceId,
      })),
      ...Object.values(shapedGroups).flat(),
    ];
    const editPolicies = await resolveTaskEditPolicies(policyTasks);

    return NextResponse.json({
      date,
      items: itemsWithTags.map((item) => {
        const editPolicy = requireTaskEditPolicy(editPolicies, item.taskId);
        return {
          ...item,
          taskSourceModel: editPolicy.sourceModel,
          editPolicy,
        };
      }),
      suggestions: Object.fromEntries(
        Object.entries(shapedGroups).map(([group, suggestionTasks]) => [
          group,
          suggestionTasks.map((task) => {
            const editPolicy = requireTaskEditPolicy(editPolicies, task.id);
            return {
              ...task,
              taskSourceModel: editPolicy.sourceModel,
              editPolicy,
            };
          }),
        ]),
      ),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch My Day', error);
  }
}

/**
 * PATCH /api/my-day — Persist the complete manual order for a day.
 * Body: { date?: string, orderedItemIds: string[] }
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const date = typeof body.date === 'string' ? body.date : getLocalToday();
    const orderedItemIds = body.orderedItemIds;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return ApiErrors.badRequest('date must use YYYY-MM-DD format');
    }
    if (
      !Array.isArray(orderedItemIds)
      || orderedItemIds.length === 0
      || orderedItemIds.some((id) => typeof id !== 'string' || !id)
      || new Set(orderedItemIds).size !== orderedItemIds.length
    ) {
      return ApiErrors.badRequest('orderedItemIds must be a non-empty array of unique item IDs');
    }

    const result = await (await myDayRepository()).replaceOrder({ date, orderedItemIds });
    if (result.outcome === 'stale') {
      return ApiErrors.conflict('My Day changed while its order was being saved. Refresh and try again.');
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to save My Day order', error);
  }
}

/**
 * POST /api/my-day — Add a task to My Day
 * Writes back isInMyDay=true to Microsoft Todo if applicable.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, date } = body;
    const targetDate = date || getLocalToday();

    if (!taskId) {
      return ApiErrors.badRequest('taskId is required');
    }

    // Duplicate detection, order allocation and the commitment signal are one
    // serialized unit inside persistence.
    const result = await (await myDayRepository()).add({
      id: `md-${crypto.randomUUID().slice(0, 8)}`,
      taskId,
      date: targetDate,
      addedAt: new Date().toISOString(),
      signal: { provenance: PROVENANCE, metadata: { origin: 'explicit-local' } },
    });

    if (result.outcome === 'exists') {
      return NextResponse.json({ id: result.id, alreadyExists: true }, { status: 200 });
    }

    // Write-back: set isInMyDay on Microsoft Todo
    const writeBack = isPublicDemoMode()
      ? { attempted: false, success: true }
      : await writeBackMyDayStatus(taskId, true);

    return NextResponse.json({ id: result.id, order: result.order, writeBack }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to add to My Day', error);
  }
}

/**
 * DELETE /api/my-day — Remove a task from My Day
 * Writes back isInMyDay=false to Microsoft Todo if applicable.
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get('id');
  const taskId = searchParams.get('taskId');
  const requestedDate = searchParams.get('date');

  if (!itemId && !taskId) {
    return ApiErrors.badRequest('id or taskId is required');
  }
  if (requestedDate && !isValidDateParameter(requestedDate)) {
    return ApiErrors.badRequest('date must be a valid YYYY-MM-DD date');
  }

  try {
    const removedAt = new Date().toISOString();
    const { taskId: resolvedTaskId } = await (await myDayRepository()).remove({
      itemId,
      taskId,
      date: requestedDate || getLocalToday(),
      removedAt,
      exclusionId: `mde-${crypto.randomUUID().slice(0, 8)}`,
      signal: { provenance: PROVENANCE, metadata: { origin: 'explicit-local' } },
    });

    // Write-back: remove isInMyDay on Microsoft Todo
    let writeBack = { attempted: false, success: true } as { attempted: boolean; success: boolean; error?: string };
    if (resolvedTaskId && !isPublicDemoMode()) {
      writeBack = await writeBackMyDayStatus(resolvedTaskId, false);
    }

    return NextResponse.json({ success: true, writeBack });
  } catch (error) {
    return ApiErrors.internal('Failed to remove from My Day', error);
  }
}

// ─── Write-back Helper ──────────────────────────────────────────────────────

/**
 * If the task belongs to a Microsoft Todo connector, write back isInMyDay status.
 * Uses the undocumented but functional isInMyDay write property on the beta endpoint.
 * Non-blocking: returns { attempted, success, error } so callers can surface warnings.
 */
async function writeBackMyDayStatus(taskId: string, isInMyDay: boolean): Promise<{ attempted: boolean; success: boolean; error?: string }> {
  try {
    const task = await (await myDayRepository()).getRemoteIdentity(taskId);

    if (!task || task.connectorType !== 'microsoft-todo') return { attempted: false, success: true };

    const connector = connectorRegistry.getConnector(task.connectorInstanceId) as MicrosoftTodoConnector | undefined;
    if (!connector || !('setMyDay' in connector)) return { attempted: false, success: true };

    await connector.setMyDay(task.sourceId, isInMyDay);
    return { attempted: true, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, taskId }, 'My Day write-back failed');
    return { attempted: true, success: false, error: message };
  }
}
