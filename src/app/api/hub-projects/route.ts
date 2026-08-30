import { NextResponse } from 'next/server';
import db from '@/db';
import {
  hubProjects,
  projectAutoIncludeExclusions,
  taskProjects,
  projectPhases,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { normalizeProjectJsonCollections, resolveProjectIconColor } from '@/lib/projects/normalize-project';
import {
  hubProjectRulesChanged,
  parseHubProjectUpdate,
} from '@/lib/projects/hub-project-update';
import { normalizeAutoIncludeRules, reevaluateProject } from '@/lib/rules';
import { dbLogger } from '@/lib/logger';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication';

/**
 * GET /api/hub-projects — List all hub projects
 * Query params:
 *   includeHidden=true  — include hidden projects (default: false)
 *   includePhases=true  — include phases for each project (default: false)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeHidden = searchParams.get('includeHidden') === 'true';
    const includePhases = searchParams.get('includePhases') === 'true';

    const projectRows = includeHidden
      ? await db.select().from(hubProjects).orderBy(hubProjects.name)
      : await db.select().from(hubProjects).where(eq(hubProjects.hidden, false)).orderBy(hubProjects.name);
    const projects = projectRows.map(normalizeProjectJsonCollections);

    if (includePhases) {
      const allPhases = await db.select({
        id: projectPhases.id,
        projectId: projectPhases.projectId,
        name: projectPhases.name,
        sortOrder: projectPhases.sortOrder,
      }).from(projectPhases).orderBy(projectPhases.sortOrder);

      const phasesByProject = new Map<string, { id: string; name: string }[]>();
      for (const phase of allPhases) {
        if (!phase.projectId) continue;
        const list = phasesByProject.get(phase.projectId) || [];
        list.push({ id: phase.id, name: phase.name });
        phasesByProject.set(phase.projectId, list);
      }

      const projectsWithPhases = projects.map((p) => ({
        ...p,
        phases: phasesByProject.get(p.id) || [],
      }));

      return NextResponse.json({ projects: projectsWithPhases });
    }

    return NextResponse.json({ projects });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch projects', error);
  }
}

/**
 * POST /api/hub-projects — Create a hub project
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, description, color, icon, iconColor, sourceBindings, autoIncludeRules, kanbanColumns, defaultView, category, targetDate, metadata } = body;

    if (!name) {
      return ApiErrors.badRequest('Project name is required');
    }

    const id = `proj-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const now = new Date().toISOString();
    const projectColor = color || '#3b82f6';

    await db.insert(hubProjects).values({
      id,
      name,
      description: description || null,
      color: projectColor,
      icon: icon || null,
      iconColor: resolveProjectIconColor(iconColor, projectColor),
      sourceBindings: sourceBindings || [],
      autoIncludeRules: normalizeAutoIncludeRules(autoIncludeRules),
      kanbanColumns: kanbanColumns || [],
      defaultView: defaultView || 'list',
      category: category || null,
      targetDate: targetDate || null,
      metadata: metadata || {},
      createdAt: now,
      updatedAt: now,
    });

    let evaluation = null;
    let evaluationFailed = false;
    try {
      evaluation = await reevaluateProject(id);
    } catch (error) {
      evaluationFailed = true;
      dbLogger.error({ err: error, projectId: id }, 'Project created but auto-include evaluation failed');
    }
    await publishSemanticEntityUpsert('project', id);
    return NextResponse.json({ id, evaluation, evaluationFailed }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create project', error);
  }
}

/**
 * PATCH /api/hub-projects — Update a hub project
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return ApiErrors.badRequest('Invalid project update body');
    }
    const { id: rawProjectId, ...rawUpdates } = body;

    if (typeof rawProjectId !== 'string' || !rawProjectId.trim()) {
      return ApiErrors.badRequest('Project id is required');
    }
    const projectId = rawProjectId.trim();

    const parsedUpdates = parseHubProjectUpdate(rawUpdates);
    if (!parsedUpdates.success) {
      return ApiErrors.badRequest(parsedUpdates.message);
    }
    const updates = {
      ...parsedUpdates.updates,
      updatedAt: new Date().toISOString(),
    };
    await db.update(hubProjects).set(updates).where(eq(hubProjects.id, projectId));

    let evaluation = null;
    let evaluationFailed = false;
    if (hubProjectRulesChanged(parsedUpdates.updates)) {
      try {
        evaluation = await reevaluateProject(projectId);
      } catch (error) {
        evaluationFailed = true;
        dbLogger.error({ err: error, projectId }, 'Project rules saved but auto-include evaluation failed');
      }
    }
    const affectedTasks = await db.select({ taskId: taskProjects.taskId })
      .from(taskProjects)
      .where(eq(taskProjects.projectId, projectId));
    await Promise.all([
      publishSemanticEntityUpsert('project', projectId),
      ...affectedTasks.map(({ taskId }) => publishSemanticEntityUpsert('task', taskId)),
    ]);
    return NextResponse.json({ success: true, evaluation, evaluationFailed });
  } catch (error) {
    return ApiErrors.internal('Failed to update project', error);
  }
}

/**
 * DELETE /api/hub-projects — Delete a hub project
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('id');

  if (!projectId) {
    return ApiErrors.badRequest('Project id is required');
  }

  try {
    const affectedTasks = await db.select({ taskId: taskProjects.taskId })
      .from(taskProjects)
      .where(eq(taskProjects.projectId, projectId));
    await db.delete(projectAutoIncludeExclusions)
      .where(eq(projectAutoIncludeExclusions.projectId, projectId));
    await db.delete(taskProjects).where(eq(taskProjects.projectId, projectId));
    await db.delete(hubProjects).where(eq(hubProjects.id, projectId));
    await Promise.all([
      publishSemanticEntityDelete('project', projectId),
      ...affectedTasks.map(({ taskId }) => publishSemanticEntityUpsert('task', taskId)),
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete project', error);
  }
}
