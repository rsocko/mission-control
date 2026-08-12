import { NextResponse } from 'next/server';
import db from '@/db';
import { projectPhases } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/project-phases — List all phases (optionally filtered by project_id)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const crossProject = searchParams.get('cross_project');

    let phases;
    if (crossProject === 'true') {
      phases = await db.select().from(projectPhases)
        .where(sql`${projectPhases.projectId} IS NULL`)
        .orderBy(projectPhases.sortOrder);
    } else if (projectId) {
      phases = await db.select().from(projectPhases)
        .where(eq(projectPhases.projectId, projectId))
        .orderBy(projectPhases.sortOrder);
    } else {
      phases = await db.select().from(projectPhases).orderBy(projectPhases.sortOrder);
    }

    return NextResponse.json({ phases });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch phases', error);
  }
}

/**
 * POST /api/project-phases — Create a new phase
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { projectId, name, description, color, estimatedDays, targetStart, targetEnd, sortOrder, startAfterPhaseId } = body;

    if (!name) {
      return ApiErrors.badRequest('Phase name is required');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    await db.insert(projectPhases).values({
      id,
      projectId: projectId || null,
      name,
      description: description || null,
      color: color || null,
      estimatedDays: estimatedDays || null,
      targetStart: targetStart || null,
      targetEnd: targetEnd || null,
      startAfterPhaseId: startAfterPhaseId || null,
      sortOrder: sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    });

    const [phase] = await db.select().from(projectPhases).where(eq(projectPhases.id, id));
    return NextResponse.json({ phase }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create phase', error);
  }
}
