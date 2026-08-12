import db from '@/db';
import { triageItems } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { TriageSourcePlatform } from '@/types';

export interface QueueHealthMetrics {
  totalPending: number;
  /** Items pending > 24 hours */
  over24h: number;
  /** Items pending > 3 days */
  over3d: number;
  /** Items pending > 7 days */
  over7d: number;
  /** Items pending > 14 days */
  over14d: number;
  /** Age of the oldest pending item in hours (null if no items) */
  oldestAgeHours: number | null;
  /** Average pending age in hours */
  averageAgeHours: number;
  /** Pending item count per source platform */
  sourceCounts: Record<string, number>;
  /** Whether the queue is considered stale (any items > 7 days) */
  isStale: boolean;
}

/**
 * Calculate health metrics for the triage queue based on pending items.
 */
export async function getTriageQueueHealth(): Promise<QueueHealthMetrics> {
  const nowMs = Date.now();

  // Fetch all pending items (only the fields we need)
  const pendingItems = await db
    .select({
      capturedAt: triageItems.capturedAt,
      sourcePlatform: triageItems.sourcePlatform,
    })
    .from(triageItems)
    .where(eq(triageItems.status, 'pending'));

  if (pendingItems.length === 0) {
    return {
      totalPending: 0,
      over24h: 0,
      over3d: 0,
      over7d: 0,
      over14d: 0,
      oldestAgeHours: null,
      averageAgeHours: 0,
      sourceCounts: {},
      isStale: false,
    };
  }

  const MS_PER_HOUR = 1000 * 60 * 60;
  const HOURS_24 = 24;
  const HOURS_3D = 72;
  const HOURS_7D = 168;
  const HOURS_14D = 336;

  let over24h = 0;
  let over3d = 0;
  let over7d = 0;
  let over14d = 0;
  let oldestAgeHours = 0;
  let totalAgeHours = 0;
  const sourceCounts: Record<string, number> = {};

  for (const item of pendingItems) {
    const capturedMs = new Date(item.capturedAt).getTime();
    const ageHours = (nowMs - capturedMs) / MS_PER_HOUR;

    if (ageHours > HOURS_24) over24h++;
    if (ageHours > HOURS_3D) over3d++;
    if (ageHours > HOURS_7D) over7d++;
    if (ageHours > HOURS_14D) over14d++;

    if (ageHours > oldestAgeHours) oldestAgeHours = ageHours;
    totalAgeHours += ageHours;

    const platform = item.sourcePlatform;
    sourceCounts[platform] = (sourceCounts[platform] || 0) + 1;
  }

  return {
    totalPending: pendingItems.length,
    over24h,
    over3d,
    over7d,
    over14d,
    oldestAgeHours: Math.round(oldestAgeHours),
    averageAgeHours: Math.round(totalAgeHours / pendingItems.length),
    sourceCounts,
    isStale: over7d > 0,
  };
}
