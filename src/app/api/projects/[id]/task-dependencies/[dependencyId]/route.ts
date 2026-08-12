import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  deleteTaskDependency,
  GraphServiceError,
} from '@/lib/graph/service';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; dependencyId: string }> },
) {
  try {
    const { id: projectId, dependencyId } = await params;
    await deleteTaskDependency({ projectId, dependencyId });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof GraphServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return ApiErrors.internal('Failed to delete task dependency', error);
  }
}
