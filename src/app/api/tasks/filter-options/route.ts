import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

export async function GET() {
  try {
    const { taskReads } = await getTaskCorePersistence();
    const assignees = await taskReads.listDistinctTaskAssignees();

    return NextResponse.json({
      assignees: assignees
        .map((assignee) => assignee.trim())
        .filter((assignee): assignee is string => Boolean(assignee)),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch task filter options', error);
  }
}
