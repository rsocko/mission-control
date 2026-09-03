import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';
import { hardDeleteScoutTask } from '@/lib/tasks/scout-hard-delete';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await hardDeleteScoutTask(id);
    if (result.kind === 'not-found') return ApiErrors.notFound('Task');
    if (result.kind === 'not-scout') {
      return ApiErrors.badRequest('Hard delete with ingest suppression is only available for Scout tasks');
    }

    return NextResponse.json({
      success: true,
      action: 'hard-deleted',
      sourceId: result.sourceId,
      suppressedFromIngest: true,
    });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to hard-delete Scout task');
    return ApiErrors.internal('Failed to hard-delete Scout task', error);
  }
}
