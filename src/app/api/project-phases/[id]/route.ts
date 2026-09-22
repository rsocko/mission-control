import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  deleteProjectPhase,
  getProjectPhase,
  updateProjectPhase,
} from '@/lib/projects/organization-service';

/**
 * GET /api/project-phases/[id] — Get a phase with its items
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await getProjectPhase(id);
    if (!result) {
      return NextResponse.json({ error: 'Phase not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return ApiErrors.internal('Failed to fetch phase', error);
  }
}

/**
 * PATCH /api/project-phases/[id] — Update a phase
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const phase = await updateProjectPhase(id, body);
    return NextResponse.json({ phase });
  } catch (error) {
    return ApiErrors.internal('Failed to update phase', error);
  }
}

/**
 * DELETE /api/project-phases/[id] — Delete a phase and its items
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteProjectPhase(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete phase', error);
  }
}
