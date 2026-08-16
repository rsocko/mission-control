import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import {
  hubProjects,
  projectAutoIncludeExclusions,
  projectMilestones,
  projectPhaseItems,
  projectPhases,
  projectTags,
  taskProjects,
} from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { dbLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import {
  hubProjectRulesChanged,
  parseHubProjectUpdate,
} from '@/lib/projects/hub-project-update';
import { normalizeProjectJsonCollections } from '@/lib/projects/normalize-project';
import { reevaluateProject } from '@/lib/rules';

/**
 * GET /api/hub-projects/[id] — Get a single hub project
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [project] = await db.select().from(hubProjects).where(eq(hubProjects.id, id));

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ project: normalizeProjectJsonCollections(project) });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch project', error);
  }
}

/**
 * PATCH /api/hub-projects/[id] — Update a hub project
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsedUpdates = parseHubProjectUpdate(body);
    if (!parsedUpdates.success) {
      return ApiErrors.badRequest(parsedUpdates.message);
    }

    const updates = {
      ...parsedUpdates.updates,
      updatedAt: new Date().toISOString(),
    };
    await db.update(hubProjects).set(updates).where(eq(hubProjects.id, id));

    let evaluation = null;
    let evaluationFailed = false;
    if (hubProjectRulesChanged(parsedUpdates.updates)) {
      try {
        evaluation = await reevaluateProject(id);
      } catch (error) {
        evaluationFailed = true;
        dbLogger.error({ err: error, projectId: id }, 'Project rules saved but auto-include evaluation failed');
      }
    }
    return NextResponse.json({ success: true, evaluation, evaluationFailed });
  } catch (error) {
    return ApiErrors.internal('Failed to update project', error);
  }
}

/**
 * DELETE /api/hub-projects/[id] — Delete a hub project
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    try {
      runTransaction((tx) => {
        const phases = tx.select({ id: projectPhases.id }).from(projectPhases).where(eq(projectPhases.projectId, id)).all();
        if (phases.length > 0) {
          const phaseIds = phases.map((p) => p.id);
          tx.delete(projectPhaseItems).where(inArray(projectPhaseItems.phaseId, phaseIds)).run();
        }
        tx.delete(projectPhases).where(eq(projectPhases.projectId, id)).run();
        tx.delete(projectAutoIncludeExclusions)
          .where(eq(projectAutoIncludeExclusions.projectId, id))
          .run();
        tx.delete(taskProjects).where(eq(taskProjects.projectId, id)).run();
        tx.delete(projectTags).where(eq(projectTags.projectId, id)).run();
        tx.delete(projectMilestones).where(eq(projectMilestones.projectId, id)).run();
        tx.delete(hubProjects).where(eq(hubProjects.id, id)).run();
      });
    } catch (err) {
      dbLogger.error({ err, projectId: id, op: 'deleteHubProject' },
        'Transaction rolled back: hub project cascade-delete failed');
      throw err;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete project', error);
  }
}
