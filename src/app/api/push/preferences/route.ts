import { NextResponse } from 'next/server';
import { pushNotificationScheduler } from '@/lib/push/scheduler';
import { getNotificationPushPersistence } from '@/lib/push/notification-push-service';

/** Get push notification preferences */
export async function GET() {
  const persistence = await getNotificationPushPersistence();
  const [prefs, pushDeliveryEnabled] = await Promise.all([
    persistence.getPreferences(),
    persistence.getPushDeliveryEnabled(),
  ]);
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
    pushDeliveryEnabled,
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
    const pushDeliveryEnabledInput = body.pushDeliveryEnabled;

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
    if (
      pushDeliveryEnabledInput !== undefined
      && typeof pushDeliveryEnabledInput !== 'boolean'
    ) {
      return NextResponse.json({ error: 'pushDeliveryEnabled must be a boolean' }, { status: 400 });
    }
    for (const field of [
      'morningEnabled',
      'triageNudgeEnabled',
      'carryForwardEnabled',
      'doNotDisturb',
    ] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        return NextResponse.json({ error: `${field} must be a boolean` }, { status: 400 });
      }
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

    const persistence = await getNotificationPushPersistence();
    await persistence.savePreferences({
      preferences: {
        morningEnabled: values.morningEnabled,
        morningHour: values.morningHour,
        triageNudgeEnabled: values.triageNudgeEnabled,
        triageNudgeThreshold: values.triageNudgeThreshold,
        carryForwardEnabled: values.carryForwardEnabled,
        carryForwardHour: values.carryForwardHour,
        quietStart: values.quietStart,
        quietEnd: values.quietEnd,
        doNotDisturb: values.doNotDisturb,
      },
      pushDeliveryEnabled: pushDeliveryEnabledInput,
      updatedAt: now,
    });

    // The scheduler checks its running state inside the lifecycle lock so a
    // concurrent stop cannot be undone by this settings refresh.
    await pushNotificationScheduler.restart();

    return NextResponse.json({ status: 'saved' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
  }
}
