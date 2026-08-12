import { NextResponse } from 'next/server';
import db from '@/db';
import { routines } from '@/db/schema';
import { eq } from 'drizzle-orm';

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

    const [existing] = await db.select().from(routines).where(eq(routines.id, id));
    if (!existing) {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    const allowedFields = ['name', 'cadenceType', 'cadenceConfig', 'description', 'icon', 'isActive', 'isArchived', 'sortOrder'];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    await db.update(routines).set(updates).where(eq(routines.id, id));

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

    const [existing] = await db.select().from(routines).where(eq(routines.id, id));
    if (!existing) {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }

    await db.update(routines).set({
      isArchived: true,
      isActive: false,
      updatedAt: new Date().toISOString(),
    }).where(eq(routines.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete routine' },
      { status: 500 },
    );
  }
}
