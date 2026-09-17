import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import {
  DEFAULT_CONTEXT_THEME_PREFERENCES,
  contextThemePreferencesSchema,
} from '@/lib/context-appearance';
import { getPreferenceSettingsRepositoryForBackend } from '@/lib/settings/preference-settings';

export async function GET() {
  try {
    const repository = await getPreferenceSettingsRepositoryForBackend();
    return NextResponse.json(await repository.getContextThemes());
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch context theme settings');
    return NextResponse.json(DEFAULT_CONTEXT_THEME_PREFERENCES);
  }
}

export async function PUT(request: Request) {
  try {
    const parsed = contextThemePreferencesSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid context theme settings' },
        { status: 400 },
      );
    }
    const repository = await getPreferenceSettingsRepositoryForBackend();
    await repository.setContextThemes(parsed.data);
    return NextResponse.json(parsed.data);
  } catch (error) {
    logger.error({ err: error }, 'Failed to save context theme settings');
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
