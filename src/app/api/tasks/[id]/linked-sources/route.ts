import { NextResponse } from 'next/server';
import db from '@/db';
import { taskLinkedSources } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * GET /api/tasks/[id]/linked-sources
 * Returns all linked sources for a given task (cross-connector provenance).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const linked = await db
    .select()
    .from(taskLinkedSources)
    .where(eq(taskLinkedSources.taskId, id));

  return NextResponse.json({ linkedSources: linked });
}
