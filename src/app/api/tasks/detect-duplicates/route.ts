import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

const MAX_GLOBAL_COMPARISONS = 100_000;
const YIELD_EVERY_COMPARISONS = 1_000;

function pairCount(itemCount: number): number {
  return itemCount * (itemCount - 1) / 2;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Compute a Levenshtein-distance–based similarity score (0–1) between two strings.
 * Returns 1.0 for identical strings and approaches 0 for completely different ones.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const la = a.length;
  const lb = b.length;
  const dp: number[] = Array(lb + 1)
    .fill(0)
    .map((_, i) => i);

  for (let i = 1; i <= la; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= lb; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }

  const maxLen = Math.max(la, lb);
  return (maxLen - dp[lb]) / maxLen;
}

/** Normalise a task title for comparison: lowercase, collapse whitespace, strip punctuation */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface DuplicateGroup {
  /** The "canonical" task — the oldest/first one */
  canonical: { id: string; title: string; status: string; sourceId: string; connectorType: string };
  /** Potential duplicates of the canonical task */
  duplicates: Array<{ id: string; title: string; status: string; sourceId: string; connectorType: string; score: number; reasoning: string }>;
}

/**
 * GET /api/tasks/detect-duplicates
 *
 * Scans all non-cancelled/done tasks for potential duplicates based on title similarity.
 *
 * Query params:
 *   - taskId: optional — if provided, only find duplicates for that specific task
 *   - threshold: similarity threshold 0–1 (default 0.85)
 *   - includeClosedTasks: if "true", also consider completed/cancelled tasks
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const targetTaskId = searchParams.get('taskId');
    const threshold = Math.min(1, Math.max(0, parseFloat(searchParams.get('threshold') ?? '0.85')));
    const includeClosedTasks = searchParams.get('includeClosedTasks') === 'true';

    const { taskReads } = await getTaskCorePersistence();
    const allTasks = await taskReads.listDuplicateDetectionTasks({ includeClosedTasks });

    if (targetTaskId) {
      // Only find duplicates for this specific task
      const [target] = allTasks.filter((t) => t.id === targetTaskId);
      if (!target) return ApiErrors.notFound('Task');

      const normalizedTarget = normalizeTitle(target.title);
      const candidates = allTasks
        .filter((t) => t.id !== targetTaskId)
        .map((t) => {
          const score = similarity(normalizedTarget, normalizeTitle(t.title));
          return { ...t, score };
        })
        .filter((t) => t.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          sourceId: t.sourceId,
          connectorType: t.connectorType,
          score: t.score,
          reasoning:
            t.score === 1
              ? 'Exact title match — almost certainly a duplicate.'
              : `Title similarity ${Math.round(t.score * 100)}% — may be the same task.`,
        }));

      return NextResponse.json({ taskId: targetTaskId, duplicates: candidates });
    }

    // Scan all pairs for duplicates
    const comparisons = pairCount(allTasks.length);
    if (comparisons > MAX_GLOBAL_COMPARISONS) {
      return ApiErrors.validation(
        `Global duplicate detection would require ${comparisons.toLocaleString()} comparisons `
        + `across ${allTasks.length.toLocaleString()} tasks. Provide taskId to run a bounded scan.`,
      );
    }

    const groups: DuplicateGroup[] = [];
    const visited = new Set<string>();
    let comparisonsSinceYield = 0;

    // Sort by createdAt so the canonical task is always the oldest
    const sorted = allTasks
      .map((task) => ({ ...task, normalizedTitle: normalizeTitle(task.title) }))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    for (let i = 0; i < sorted.length; i++) {
      if (visited.has(sorted[i].id)) continue;
      const dupes: DuplicateGroup['duplicates'] = [];

      for (let j = i + 1; j < sorted.length; j++) {
        if (visited.has(sorted[j].id)) continue;
        const score = similarity(sorted[i].normalizedTitle, sorted[j].normalizedTitle);
        comparisonsSinceYield++;
        if (comparisonsSinceYield >= YIELD_EVERY_COMPARISONS) {
          comparisonsSinceYield = 0;
          await yieldToEventLoop();
        }
        if (score >= threshold) {
          dupes.push({
            id: sorted[j].id,
            title: sorted[j].title,
            status: sorted[j].status,
            sourceId: sorted[j].sourceId,
            connectorType: sorted[j].connectorType,
            score,
            reasoning:
              score === 1
                ? 'Exact title match — almost certainly a duplicate.'
                : `Title similarity ${Math.round(score * 100)}% — may be the same task.`,
          });
          visited.add(sorted[j].id);
        }
      }

      if (dupes.length > 0) {
        groups.push({
          canonical: {
            id: sorted[i].id,
            title: sorted[i].title,
            status: sorted[i].status,
            sourceId: sorted[i].sourceId,
            connectorType: sorted[i].connectorType,
          },
          duplicates: dupes,
        });
        visited.add(sorted[i].id);
      }
    }

    return NextResponse.json({ groups, totalGroups: groups.length });
  } catch (error) {
    return ApiErrors.internal('Failed to detect duplicates', error);
  }
}
