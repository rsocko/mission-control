import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface CaptureDestinationSetting {
  connectorType: string;
  connectorInstanceId?: string;
  sourceListId?: string;
  sourceListName?: string;
}

const SETTING_KEY = 'capture.defaultDestination';

/**
 * GET /api/settings/capture-destination — Get user's default capture destination
 */
export async function GET() {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SETTING_KEY))
    .limit(1);

  const destination: CaptureDestinationSetting = rows.length > 0
    ? rows[0].value as CaptureDestinationSetting
    : { connectorType: 'local' };

  return NextResponse.json({ destination });
}

/**
 * PUT /api/settings/capture-destination — Set user's default capture destination
 * Body: { connectorType, connectorInstanceId?, sourceListId?, sourceListName? }
 */
export async function PUT(request: Request) {
  const body = await request.json();

  const { connectorType, connectorInstanceId, sourceListId, sourceListName } = body;

  if (!connectorType || typeof connectorType !== 'string') {
    return NextResponse.json({ error: 'connectorType is required' }, { status: 400 });
  }

  const destination: CaptureDestinationSetting = {
    connectorType,
    ...(connectorInstanceId && { connectorInstanceId }),
    ...(sourceListId && { sourceListId }),
    ...(sourceListName && { sourceListName }),
  };

  const now = new Date().toISOString();

  await db
    .insert(appSettings)
    .values({ key: SETTING_KEY, value: destination as unknown as Record<string, unknown>, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: destination as unknown as Record<string, unknown>, updatedAt: now },
    });

  return NextResponse.json({ destination });
}
