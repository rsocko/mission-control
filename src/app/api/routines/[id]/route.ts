import { NextResponse } from 'next/server';
import {
  archiveRoutine,
  getRoutine,
  updateRoutine,
  type RoutineUpdate,
} from '@/lib/routines/service';

/**
 * PATCH /api/routines/[id] — Update a routine
 * Body: Partial<{ name, cadenceType, cadenceConfig, description, icon, isActive, isArchived, sortOrder }>
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const existing = await getRoutine(id);
    if (!existing) {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }

    const updates: Record<string, unknown> = {};
    const allowedFields = ['name', 'cadenceType', 'cadenceConfig', 'description', 'icon', 'isActive', 'isArchived', 'sortOrder'];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    await updateRoutine(id, {
      updates: updates as RoutineUpdate,
      updatedAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update routine' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/routines/[id] — Archive (soft-delete) a routine
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const archived = await archiveRoutine(id, new Date().toISOString());
    if (!archived) {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete routine' },
      { status: 500 },
    );
  }
}
