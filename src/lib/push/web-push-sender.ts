import 'server-only';

import webPush from 'web-push';
import db from '@/db';
import { pushSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { MissionControlPushPayload } from '@/lib/notifications/service';
import logger from '@/lib/logger';

export interface PushSendResult {
  classification: 'delivered' | 'no_subscription' | 'channel_unconfigured' | 'delivery_failure';
  attempted: number;
  sent: number;
  failed: number;
  transientFailures: number;
  permanentFailures: number;
  expiredSubscriptions: number;
}

function statusCodeOf(error: unknown): number | null {
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return typeof statusCode === 'number' ? statusCode : null;
}

function isTransientStatus(statusCode: number | null): boolean {
  return statusCode === null
    || statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || statusCode >= 500;
}

export async function sendWebPushPayload(
  payload: MissionControlPushPayload,
): Promise<PushSendResult> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    return {
      classification: 'channel_unconfigured',
      attempted: 0,
      sent: 0,
      failed: 0,
      transientFailures: 0,
      permanentFailures: 0,
      expiredSubscriptions: 0,
    };
  }
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@missioncontrol.app',
    publicKey,
    privateKey,
  );

  const subscriptions = db.select().from(pushSubscriptions).where(
    eq(pushSubscriptions.platform, 'web'),
  ).all();
  if (subscriptions.length === 0) {
    return {
      classification: 'no_subscription',
      attempted: 0,
      sent: 0,
      failed: 0,
      transientFailures: 0,
      permanentFailures: 0,
      expiredSubscriptions: 0,
    };
  }

  let sent = 0;
  let failed = 0;
  let transientFailures = 0;
  let permanentFailures = 0;
  let expiredSubscriptions = 0;
  await Promise.all(subscriptions.map(async subscription => {
    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys as { p256dh: string; auth: string },
        },
        JSON.stringify(payload),
        { timeout: 15_000 },
      );
      sent += 1;
    } catch (error: unknown) {
      const statusCode = statusCodeOf(error);
      failed += 1;
      if (statusCode === 404 || statusCode === 410) {
        db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id)).run();
        expiredSubscriptions += 1;
        permanentFailures += 1;
        logger.info(
          { subscriptionId: subscription.id, statusCode },
          'Removed expired push subscription',
        );
      } else if (isTransientStatus(statusCode)) {
        transientFailures += 1;
        logger.warn(
          { err: error, subscriptionId: subscription.id, statusCode },
          'Transient Web Push delivery failure',
        );
      } else {
        permanentFailures += 1;
        logger.error(
          { err: error, subscriptionId: subscription.id, statusCode },
          'Permanent Web Push delivery failure',
        );
      }
    }
  }));

  return {
    classification: failed === 0 ? 'delivered' : 'delivery_failure',
    attempted: subscriptions.length,
    sent,
    failed,
    transientFailures,
    permanentFailures,
    expiredSubscriptions,
  };
}
