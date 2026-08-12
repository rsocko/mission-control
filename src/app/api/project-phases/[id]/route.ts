import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { projectPhases, projectPhaseItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { dbLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/project-phases/[id] — Get a phase with its items
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [phase] = await db.select().from(projectPhases).where(eq(projectPhases.id, id));
    if (!phase) {
      return NextResponse.json({ error: 'Phase not found' }, { status: 404 });
    }

    const items = await db.select().from(projectPhaseItems)
      .where(eq(projectPhaseItems.phaseId, id))
      .orderBy(projectPhaseItems.sortOrder);

    return NextResponse.json({ phase, items });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch phase', error);
  }
}

/**
 * PATCH /api/project-phases/[id] — Update a phase
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    const allowedFields = ['name', 'description', 'status', 'color', 'estimatedDays', 'targetStart', 'targetEnd', 'sortOrder', 'completedAt', 'projectId', 'startAfterPhaseId'];
    for (const field of allowedFields) {
      if (field in body) {
        updates[field] = body[field];
      }
    }

    // Auto-set completedAt when status transitions to completed
    if (body.status === 'completed' && !body.completedAt) {
      updates.completedAt = now;
    }

    await db.update(projectPhases).set(updates).where(eq(projectPhases.id, id));
    const [phase] = await db.select().from(projectPhases).where(eq(projectPhases.id, id));

    return NextResponse.json({ phase });
  } catch (error) {
    return ApiErrors.internal('Failed to update phase', error);
  }
}

/**
 * DELETE /api/project-phases/[id] — Delete a phase and its items
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    try {
      runTransaction((tx) => {
        // Clear dangling startAfterPhaseId references on dependent phases
        tx.update(projectPhases)
          .set({ startAfterPhaseId: null })
          .where(eq(projectPhases.startAfterPhaseId, id)).run();
        tx.delete(projectPhaseItems).where(eq(projectPhaseItems.phaseId, id)).run();
        tx.delete(projectPhases).where(eq(projectPhases.id, id)).run();
      });
    } catch (err) {
      dbLogger.error({ err, phaseId: id, op: 'deletePhase' },
        'Transaction rolled back: phase cascade-delete failed');
      throw err;
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete phase', error);
  }
}
