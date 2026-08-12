import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, taskSchedules, appSettings } from '@/db/schema';
import { and, eq, gte, desc } from 'drizzle-orm';
import type { TaskPriority } from '@/types';
import logger from '@/lib/logger';

// ─── Scoring weights ───────────────────────────────────────────────────────
const PRIORITY_SCORE: Record<string, number> = {
  critical: 50,
  high: 35,
  medium: 15,
  low: 5,
  none: 0,
};

// Lists whose completions aren't very celebration-worthy
const LOW_CELEBRATION_PATTERNS = [
  /grocery/i, /groceries/i, /shopping\s*list/i, /to\s*buy/i,
  /packing/i, /packing\s*list/i, /wish\s*list/i,
];

const SNOOZE_SETTINGS_KEY = 'recent-wins-snoozed';
const DEPRIORITIZED_LISTS_KEY = 'recent-wins-deprioritized-lists';

type SnoozeSetting = {
  type: 'day' | 'until-noteworthy';
  until?: string; // ISO date for 'day'
  minCount?: number; // for 'until-noteworthy', how many before showing again
  snoozedAt?: string; // ISO timestamp when snooze was activated
};

/** Deterministic shuffle using a time-based seed that changes every 30 min */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const copy = [...arr];
  let s = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getRotationSeed(): number {
  // Changes every 30 minutes — gives a fresh set of wins periodically
  return Math.floor(Date.now() / (30 * 60 * 1000));
}

function isLowCelebrationList(listName: string | null): boolean {
  if (!listName) return false;
  return LOW_CELEBRATION_PATTERNS.some((p) => p.test(listName));
}

interface ScoredWin {
  id: string;
  title: string;
  priority: TaskPriority;
  connectorType: string;
  sourceListName: string | null;
  completedAt: string | null;
  dueDate: string | null;
  score: number;
  badge: string | null; // contextual label like 'overdue cleared', 'done early'
}

function scoreWin(
  win: { priority: string; completedAt: string | null; dueDate: string | null; sourceListName: string | null; recurrence: string | null },
  deprioritizedLists: string[],
  now: Date
): { score: number; badge: string | null } {
  let score = PRIORITY_SCORE[win.priority] ?? 0;
  let badge: string | null = null;

  const completedDate = win.completedAt ? new Date(win.completedAt) : null;

  // Parse dueDate as a local-midnight date (dueDate is typically "YYYY-MM-DD")
  // Append T23:59:59 so "due on that day" means end-of-day, not midnight start
  const dueDate = win.dueDate ? new Date(win.dueDate + 'T23:59:59') : null;
  const dueDateStr = win.dueDate?.slice(0, 10) ?? null;
  const completedDateStr = completedDate
    ? `${completedDate.getFullYear()}-${String(completedDate.getMonth() + 1).padStart(2, '0')}-${String(completedDate.getDate()).padStart(2, '0')}`
    : null;

  // Overdue items that got completed — extra celebration-worthy
  if (dueDateStr && completedDateStr && completedDateStr > dueDateStr) {
    score += 30;
    badge = 'overdue cleared';
  }

  // Completed early (before due date, at least 1 day before)
  if (dueDate && completedDate && dueDateStr && completedDateStr && completedDateStr < dueDateStr) {
    const daysBefore = (dueDate.getTime() - completedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysBefore >= 1) {
      score += 20;
      badge = 'done early';
    }
  }

  // Due today and completed today — timely completion
  if (dueDateStr && completedDateStr) {
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (dueDateStr === todayStr && completedDateStr === todayStr) {
      score += 15;
      if (!badge) badge = 'on time';
    }
  }

  // Deprioritize low-celebration lists
  if (isLowCelebrationList(win.sourceListName)) {
    score -= 40;
  }

  // Deprioritize recurring/routine tasks — one-off completions are more noteworthy
  if (win.recurrence) {
    score -= 25;
  }

  // Deprioritize user-specified lists
  if (win.sourceListName && deprioritizedLists.some(
    (name) => name.toLowerCase() === (win.sourceListName || '').toLowerCase()
  )) {
    score -= 40;
  }

  return { score, badge };
}

