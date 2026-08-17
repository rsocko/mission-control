import { NextResponse } from 'next/server';
import { ideationWorkspaceService } from '@/lib/graph-workspace/service';
import {
  rejectUntrustedWorkspaceMutation,
  workspaceRouteError,
} from './route-errors';

export async function GET(request: Request) {
  try {
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
    return NextResponse.json({
      workspaces: ideationWorkspaceService.list(includeArchived),
    });
  } catch (error) {
    return workspaceRouteError('Failed to list Ideation workspaces', error);
  }
}

export async function POST(request: Request) {
  const untrusted = rejectUntrustedWorkspaceMutation(request);
  if (untrusted) return untrusted;
  try {
    const body = await request.json();
    const workspace = ideationWorkspaceService.create({
      name: body.name,
      document: body.document,
      migrationSource: body.migrationSource,
      import: body.import === true,
    });
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    return workspaceRouteError('Failed to create Ideation workspace', error);
  }
}
