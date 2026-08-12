import { NextResponse } from 'next/server';
import db from '@/db';
import { listGroups, sourceLists } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { validateNameForGraphApi } from '@/lib/validation/emoji-safety';
import { ApiErrors } from '@/lib/api-error';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const updates: Record<string, string | number | null> = {};

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        return NextResponse.json({ error: 'Group name is required' }, { status: 400 });
      }
      updates.name = name;
    }

    if ('icon' in body) {
      const icon = typeof body.icon === 'string' ? body.icon.trim() : '';
      // Validate the icon isn't an unsafe SMP emoji
      if (icon) {
        const emojiWarning = validateNameForGraphApi(icon);
        if (emojiWarning) {
          return NextResponse.json(
            { error: emojiWarning, code: 'UNSAFE_EMOJI' },
            { status: 422 },
          );
        }
      }
      updates.icon = icon || null;
    }

    if ('iconColor' in body) {
      const iconColor = typeof body.iconColor === 'string' ? body.iconColor.trim() : '';
      updates.iconColor = iconColor || null;
    }

    if ('sortOrder' in body) {
      if (typeof body.sortOrder !== 'number' || Number.isNaN(body.sortOrder)) {
        return NextResponse.json({ error: 'sortOrder must be a number' }, { status: 400 });
      }
      updates.sortOrder = body.sortOrder;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    await db.update(listGroups).set(updates).where(eq(listGroups.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update list group', error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await db.update(sourceLists).set({ groupId: null }).where(eq(sourceLists.groupId, id));
    await db.delete(listGroups).where(eq(listGroups.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete list group', error);
  }
}
