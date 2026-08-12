import { NextResponse } from 'next/server';
import db from '@/db';
import { priorityEntities } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { getResolvedPriorityEntities, resolvePriorityReference } from '@/lib/priority-entities';

const CREATABLE_ENTITY_TYPES = new Set(['person', 'project', 'tag', 'source']);

export async function GET() {
  try {
    return NextResponse.json({ entities: getResolvedPriorityEntities({ includeMissing: true }) });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch priority entities', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, type, referenceId, description, tier, color, rank } = body;

    if (!name || !type) {
      return ApiErrors.badRequest('name and type are required');
    }
    if (!CREATABLE_ENTITY_TYPES.has(type)) {
      return ApiErrors.badRequest('Unsupported priority entity type');
    }
    if (type !== 'person' && !referenceId) {
      return ApiErrors.badRequest('referenceId is required for project, tag, and source entities');
    }
    const reference = type === 'person'
      ? null
      : resolvePriorityReference(type, referenceId);
    if (type !== 'person' && !reference) {
      return ApiErrors.badRequest('Referenced priority entity does not exist');
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    // If no rank specified, put it at the end
    let finalRank = rank;
    if (finalRank === undefined || finalRank === null) {
      const existing = db.select().from(priorityEntities).all();
      finalRank = existing.length + 1;
    }

    db.insert(priorityEntities).values({
      id,
      name: reference?.name || name,
      type: type as string,
      referenceId: reference?.referenceId || null,
      description: description || reference?.description || null,
      tier: tier || 'standard',
      color: color || reference?.color || '#64748b',
      rank: finalRank,
      activeTaskCount: 0,
      createdAt: now,
      updatedAt: now,
    }).run();

    const entity = db.select().from(priorityEntities).where(eq(priorityEntities.id, id)).get();
    return NextResponse.json({ entity }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create priority entity', error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { entities } = body;

    if (!Array.isArray(entities)) {
      return ApiErrors.badRequest('entities array is required');
    }

    const now = new Date().toISOString();

    // Batch update: update tier, rank, and other fields for each entity
    for (const entity of entities) {
      const updates: Record<string, unknown> = { updatedAt: now };
      if (entity.name !== undefined) updates.name = entity.name;
      if (entity.type !== undefined) updates.type = entity.type;
      if (entity.referenceId !== undefined) updates.referenceId = entity.referenceId;
      if (entity.description !== undefined) updates.description = entity.description;
      if (entity.tier !== undefined) updates.tier = entity.tier;
      if (entity.color !== undefined) updates.color = entity.color;
      if (entity.rank !== undefined) updates.rank = entity.rank;

      db.update(priorityEntities)
        .set(updates)
        .where(eq(priorityEntities.id, entity.id))
        .run();
    }

    return NextResponse.json({ entities: getResolvedPriorityEntities({ includeMissing: true }) });
  } catch (error) {
    return ApiErrors.internal('Failed to update priority entities', error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return ApiErrors.badRequest('id is required');
    }

    db.delete(priorityEntities).where(eq(priorityEntities.id, id)).run();

    // Re-rank remaining entities
    const remaining = db.select().from(priorityEntities).orderBy(asc(priorityEntities.rank)).all();
    const now = new Date().toISOString();
    remaining.forEach((entity, idx) => {
      db.update(priorityEntities)
        .set({ rank: idx + 1, updatedAt: now })
        .where(eq(priorityEntities.id, entity.id))
        .run();
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete priority entity', error);
  }
}
