import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  createHubProject,
  deleteHubProject,
  listHubProjects,
  updateHubProject,
} from '@/lib/projects/organization-service';
import { parseHubProjectUpdate } from '@/lib/projects/hub-project-update';

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

    const projects = await listHubProjects({ includeHidden, includePhases });
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
    const {
      name,
      description,
      color,
      icon,
      iconColor,
      sourceBindings,
      autoIncludeRules,
      kanbanColumns,
      defaultView,
      category,
      targetDate,
      metadata,
    } = body;

    if (!name) {
      return ApiErrors.badRequest('Project name is required');
    }

    const result = await createHubProject({
      name,
      description,
      color,
      icon,
      iconColor,
      sourceBindings,
      autoIncludeRules,
      kanbanColumns,
      defaultView,
      category,
      targetDate,
      metadata,
    });
    return NextResponse.json(result, { status: 201 });
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
    const result = await updateHubProject(projectId, parsedUpdates.updates);
    return NextResponse.json({ success: true, ...result });
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
    await deleteHubProject(projectId, 'memberships');
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete project', error);
  }
}
