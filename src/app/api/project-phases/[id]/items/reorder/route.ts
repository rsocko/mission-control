import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { projectPhaseItems } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { getStoredTaskMutationPolicy } from '@/lib/tasks/mutation-policy';

/**
 * PUT /api/project-phases/[id]/items/reorder — Bulk-update item sortOrder within a phase.
 * Body: { orderedTaskIds: string[] }
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: phaseId } = await params;
    const body = await request.json();
    const orderedTaskIds: string[] = body.orderedTaskIds;

    if (!Array.isArray(orderedTaskIds) || orderedTaskIds.length === 0) {
      return NextResponse.json({ error: 'orderedTaskIds must be a non-empty array' }, { status: 400 });
    }
    const mutations = await Promise.all(
      orderedTaskIds.map((taskId) => getStoredTaskMutationPolicy(taskId, 'phases')),
    );
    if (mutations.some((entry) => entry === null)) return ApiErrors.notFound('Task');
    const blocked = mutations.find((entry) => entry?.policy.mutation === 'blocked');
    if (blocked) {
      return ApiErrors.forbidden(
        blocked.policy.reason ?? 'Phase placement cannot be changed for this task source',
      );
    }

    runTransaction((tx) => {
      for (let i = 0; i < orderedTaskIds.length; i++) {
        tx.update(projectPhaseItems)
          .set({ sortOrder: i })
          .where(
            and(
              eq(projectPhaseItems.phaseId, phaseId),
              eq(projectPhaseItems.taskId, orderedTaskIds[i]),
            ),
          )
          .run();
      }
    });

    // Return updated items
    const items = await db.select().from(projectPhaseItems)
      .where(eq(projectPhaseItems.phaseId, phaseId))
      .orderBy(projectPhaseItems.sortOrder);

    return NextResponse.json({ items });
  } catch (error) {
    return ApiErrors.internal('Failed to reorder phase items', error);
  }
}
