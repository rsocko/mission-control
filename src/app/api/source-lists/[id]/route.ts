import { NextResponse } from 'next/server';
import db from '@/db';
import { listGroups, sourceLists } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();

    const [sourceList] = await db
      .select({ id: sourceLists.id })
      .from(sourceLists)
      .where(eq(sourceLists.id, id))
      .limit(1);

    if (!sourceList) {
      return NextResponse.json({ error: 'Source list not found' }, { status: 404 });
    }

    const updates: Record<string, unknown> = {};

    if ('groupId' in body) {
      const nextGroupId = body.groupId === null
        ? null
        : typeof body.groupId === 'string' && body.groupId.trim()
          ? body.groupId.trim()
          : null;

      if (nextGroupId) {
        const [group] = await db
          .select({ id: listGroups.id })
          .from(listGroups)
          .where(eq(listGroups.id, nextGroupId))
          .limit(1);

        if (!group) {
          return NextResponse.json({ error: 'List group not found' }, { status: 404 });
        }
      }

      updates.groupId = nextGroupId;
    }

    if ('hidden' in body) {
      updates.hidden = Boolean(body.hidden);
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    await db.update(sourceLists).set(updates).where(eq(sourceLists.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update source list', error);
  }
}
