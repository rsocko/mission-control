import { NextResponse } from 'next/server';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

/**
 * GET /api/tasks/[id]/linked-sources
 * Returns all linked sources for a given task (cross-connector provenance).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { taskReads } = await getTaskCorePersistence();
  const linked = await taskReads.listLinkedSources(id);

  return NextResponse.json({ linkedSources: linked });
}
