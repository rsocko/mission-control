import { asc, isNotNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks } from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';

export async function GET() {
  try {
    const rows = await db
      .selectDistinct({ assignee: tasks.assignee })
      .from(tasks)
      .where(isNotNull(tasks.assignee))
      .orderBy(asc(tasks.assignee));

    return NextResponse.json({
      assignees: rows
        .map((row) => row.assignee?.trim())
        .filter((assignee): assignee is string => Boolean(assignee)),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch task filter options', error);
  }
}
