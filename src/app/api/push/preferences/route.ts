import { NextResponse } from 'next/server';
import db from '@/db';
import { pushPreferences } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { pushNotificationScheduler } from '@/lib/push/scheduler';

/** Get push notification preferences */
export async function GET() {
  const rows = await db.select().from(pushPreferences).where(eq(pushPreferences.id, 'default')).limit(1);

  if (rows.length === 0) {
    // Return defaults
    return NextResponse.json({
      morningEnabled: true,
      morningHour: 8,
      triageNudgeEnabled: true,
      triageNudgeThreshold: 5,
      carryForwardEnabled: true,
      carryForwardHour: 18,
      quietStart: null,
      quietEnd: null,
      doNotDisturb: false,
    });
  }

  const prefs = rows[0];
  return NextResponse.json({
    morningEnabled: prefs.morningEnabled,
    morningHour: prefs.morningHour,
    triageNudgeEnabled: prefs.triageNudgeEnabled,
    triageNudgeThreshold: prefs.triageNudgeThreshold,
    carryForwardEnabled: prefs.carryForwardEnabled,
    carryForwardHour: prefs.carryForwardHour,
    quietStart: prefs.quietStart,
    quietEnd: prefs.quietEnd,
    doNotDisturb: prefs.doNotDisturb,
  });
}

/** Update push notification preferences */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const now = new Date().toISOString();

    // Validate hour/threshold ranges
    const morningHour = Number(body.morningHour ?? 8);
    const carryForwardHour = Number(body.carryForwardHour ?? 18);
    const triageNudgeThreshold = Number(body.triageNudgeThreshold ?? 5);
    const quietStart = body.quietStart != null ? Number(body.quietStart) : null;
    const quietEnd = body.quietEnd != null ? Number(body.quietEnd) : null;

    if (!Number.isInteger(morningHour) || morningHour < 0 || morningHour > 23) {
      return NextResponse.json({ error: 'morningHour must be 0-23' }, { status: 400 });
    }
    if (!Number.isInteger(carryForwardHour) || carryForwardHour < 0 || carryForwardHour > 23) {
      return NextResponse.json({ error: 'carryForwardHour must be 0-23' }, { status: 400 });
    }
    if (!Number.isInteger(triageNudgeThreshold) || triageNudgeThreshold < 1) {
      return NextResponse.json({ error: 'triageNudgeThreshold must be a positive integer' }, { status: 400 });
    }
    if (quietStart !== null && (!Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23)) {
      return NextResponse.json({ error: 'quietStart must be 0-23' }, { status: 400 });
    }
    if (quietEnd !== null && (!Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23)) {
      return NextResponse.json({ error: 'quietEnd must be 0-23' }, { status: 400 });
    }

    const values = {
      id: 'default' as const,
      morningEnabled: body.morningEnabled ?? true,
      morningHour,
      triageNudgeEnabled: body.triageNudgeEnabled ?? true,
      triageNudgeThreshold,
      carryForwardEnabled: body.carryForwardEnabled ?? true,
      carryForwardHour,
      quietStart,
      quietEnd,
      doNotDisturb: body.doNotDisturb ?? false,
      updatedAt: now,
    };

    // Upsert
    const existing = await db.select().from(pushPreferences).where(eq(pushPreferences.id, 'default')).limit(1);
    if (existing.length > 0) {
      await db.update(pushPreferences).set(values).where(eq(pushPreferences.id, 'default'));
    } else {
      await db.insert(pushPreferences).values(values);
    }

    // Restart scheduler so cron times reflect new morningHour/carryForwardHour
    if (pushNotificationScheduler.isRunning()) {
      await pushNotificationScheduler.restart();
    }

    return NextResponse.json({ status: 'saved' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
  }
}
