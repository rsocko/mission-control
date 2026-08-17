import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { ideationWorkspaceService } from '@/lib/graph-workspace/service';
import {
  rejectUntrustedWorkspaceMutation,
  workspaceRouteError,
} from '../../../route-errors';

type Context = { params: Promise<{ id: string; revision: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const { id, revision } = await params;
    const version = ideationWorkspaceService.getVersion(id, revision);
    return version
      ? NextResponse.json({ version })
      : ApiErrors.notFound('Ideation workspace version');
  } catch (error) {
    return workspaceRouteError('Failed to load Ideation workspace version', error);
  }
}

export async function POST(request: Request, { params }: Context) {
  const untrusted = rejectUntrustedWorkspaceMutation(request);
  if (untrusted) return untrusted;
  try {
    const { id, revision } = await params;
    const body = await request.json();
    const workspace = ideationWorkspaceService.restore(
      id,
      Number(revision),
      body.baseRevision,
    );
    return workspace
      ? NextResponse.json({ workspace })
      : ApiErrors.notFound('Ideation workspace or version');
  } catch (error) {
    return workspaceRouteError('Failed to restore Ideation workspace version', error);
  }
}
