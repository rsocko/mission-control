import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { validateNameForGraphApi } from '@/lib/validation/emoji-safety';
import { ApiErrors, apiError } from '@/lib/api-error';
import {
  createListGroup,
  getListOrganizationSnapshot,
} from '@/lib/list-groups/service';

export async function GET() {
  try {
    return NextResponse.json(await getListOrganizationSnapshot());
  } catch (error) {
    return ApiErrors.internal('Failed to fetch list groups', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const icon = typeof body.icon === 'string' ? body.icon.trim() : '';
    const iconColor = typeof body.iconColor === 'string' ? body.iconColor.trim() : '';

    if (!name) {
      return ApiErrors.badRequest('Group name is required');
    }

    // Validate emoji safety — icon+name combined is what gets synced
    const displayName = icon ? `${icon}${name}` : name;
    const emojiWarning = validateNameForGraphApi(displayName);
    if (emojiWarning) {
      return apiError(emojiWarning, 'UNSAFE_EMOJI', 422);
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await createListGroup({
      id,
      name,
      icon: icon || null,
      iconColor: iconColor || null,
      sourceId: null,
      sortOrder: 0,
      createdAt,
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create list group', error);
  }
}
