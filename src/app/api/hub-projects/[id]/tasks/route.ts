import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runTransaction } from '@/db';
import {
  hubProjects,
  projectAutoIncludeExclusions,
  projectHierarchyMutationContext,
  projectPhaseItems,
  projectPhases,
  taskProjects,
} from '@/db/schema';
import { randomUUID } from 'crypto';
import { getStoredTaskMutationPolicy } from '@/lib/tasks/mutation-policy';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { taskId, phaseId } = body;
    const hasPhaseSelection = Object.prototype.hasOwnProperty.call(body, 'phaseId');

    if (!taskId) {
      return NextResponse.json({ error: 'Task id is required' }, { status: 400 });
    }

    if (hasPhaseSelection && phaseId !== null && typeof phaseId !== 'string') {
      return NextResponse.json({ error: 'phaseId must be a string or null' }, { status: 400 });
    }
    const requestedFields = hasPhaseSelection ? ['projects', 'phases'] as const : ['projects'] as const;
    const mutations = await Promise.all(
      requestedFields.map((field) => getStoredTaskMutationPolicy(taskId, field)),
    );
    if (mutations.some((entry) => entry === null)) return ApiErrors.notFound('Task');
    const blocked = mutations.find((entry) => entry?.policy.mutation === 'blocked');
    if (blocked) {
      return ApiErrors.forbidden(
        blocked.policy.reason ?? 'Project placement cannot be changed for this task source',
      );
    }

    const result = runTransaction((tx) => {
      const projectPhaseIds = tx.select({ id: projectPhases.id })
        .from(projectPhases)
        .where(eq(projectPhases.projectId, id))
        .all()
        .map((phase) => phase.id);

      if (phaseId && !projectPhaseIds.includes(phaseId)) {
        return 'invalid_phase' as const;
      }

      const existingMembership = tx.select()
        .from(taskProjects)
        .where(and(eq(taskProjects.taskId, taskId), eq(taskProjects.projectId, id)))
        .get();
      const existingExclusion = tx.select()
        .from(projectAutoIncludeExclusions)
        .where(and(
          eq(projectAutoIncludeExclusions.taskId, taskId),
          eq(projectAutoIncludeExclusions.projectId, id),
        ))
        .get();
      const existingPhaseItem = hasPhaseSelection && projectPhaseIds.length > 0
        ? tx.select().from(projectPhaseItems)
            .where(and(
              eq(projectPhaseItems.taskId, taskId),
              inArray(projectPhaseItems.phaseId, projectPhaseIds),
            ))
            .get()
        : undefined;
      const membershipChanged = !existingMembership;
      const placementChanged = hasPhaseSelection && (
        phaseId ? existingPhaseItem?.phaseId !== phaseId : Boolean(existingPhaseItem)
      );

      if (!membershipChanged && !placementChanged && !existingExclusion) {
        return 'unchanged' as const;
      }

      tx.insert(projectHierarchyMutationContext).values({ projectId: id }).run();

      if (existingExclusion) {
        tx.delete(projectAutoIncludeExclusions)
          .where(and(
            eq(projectAutoIncludeExclusions.taskId, taskId),
            eq(projectAutoIncludeExclusions.projectId, id),
          ))
          .run();
      }
      if (membershipChanged) {
        tx.insert(taskProjects).values({ taskId, projectId: id }).run();
      }

      if (placementChanged && phaseId) {
        if (existingPhaseItem) {
          tx.update(projectPhaseItems)
            .set({ phaseId })
            .where(eq(projectPhaseItems.id, existingPhaseItem.id))
            .run();
        } else {
          tx.insert(projectPhaseItems).values({
            id: randomUUID(),
            phaseId,
            taskId,
            sortOrder: 0,
            createdAt: new Date().toISOString(),
          }).run();
        }
      } else if (placementChanged && existingPhaseItem) {
        tx.delete(projectPhaseItems)
          .where(eq(projectPhaseItems.id, existingPhaseItem.id))
          .run();
      }

      tx.update(hubProjects)
        .set({
          hierarchyRevision: sql`${hubProjects.hierarchyRevision} + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(hubProjects.id, id))
        .run();
      tx.delete(projectHierarchyMutationContext)
        .where(eq(projectHierarchyMutationContext.projectId, id))
        .run();

      return 'changed' as const;
    });

    if (result === 'invalid_phase') {
      return NextResponse.json({ error: 'Phase does not belong to this project' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to assign task', error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { taskId } = await request.json();

    if (!taskId) {
      return NextResponse.json({ error: 'Task id is required' }, { status: 400 });
    }
    const mutation = await getStoredTaskMutationPolicy(taskId, 'projects');
    if (!mutation) return ApiErrors.notFound('Task');
    if (mutation.policy.mutation === 'blocked') {
      return ApiErrors.forbidden(
        mutation.policy.reason ?? 'Projects cannot be changed for this task source',
      );
    }

    runTransaction((tx) => {
      const deletion = tx.delete(taskProjects)
        .where(and(eq(taskProjects.taskId, taskId), eq(taskProjects.projectId, id)))
        .run();
      if (deletion.changes === 0) return;

      tx.insert(projectAutoIncludeExclusions).values({
        taskId,
        projectId: id,
        excludedAt: new Date().toISOString(),
      }).onConflictDoUpdate({
        target: [
          projectAutoIncludeExclusions.projectId,
          projectAutoIncludeExclusions.taskId,
        ],
        set: { excludedAt: new Date().toISOString() },
      }).run();

      const phaseIds = tx.select({ id: projectPhases.id })
        .from(projectPhases)
        .where(eq(projectPhases.projectId, id))
        .all()
        .map((phase) => phase.id);
      if (phaseIds.length > 0) {
        tx.delete(projectPhaseItems)
          .where(and(
            eq(projectPhaseItems.taskId, taskId),
            inArray(projectPhaseItems.phaseId, phaseIds),
          ))
          .run();
      }
      tx.update(hubProjects)
        .set({
          hierarchyRevision: sql`${hubProjects.hierarchyRevision} + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(hubProjects.id, id))
        .run();
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to unassign task', error);
  }
}
