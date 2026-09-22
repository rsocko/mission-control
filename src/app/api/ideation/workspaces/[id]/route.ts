import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { ideationWorkspaceService } from '@/lib/graph-workspace/service';
import {
  rejectUntrustedWorkspaceMutation,
  workspaceRouteError,
} from '../route-errors';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const workspace = await ideationWorkspaceService.get((await params).id);
    return workspace
      ? NextResponse.json({ workspace })
      : ApiErrors.notFound('Ideation workspace');
  } catch (error) {
    return workspaceRouteError('Failed to load Ideation workspace', error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  const untrusted = rejectUntrustedWorkspaceMutation(request);
  if (untrusted) return untrusted;
  try {
    const { id } = await params;
    const body = await request.json();
    let workspace;
    if ('document' in body) {
      workspace = await ideationWorkspaceService.updateContent(
        id,
        body.baseRevision,
        body.document,
      );
    } else if ('name' in body) {
      workspace = await ideationWorkspaceService.rename(id, body.name);
    } else if ('archived' in body) {
      workspace = await ideationWorkspaceService.setArchived(id, body.archived);
    } else {
      return ApiErrors.badRequest('A document, name, or archived value is required');
    }
    return workspace
      ? NextResponse.json({ workspace })
      : ApiErrors.notFound('Ideation workspace');
  } catch (error) {
    return workspaceRouteError('Failed to update Ideation workspace', error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const untrusted = rejectUntrustedWorkspaceMutation(request);
  if (untrusted) return untrusted;
  try {
    const result = await ideationWorkspaceService.deleteArchived((await params).id);
    if (result === 'not-found') return ApiErrors.notFound('Ideation workspace');
    if (result === 'not-archived') {
      return ApiErrors.conflict('Archive the workspace before deleting it permanently');
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return workspaceRouteError('Failed to delete Ideation workspace', error);
  }
}
