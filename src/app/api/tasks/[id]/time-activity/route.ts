import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { TaskTimeActivityMutationOutcome } from '@/lib/tasks/core/contracts';
const taskIdSchema = z.string().min(1).max(200);
const startSchema = z.object({
  action: z.literal('start'), commandId: z.string().uuid(),
  mode: z.enum(['focus', 'deadline']),
  targetSeconds: z.number().int().min(1).max(31_536_000),
  deadline: z.string().max(64).optional(),
});
const transitionSchema = z.object({
  action: z.enum(['pause', 'resume', 'complete', 'cancel']),
  activityId: z.string().uuid(), commandId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
});
const commandSchema = z.discriminatedUnion('action', [startSchema, transitionSchema]);
function mutationResponse(outcome: TaskTimeActivityMutationOutcome, serverNow: string) {
  if (outcome.kind === 'committed' || outcome.kind === 'replayed') {
    return NextResponse.json({ activity: outcome.activity, serverNow,
      replayed: outcome.kind === 'replayed' });
  }
  if (outcome.kind !== 'conflict') {
    return ApiErrors.notFound(outcome.kind === 'task-not-found' ? 'Task' : 'Time activity');
  }
  if (outcome.reason === 'active-timer') {
    return NextResponse.json({ error: 'Another task already has an active timer',
      code: 'ACTIVE_TIMER_CONFLICT', activeTaskId: outcome.activeTaskId }, { status: 409 });
  }
  return apiError(
    outcome.reason === 'version'
      ? 'Timer changed before this action could be applied'
      : 'Timer action conflicts with its current state',
    outcome.reason === 'version' ? 'TIMER_VERSION_CONFLICT' : 'TIMER_STATE_CONFLICT',
    409,
  );
}
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsedId = taskIdSchema.safeParse((await params).id);
  if (!parsedId.success) return ApiErrors.badRequest('Invalid task ID');
  try {
    const serverNow = new Date().toISOString();
    const repository = (await getTaskCorePersistence()).timeActivities;
    const snapshot = await repository.getTaskActivity(parsedId.data, serverNow);
    if (!snapshot.taskExists) return ApiErrors.notFound('Task');
    return NextResponse.json({ activity: snapshot.activity, serverNow,
      hasDurableTimeActivity: await repository.hasDurableTimeActivity(parsedId.data) });
  } catch (error) {
    return ApiErrors.internal('Failed to load task time activity', error);
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsedId = taskIdSchema.safeParse((await params).id);
  if (!parsedId.success) return ApiErrors.badRequest('Invalid task ID');
  const body: unknown = await request.json().catch(() => undefined);
  if (body === undefined) return ApiErrors.badRequest('Request body must be valid JSON');
  const parsed = commandSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.badRequest('Invalid timer action');
  try {
    const serverNow = new Date().toISOString();
    const repository = (await getTaskCorePersistence()).timeActivities;
    const targetSeconds = parsed.data.action === 'start' && parsed.data.mode === 'deadline'
      ? Math.ceil((Date.parse(parsed.data.deadline ?? '') - Date.parse(serverNow)) / 1000)
      : parsed.data.action === 'start' ? parsed.data.targetSeconds : 0;
    if (parsed.data.action === 'start'
      && (!Number.isSafeInteger(targetSeconds) || targetSeconds < 1 || targetSeconds > 31_536_000)
    ) return ApiErrors.badRequest('Deadline must be between now and one year from now');
    const outcome = parsed.data.action === 'start'
      ? await repository.start({
          taskId: parsedId.data, commandId: parsed.data.commandId,
          mode: parsed.data.mode,
          targetSeconds,
          serverNow,
        })
      : await repository.transition({
          taskId: parsedId.data, activityId: parsed.data.activityId,
          commandId: parsed.data.commandId, action: parsed.data.action,
          expectedVersion: parsed.data.expectedVersion,
          serverNow,
        });
    return mutationResponse(outcome, serverNow);
  } catch (error) {
    return ApiErrors.internal('Failed to update task time activity', error);
  }
}
