import { NextResponse } from 'next/server';
import db from '@/db';
import { projectPhaseItems } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { ApiErrors } from '@/lib/api-error';
import { getStoredTaskMutationPolicy } from '@/lib/tasks/mutation-policy';

/**
 * GET /api/project-phases/[id]/items — List items in a phase
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const items = await db.select().from(projectPhaseItems)
      .where(eq(projectPhaseItems.phaseId, id))
      .orderBy(projectPhaseItems.sortOrder);

    return NextResponse.json({ items });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch phase items', error);
  }
}

/**
 * POST /api/project-phases/[id]/items — Add a task to a phase
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: phaseId } = await params;
    const body = await request.json();
    const { taskId, sortOrder, estimatedEffortHours, isProposed, proposalType } = body;

    if (!taskId) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    }
    const mutation = await getStoredTaskMutationPolicy(taskId, 'phases');
    if (!mutation) return ApiErrors.notFound('Task');
    if (mutation.policy.mutation === 'blocked') {
      return ApiErrors.forbidden(
        mutation.policy.reason ?? 'Phases cannot be changed for this task source',
      );
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    await db.insert(projectPhaseItems).values({
      id,
      phaseId,
      taskId,
      sortOrder: sortOrder ?? 0,
      estimatedEffortHours: estimatedEffortHours || null,
      isProposed: isProposed ?? false,
      proposalType: proposalType || null,
      createdAt: now,
    }).onConflictDoNothing();

    const [item] = await db.select().from(projectPhaseItems).where(and(
      eq(projectPhaseItems.phaseId, phaseId),
      eq(projectPhaseItems.taskId, taskId),
    ));
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to add phase item', error);
  }
}

/**
 * PATCH /api/project-phases/[id]/items — Update a phase item (by item_id query param)
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: phaseId } = await params;
    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get('item_id');

    if (!itemId) {
      return NextResponse.json({ error: 'item_id query param is required' }, { status: 400 });
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};
    const allowedFields = ['sortOrder', 'estimatedEffortHours', 'isProposed', 'proposalType'];
    for (const field of allowedFields) {
      if (field in body) {
        updates[field] = body[field];
      }
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const [existingItem] = await db.select({ taskId: projectPhaseItems.taskId })
      .from(projectPhaseItems)
      .where(and(
        eq(projectPhaseItems.id, itemId),
        eq(projectPhaseItems.phaseId, phaseId),
      ));
    if (!existingItem) return ApiErrors.notFound('Phase item');
    const mutation = await getStoredTaskMutationPolicy(existingItem.taskId, 'phases');
    if (!mutation) return ApiErrors.notFound('Task');
    if (mutation.policy.mutation === 'blocked') {
      return ApiErrors.forbidden(
        mutation.policy.reason ?? 'Phases cannot be changed for this task source',
      );
    }

    await db.update(projectPhaseItems).set(updates).where(
      and(
        eq(projectPhaseItems.id, itemId),
        eq(projectPhaseItems.phaseId, phaseId),
      )
    );

    const [item] = await db.select().from(projectPhaseItems).where(eq(projectPhaseItems.id, itemId));
    return NextResponse.json({ item });
  } catch (error) {
    return ApiErrors.internal('Failed to update phase item', error);
  }
}

/**
 * DELETE /api/project-phases/[id]/items — Remove a task from a phase (by taskId query param)
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('task_id');

    if (!taskId) {
      return NextResponse.json({ error: 'task_id query param is required' }, { status: 400 });
    }
    const mutation = await getStoredTaskMutationPolicy(taskId, 'phases');
    if (!mutation) return ApiErrors.notFound('Task');
    if (mutation.policy.mutation === 'blocked') {
      return ApiErrors.forbidden(
        mutation.policy.reason ?? 'Phases cannot be changed for this task source',
      );
    }

    await db.delete(projectPhaseItems).where(
      and(
        eq(projectPhaseItems.phaseId, id),
        eq(projectPhaseItems.taskId, taskId),
      )
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to remove phase item', error);
  }
}
