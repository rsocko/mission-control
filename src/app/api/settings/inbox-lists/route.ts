import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface InboxListEntry {
  connectorType: string;
  sourceListId?: string;
  sourceListName?: string;
  label?: string;
}

const SETTING_KEY = 'inbox.lists';

/**
 * GET /api/settings/inbox-lists — Get user-configured inbox lists
 * These lists are included in the "Inbox" quick filter alongside local tasks.
 */
export async function GET() {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SETTING_KEY))
    .limit(1);

  const lists: InboxListEntry[] = rows.length > 0
    ? rows[0].value as InboxListEntry[]
    : [];

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

  const now = new Date().toISOString();

  await db
    .insert(appSettings)
    .values({ key: SETTING_KEY, value: lists as unknown as Record<string, unknown>, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: lists as unknown as Record<string, unknown>, updatedAt: now },
    });

  return NextResponse.json({ lists });
}
