import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  applyProjectHierarchyCommand,
  getProjectHierarchySnapshot,
  ProjectHierarchyServiceError,
} from '@/lib/projects/hierarchy-service';
import { projectHierarchyCommandRequestSchema } from '@/lib/projects/hierarchy-types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: projectId } = await params;
    const hierarchy = getProjectHierarchySnapshot(projectId);
    if (!hierarchy) return ApiErrors.notFound('Project');
    return NextResponse.json({ hierarchy });
  } catch (error) {
    return ApiErrors.internal('Failed to load project hierarchy', error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: projectId } = await params;
    const parsed = projectHierarchyCommandRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid hierarchy command');
    }

    const result = await applyProjectHierarchyCommand({
      projectId,
      request: parsed.data,
      actor: { type: 'user' },
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProjectHierarchyServiceError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        current: error.current,
      }, { status: error.status });
    }
    return ApiErrors.internal('Failed to update project hierarchy', error);
  }
}
