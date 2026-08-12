import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';

const SETTINGS_KEY = 'dopamine-menu';

export interface DopamineReward {
  id: string;
  emoji: string;
  label: string;
}

export interface DopamineMenuSettings {
  enabled: boolean;
  threshold: number;
  rewards: DopamineReward[];
}

const DEFAULT_REWARDS: DopamineReward[] = [
  { id: '1', emoji: '☕', label: 'Coffee break' },
  { id: '2', emoji: '🎵', label: 'Fresh playlist' },
  { id: '3', emoji: '🚶', label: '10-min walk' },
  { id: '4', emoji: '📱', label: 'Phone break' },
  { id: '5', emoji: '🎮', label: 'Quick game' },
  { id: '6', emoji: '✨', label: 'Your choice' },
];

const DEFAULT_SETTINGS: DopamineMenuSettings = {
  enabled: true,
  threshold: 5,
  rewards: DEFAULT_REWARDS,
};

export async function GET() {
  try {
    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY));

    if (!row) {
      return NextResponse.json(DEFAULT_SETTINGS);
    }

    const stored = row.value as Partial<DopamineMenuSettings>;
    return NextResponse.json({
      enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
      threshold: stored.threshold ?? DEFAULT_SETTINGS.threshold,
      rewards: stored.rewards ?? DEFAULT_SETTINGS.rewards,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch dopamine menu settings');
    return NextResponse.json(DEFAULT_SETTINGS);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const now = new Date().toISOString();

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

    // Merge with existing settings
    const [existing] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY));

    const current = (existing?.value as Partial<DopamineMenuSettings>) || {};
    const updated: DopamineMenuSettings = {
      enabled: body.enabled ?? current.enabled ?? DEFAULT_SETTINGS.enabled,
      threshold: body.threshold ?? current.threshold ?? DEFAULT_SETTINGS.threshold,
      rewards: body.rewards ?? current.rewards ?? DEFAULT_SETTINGS.rewards,
    };

    if (existing) {
      await db
        .update(appSettings)
        .set({ value: updated, updatedAt: now })
        .where(eq(appSettings.key, SETTINGS_KEY));
    } else {
      await db.insert(appSettings).values({
        key: SETTINGS_KEY,
        value: updated,
        updatedAt: now,
      });
    }

    return NextResponse.json(updated);
  } catch (error) {
    logger.error({ err: error }, 'Failed to update dopamine menu settings');
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
