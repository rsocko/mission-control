import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import {
  DEFAULT_DOPAMINE_MENU_SETTINGS,
  getPreferenceSettingsRepositoryForBackend,
  type DopamineMenuSettingsPatch,
} from '@/lib/settings/preference-settings';

export async function GET() {
  try {
    const repository = await getPreferenceSettingsRepositoryForBackend();
    return NextResponse.json(await repository.getDopamineMenu());
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch dopamine menu settings');
    return NextResponse.json(DEFAULT_DOPAMINE_MENU_SETTINGS);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();

    // Validate threshold if provided
    if (body.threshold !== undefined) {
      const t = Number(body.threshold);
      if (!Number.isInteger(t) || t < 1 || t > 100) {
        return NextResponse.json({ error: 'Threshold must be an integer between 1 and 100' }, { status: 400 });
      }
      body.threshold = t;
    }

    // Validate rewards array if provided
    if (body.rewards !== undefined) {
      if (!Array.isArray(body.rewards) || body.rewards.length > 20) {
        return NextResponse.json({ error: 'Rewards must be an array with at most 20 items' }, { status: 400 });
      }
      for (const r of body.rewards) {
        if (typeof r.id !== 'string' || typeof r.emoji !== 'string' || typeof r.label !== 'string') {
          return NextResponse.json({ error: 'Each reward must have id, emoji, and label strings' }, { status: 400 });
        }
      }
    }

    const repository = await getPreferenceSettingsRepositoryForBackend();
    const updated = await repository.patchDopamineMenu(body as DopamineMenuSettingsPatch);
    return NextResponse.json(updated);
  } catch (error) {
    logger.error({ err: error }, 'Failed to update dopamine menu settings');
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
