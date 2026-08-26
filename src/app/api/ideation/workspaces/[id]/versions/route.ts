import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { ideationWorkspaceService } from '@/lib/graph-workspace/service';
import { workspaceRouteError } from '../../route-errors';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!await ideationWorkspaceService.get(id)) return ApiErrors.notFound('Ideation workspace');
    const limit = new URL(request.url).searchParams.get('limit') ?? undefined;
    const versions = (await ideationWorkspaceService.listVersions(id, limit)).map((version) => ({
      id: version.id,
      workspaceId: version.workspaceId,
      revision: version.revision,
      name: version.name,
      reason: version.reason,
      createdAt: version.createdAt,
    }));
    return NextResponse.json({ versions });
  } catch (error) {
    return workspaceRouteError('Failed to list Ideation workspace versions', error);
  }
}
