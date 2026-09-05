import { NextResponse } from 'next/server';
import {
  getPreferenceSettingsRepositoryForBackend,
  type InboxListEntry,
} from '@/lib/settings/preference-settings';

/**
 * GET /api/settings/inbox-lists — Get user-configured inbox lists
 * These lists are included in the "Inbox" quick filter alongside local tasks.
 */
export async function GET() {
  const repository = await getPreferenceSettingsRepositoryForBackend();
  const lists = await repository.getInboxLists();
  return NextResponse.json({ lists });
}

/**
 * PUT /api/settings/inbox-lists — Set user-configured inbox lists
 * Body: { lists: Array<{ connectorType, sourceListId?, sourceListName?, label? }> }
 */
export async function PUT(request: Request) {
  const body = await request.json();

  if (!Array.isArray(body.lists)) {
    return NextResponse.json({ error: 'lists must be an array' }, { status: 400 });
  }

  const lists: InboxListEntry[] = body.lists.map((entry: Record<string, unknown>) => {
    const item: InboxListEntry = { connectorType: entry.connectorType as string };
    if (entry.sourceListId) item.sourceListId = entry.sourceListId as string;
    if (entry.sourceListName) item.sourceListName = entry.sourceListName as string;
    if (entry.label) item.label = entry.label as string;
    return item;
  });

  const repository = await getPreferenceSettingsRepositoryForBackend();
  await repository.setInboxLists(lists);

  return NextResponse.json({ lists });
}
