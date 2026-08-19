import db from '@/db';
import { notifications } from '@/db/schema';
import { desc } from 'drizzle-orm';
import { notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';

export async function listNotificationsForClassification() {
  return db.select()
    .from(notifications)
    .where(notificationNeedsAttention())
    .orderBy(desc(notifications.receivedAt))
    .limit(20);
}