export async function GET() {
  try {
    const now = new Date();

    // ── Check snooze state ──────────────────────────────────────────────────
    const [snoozeRow] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SNOOZE_SETTINGS_KEY));

    if (snoozeRow) {
      const snooze = snoozeRow.value as SnoozeSetting;
      if (snooze.type === 'day' && snooze.until) {
        if (new Date(snooze.until) > now) {
          return NextResponse.json({ totalCount: 0, items: [], groups: [], snoozed: true });
        }
        // Snooze expired — clean it up
        await db.delete(appSettings).where(eq(appSettings.key, SNOOZE_SETTINGS_KEY));
      }
      // 'until-noteworthy' is handled below after we know totalCount
    }

    // ── Load deprioritized lists ────────────────────────────────────────────
    const [deprioritizedRow] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, DEPRIORITIZED_LISTS_KEY));
    const deprioritizedLists: string[] = deprioritizedRow
      ? (deprioritizedRow.value as string[])
      : [];

    // ── Fetch recent completions ────────────────────────────────────────────
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentWins = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        priority: tasks.priority,
        completedAt: tasks.completedAt,
        connectorType: tasks.connectorType,
        sourceListName: tasks.sourceListName,
        dueDate: tasks.dueDate,
        recurrence: taskSchedules.recurrence,
      })
      .from(tasks)
      .leftJoin(taskSchedules, eq(tasks.id, taskSchedules.taskId))
      .where(
        and(
          eq(tasks.status, 'done'),
          gte(tasks.completedAt, sevenDaysAgo.toISOString())
        )
      )
      .orderBy(desc(tasks.completedAt));

    // ── Handle 'until-noteworthy' snooze ────────────────────────────────────
    if (snoozeRow) {
      const snooze = snoozeRow.value as SnoozeSetting;
      if (snooze.type === 'until-noteworthy') {
        const threshold = snooze.minCount ?? 5;
        const snoozedAt = snooze.snoozedAt;
        // Only count wins completed AFTER snooze was set
        const winsSinceSnooze = snoozedAt
          ? recentWins.filter((w) => w.completedAt && w.completedAt > snoozedAt).length
          : recentWins.length;
        if (winsSinceSnooze < threshold) {
          return NextResponse.json({ totalCount: recentWins.length, items: [], groups: [], snoozed: true });
        }
        // Enough new wins — clear snooze and show banner
        await db.delete(appSettings).where(eq(appSettings.key, SNOOZE_SETTINGS_KEY));
      }
    }

    // ── Group by connector + list ───────────────────────────────────────────
    const groups: Record<string, { connectorType: string; listName: string; count: number }> = {};
    for (const win of recentWins) {
      const key = `${win.connectorType}::${win.sourceListName || 'General'}`;
      if (!groups[key]) {
        groups[key] = {
          connectorType: win.connectorType,
          listName: win.sourceListName || 'General',
          count: 0,
        };
      }
      groups[key].count++;
    }

    // ── Score & rank items ──────────────────────────────────────────────────
    // Deduplicate by title — keep only the most recent instance (list is
    // already sorted by completedAt desc) so recurring tasks don't appear twice.
    const seenTitles = new Set<string>();
    const uniqueWins = recentWins.filter((w) => {
      const key = w.title.toLowerCase().trim();
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });

    const scored: ScoredWin[] = uniqueWins.map((w) => {
      const { score, badge } = scoreWin(w, deprioritizedLists, now);
      return {
        id: w.id,
        title: w.title,
        priority: w.priority as TaskPriority,
        connectorType: w.connectorType,
        sourceListName: w.sourceListName,
        completedAt: w.completedAt,
        dueDate: w.dueDate,
        score,
        badge,
      };
    });

    // Sort by score desc, then shuffle within similar score tiers for variety
    scored.sort((a, b) => b.score - a.score);

    // Take top tier (score within 10 points of the best) and rotate them
    const topScore = scored[0]?.score ?? 0;
    const topTierEnd = scored.findIndex((s) => s.score < topScore - 10);
    const topTier = topTierEnd === -1 ? scored : scored.slice(0, topTierEnd);
    const rest = topTierEnd === -1 ? [] : scored.slice(topTierEnd);

    const rotatedTop = seededShuffle(topTier, getRotationSeed());
    const rotated = [...rotatedTop, ...rest];

    // Send up to 6 items (client decides how many to show: 1–3 + counts)
    const MAX_ITEMS = 6;
    const items = rotated.slice(0, MAX_ITEMS).map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      connectorType: s.connectorType,
      sourceListName: s.sourceListName,
      badge: s.badge,
      score: s.score,
    }));

    return NextResponse.json({
      totalCount: recentWins.length,
      groups: Object.values(groups).sort((a, b) => b.count - a.count),
      items,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch recent wins');
    return NextResponse.json({ totalCount: 0, groups: [], items: [] });
  }
}
