import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const persistence = await getConnectorManagementPersistence();
    const body = await request.json();

    const sourceList = await persistence.getSourceList(id);

    if (!sourceList) {
      return NextResponse.json({ error: 'Source list not found' }, { status: 404 });
    }

    const updates: { groupId?: string | null; hidden?: boolean } = {};

    if ('groupId' in body) {
      const nextGroupId = body.groupId === null
        ? null
        : typeof body.groupId === 'string' && body.groupId.trim()
          ? body.groupId.trim()
          : null;

      if (nextGroupId) {
        if (!(await persistence.listGroupExists(nextGroupId))) {
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

    await persistence.patchSourceList({
      sourceListId: id,
      groupId: updates.groupId,
      hidden: updates.hidden,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update source list', error);
  }
}
