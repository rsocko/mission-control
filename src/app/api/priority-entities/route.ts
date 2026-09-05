import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getResolvedPriorityEntities, resolvePriorityReference } from '@/lib/priority-entities';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type {
  PriorityEntityCreate,
  PriorityEntityUpdate,
} from '@/lib/tasks/core/contracts';

const CREATABLE_ENTITY_TYPES = new Set(['person', 'project', 'tag', 'source']);
type CreatablePriorityEntityType = 'person' | 'project' | 'tag' | 'source';

function isCreatablePriorityEntityType(value: string): value is CreatablePriorityEntityType {
  return CREATABLE_ENTITY_TYPES.has(value);
}

export async function GET() {
  try {
    return NextResponse.json({ entities: await getResolvedPriorityEntities({ includeMissing: true }) });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch priority entities', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Omit<PriorityEntityCreate, 'id' | 'now'>;
    const { name, type, referenceId, description, tier, color, rank } = body;

    if (!name || !type) {
      return ApiErrors.badRequest('name and type are required');
    }
    if (!isCreatablePriorityEntityType(type)) {
      return ApiErrors.badRequest('Unsupported priority entity type');
    }
    if (type !== 'person' && !referenceId) {
      return ApiErrors.badRequest('referenceId is required for project, tag, and source entities');
    }
    const reference = type === 'person'
      ? null
      : await resolvePriorityReference(type, referenceId ?? '');
    if (type !== 'person' && !reference) {
      return ApiErrors.badRequest('Referenced priority entity does not exist');
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const entity = await (await getTaskCorePersistence()).priorityEntities.createPriorityEntity({
      id,
      name: reference?.name || name,
      type,
      referenceId: reference?.referenceId || null,
      description: description || reference?.description || null,
      tier: tier || 'standard',
      color: color || reference?.color || '#64748b',
      rank: rank ?? undefined,
      now,
    });

    return NextResponse.json({ entity }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create priority entity', error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      entities?: Array<Omit<PriorityEntityUpdate, 'updatedAt'>>;
    };
    const { entities } = body;

    if (!Array.isArray(entities)) {
      return ApiErrors.badRequest('entities array is required');
    }

    const now = new Date().toISOString();
    await (await getTaskCorePersistence()).priorityEntities.updatePriorityEntities(
      entities.map((entity) => ({
        id: entity.id,
        ...(entity.name !== undefined ? { name: entity.name } : {}),
        ...(entity.type !== undefined ? { type: entity.type } : {}),
        ...(entity.referenceId !== undefined ? { referenceId: entity.referenceId } : {}),
        ...(entity.description !== undefined ? { description: entity.description } : {}),
        ...(entity.tier !== undefined ? { tier: entity.tier } : {}),
        ...(entity.color !== undefined ? { color: entity.color } : {}),
        ...(entity.rank !== undefined ? { rank: entity.rank } : {}),
        updatedAt: now,
      })),
    );

    return NextResponse.json({ entities: await getResolvedPriorityEntities({ includeMissing: true }) });
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

    const now = new Date().toISOString();
    await (await getTaskCorePersistence()).priorityEntities
      .deletePriorityEntityAndRerank(id, now);

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete priority entity', error);
  }
}
