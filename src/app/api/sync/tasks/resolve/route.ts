import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import db from '@/db';
import { tasks } from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const connectorId = url.searchParams.get('connectorId');
  const sourceId = url.searchParams.get('sourceId');
  if (!connectorId || !sourceId) {
    return ApiErrors.badRequest('connectorId and sourceId are required');
  }

  const [task] = await db.select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.connectorInstanceId, connectorId),
      eq(tasks.sourceId, sourceId),
    ))
    .limit(1);

  return NextResponse.json({ taskId: task?.id ?? null });
}
