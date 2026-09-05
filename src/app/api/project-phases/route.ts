import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  createProjectPhase,
  listProjectPhases,
} from '@/lib/projects/organization-service';

/**
 * GET /api/project-phases — List all phases (optionally filtered by project_id)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const crossProject = searchParams.get('cross_project');

    const phases = await listProjectPhases({
      projectId,
      crossProject: crossProject === 'true',
    });
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

    const phase = await createProjectPhase({
      projectId,
      name,
      description,
      color,
      estimatedDays,
      targetStart,
      targetEnd,
      startAfterPhaseId,
      sortOrder,
    });
    return NextResponse.json({ phase }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create phase', error);
  }
}
