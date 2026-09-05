import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  deleteHubProject,
  getHubProject,
  updateHubProject,
} from '@/lib/projects/organization-service';
import { parseHubProjectUpdate } from '@/lib/projects/hub-project-update';

/**
 * GET /api/hub-projects/[id] — Get a single hub project
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await getHubProject(id);

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ project });
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

    const result = await updateHubProject(id, parsedUpdates.updates);
    return NextResponse.json({ success: true, ...result });
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
    await deleteHubProject(id, 'owned-hierarchy');
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete project', error);
  }
}
