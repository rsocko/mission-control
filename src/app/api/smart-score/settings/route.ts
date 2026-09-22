import { NextResponse } from 'next/server';
import { requireSmartScoreSettingsRepository } from '@/db/persistence/core-repositories';
import logger from '@/lib/logger';
import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';

export async function GET() {
  try {
    const settings = requireSmartScoreSettingsRepository(
      (await getCorePersistenceRepositoriesForBackend()).settings,
    );
    return NextResponse.json({ settings: await settings.listSmartScoreSettings() });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch smart score settings');
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { key?: string; value?: unknown };
    const { key, value } = body;

    if (!key || value === undefined) {
      return NextResponse.json({ error: 'key and value are required' }, { status: 400 });
    }

    const settings = requireSmartScoreSettingsRepository(
      (await getCorePersistenceRepositoriesForBackend()).settings,
    );
    await settings.setSmartScoreSetting(key, String(value));

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update smart score setting');
    return NextResponse.json({ error: 'Failed to update setting' }, { status: 500 });
  }
}
