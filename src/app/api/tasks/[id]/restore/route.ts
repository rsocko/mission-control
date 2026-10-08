import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import {
  indexTask as indexTaskKeyword,
} from '@/lib/search/fts';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication-service';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const persistence = await getTaskCorePersistence();
    const outcome = await persistence.removals.restoreTask(id, new Date().toISOString());
    if (outcome.kind === 'not-found') return ApiErrors.notFound('Task');
    if (outcome.kind === 'not-deleted') {
      return NextResponse.json(
        { error: 'Task is not deleted', code: 'TASK_NOT_DELETED' },
        { status: 409 },
      );
    }

    await indexTaskKeyword(outcome.task);
    await publishSemanticEntityUpsert('task', outcome.task.id);
    return NextResponse.json({ success: true, task: outcome.task });
  } catch (error) {
    return ApiErrors.internal('Failed to restore task', error);
  }
}
