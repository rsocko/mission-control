import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  archiveRoutine,
  getRoutine,
  ROUTINE_CADENCE_TYPES,
  updateRoutine,
  type RoutineCadenceType,
  type RoutineUpdate,
} from '@/lib/routines/service';

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function validateCadenceConfig(cadenceType: RoutineCadenceType, config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'cadenceConfig must be an object';
  }

  const cadenceConfig = config as Record<string, unknown>;
  if (cadenceType === 'specific_days') {
    const days = cadenceConfig.days;
    if (!Array.isArray(days) || days.length === 0 || days.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) {
      return 'Specific-day routines require at least one valid day';
    }
  }
  if (cadenceType === 'x_per_week' && (!isPositiveInteger(cadenceConfig.target) || cadenceConfig.target > 7)) {
    return 'Weekly target must be between 1 and 7';
  }
  if (cadenceType === 'every_n_days') {
    if (!isPositiveInteger(cadenceConfig.minDays) || !isPositiveInteger(cadenceConfig.maxDays) || cadenceConfig.maxDays < cadenceConfig.minDays) {
      return 'Every-N-days routines require positive intervals with maxDays greater than or equal to minDays';
    }
  }
  return null;
}

/**
 * PATCH /api/routines/[id] — Update a routine
 * Body: Partial<{ name, cadenceType, cadenceConfig, description, icon, iconColor, isActive, isArchived, sortOrder }>
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return ApiErrors.badRequest('Request body must be an object');
    }

    const existing = await getRoutine(id);
    if (!existing) {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }

    if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) {
      return ApiErrors.badRequest('name must be a non-empty string');
    }
    if ('description' in body && body.description !== null && typeof body.description !== 'string') {
      return ApiErrors.badRequest('description must be a string or null');
    }
    if ('icon' in body && body.icon !== null && typeof body.icon !== 'string') {
      return ApiErrors.badRequest('icon must be a string or null');
    }
    if ('iconColor' in body && body.iconColor !== null && typeof body.iconColor !== 'string') {
      return ApiErrors.badRequest('iconColor must be a string or null');
    }
    if ('cadenceType' in body && !ROUTINE_CADENCE_TYPES.includes(body.cadenceType as RoutineCadenceType)) {
      return ApiErrors.badRequest(`Invalid cadenceType. Must be one of: ${ROUTINE_CADENCE_TYPES.join(', ')}`);
    }

    const cadenceType = (body.cadenceType ?? existing.cadenceType) as RoutineCadenceType;
    if ('cadenceConfig' in body || 'cadenceType' in body) {
      const cadenceError = validateCadenceConfig(cadenceType, body.cadenceConfig ?? existing.cadenceConfig);
      if (cadenceError) return ApiErrors.badRequest(cadenceError);
    }

    const updates: Record<string, unknown> = {};
    const allowedFields = ['name', 'cadenceType', 'cadenceConfig', 'description', 'icon', 'iconColor', 'isActive', 'isArchived', 'sortOrder'];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = ['name', 'icon', 'iconColor'].includes(field) && typeof body[field] === 'string'
          ? body[field].trim() || (field === 'name' ? body[field] : null)
          : body[field];
      }
    }

    await updateRoutine(id, {
      updates: updates as RoutineUpdate,
      updatedAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true });
  } catch {
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
  } catch {
    return NextResponse.json(
      { error: 'Failed to delete routine' },
      { status: 500 },
    );
  }
}
