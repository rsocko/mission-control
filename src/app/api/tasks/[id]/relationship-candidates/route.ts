import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('query')?.trim() ?? '';
    const requestedLimit = Number.parseInt(searchParams.get('limit') ?? '20', 10);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 20;
    const { taskReads } = await getTaskCorePersistence();
    const candidates = await taskReads.searchRelationshipCandidates({ taskId: id, query, limit });
    if (!candidates) return ApiErrors.notFound('Task');
    return NextResponse.json({ candidates });
  } catch (error) {
    return ApiErrors.internal('Failed to search task relationship candidates', error);
  }
}
