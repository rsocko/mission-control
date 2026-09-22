import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { ideationWorkspaceService } from '@/lib/graph-workspace/service';
import {
  rejectUntrustedWorkspaceMutation,
  workspaceRouteError,
} from '../../route-errors';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const untrusted = rejectUntrustedWorkspaceMutation(request);
  if (untrusted) return untrusted;
  try {
    const body = await request.json();
    const workspace = await ideationWorkspaceService.duplicate((await params).id, body.name);
    return workspace
      ? NextResponse.json({ workspace }, { status: 201 })
      : ApiErrors.notFound('Ideation workspace');
  } catch (error) {
    return workspaceRouteError('Failed to duplicate Ideation workspace', error);
  }
}
