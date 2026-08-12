import { NextResponse } from 'next/server';
import { PATCH as updateTask } from '@/app/api/tasks/[id]/route';
import { isAuthorizedMcpRequest } from '@/mcp/auth';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedMcpRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return updateTask(request, context);
}
