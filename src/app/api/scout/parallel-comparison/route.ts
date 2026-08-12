import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, taskLinkedSources } from '@/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { computeSimilarity } from '@/lib/dedup';

/**
 * GET /api/scout/parallel-comparison
 *
 * Evaluates redundancy between Scout email extraction and the outlook-email connector.
 * Runs a comparison to help decide whether the business outlook-email connector can be retired.
 *
 * Returns:
 * - Scout-only items (items Scout found that outlook-email didn't)
 * - Outlook-only items (items outlook-email found that Scout didn't)
 * - Overlapping items (both found, with similarity scores)
 * - Coverage stats
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const since = searchParams.get('since') || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch Scout email tasks created since the comparison window
  const scoutEmailTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      sourceId: tasks.sourceId,
      createdAt: tasks.createdAt,
      priority: tasks.priority,
      status: tasks.status,
      metadata: tasks.metadata,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.connectorType, 'scout'),
        gte(tasks.createdAt, since),
      )
    );

  // Filter to email-sourced Scout tasks only
  const scoutEmails = scoutEmailTasks.filter(t => {
    try {
      const meta = JSON.parse(t.metadata as string || '{}');
      return meta.sourceType === 'email';
    } catch {
      return t.sourceId?.startsWith('scout:email:');
    }
  });

  // Fetch outlook-email connector tasks created in the same window
  const outlookEmailTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      sourceId: tasks.sourceId,
      createdAt: tasks.createdAt,
      priority: tasks.priority,
      status: tasks.status,
      metadata: tasks.metadata,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.connectorType, 'outlook-email'),
        gte(tasks.createdAt, since),
      )
    );

  // Fetch linked sources to find already-linked pairs
  const linkedPairs = await db
    .select({
      taskId: taskLinkedSources.taskId,
      sourceId: taskLinkedSources.sourceId,
      connectorType: taskLinkedSources.connectorType,
    })
    .from(taskLinkedSources);

  // Build overlap analysis via fuzzy matching
  const overlapping: Array<{
    scoutId: string;
    scoutTitle: string;
    outlookId: string;
    outlookTitle: string;
    similarity: number;
    alreadyLinked: boolean;
  }> = [];

  const matchedScoutIds = new Set<string>();
  const matchedOutlookIds = new Set<string>();

  for (const scout of scoutEmails) {
    let bestMatch: { outlookId: string; outlookTitle: string; similarity: number } | null = null;

    for (const outlook of outlookEmailTasks) {
      const sim = computeSimilarity(scout.title, outlook.title);
      if (sim >= 0.70 && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { outlookId: outlook.id, outlookTitle: outlook.title, similarity: sim };
      }
    }

    if (bestMatch) {
      const alreadyLinked = linkedPairs.some(
        lp => (lp.taskId === bestMatch!.outlookId && lp.sourceId === scout.sourceId) ||
              (lp.taskId === scout.id && lp.connectorType === 'outlook-email')
      );

      overlapping.push({
        scoutId: scout.id,
        scoutTitle: scout.title,
        outlookId: bestMatch.outlookId,
        outlookTitle: bestMatch.outlookTitle,
        similarity: Math.round(bestMatch.similarity * 100) / 100,
        alreadyLinked,
      });

      matchedScoutIds.add(scout.id);
      matchedOutlookIds.add(bestMatch.outlookId);
    }
  }

  const scoutOnly = scoutEmails
    .filter(t => !matchedScoutIds.has(t.id))
    .map(t => ({ id: t.id, title: t.title, createdAt: t.createdAt, priority: t.priority }));

  const outlookOnly = outlookEmailTasks
    .filter(t => !matchedOutlookIds.has(t.id))
    .map(t => ({ id: t.id, title: t.title, createdAt: t.createdAt, priority: t.priority }));

  const totalUnique = scoutOnly.length + outlookOnly.length + overlapping.length;

  return NextResponse.json({
    comparisonWindow: { since, until: new Date().toISOString() },
    stats: {
      scoutEmailTotal: scoutEmails.length,
      outlookEmailTotal: outlookEmailTasks.length,
      overlapping: overlapping.length,
      scoutOnly: scoutOnly.length,
      outlookOnly: outlookOnly.length,
      scoutCoverage: totalUnique > 0 ? Math.round(((overlapping.length + scoutOnly.length) / totalUnique) * 100) : 0,
      outlookCoverage: totalUnique > 0 ? Math.round(((overlapping.length + outlookOnly.length) / totalUnique) * 100) : 0,
      redundancyRate: totalUnique > 0 ? Math.round((overlapping.length / totalUnique) * 100) : 0,
    },
    recommendation: getRecommendation(scoutEmails.length, outlookEmailTasks.length, overlapping.length, scoutOnly.length, outlookOnly.length),
    overlapping,
    scoutOnly: scoutOnly.slice(0, 50),
    outlookOnly: outlookOnly.slice(0, 50),
  });
}

function getRecommendation(
  scoutTotal: number,
  outlookTotal: number,
  overlap: number,
  scoutOnly: number,
  outlookOnly: number,
): { action: string; reason: string; confidence: string } {
  if (scoutTotal === 0) {
    return {
      action: 'keep_outlook',
      reason: 'Scout has not pushed any email-sourced items yet. Cannot evaluate.',
      confidence: 'low',
    };
  }

  if (outlookTotal === 0) {
    return {
      action: 'scout_sufficient',
      reason: 'No outlook-email tasks in comparison window. Scout is the only source.',
      confidence: 'low',
    };
  }

  const scoutCoverage = (overlap + scoutOnly) / (overlap + scoutOnly + outlookOnly);

  if (scoutCoverage >= 0.95 && outlookOnly <= 2) {
    return {
      action: 'retire_outlook_email',
      reason: `Scout covers ${Math.round(scoutCoverage * 100)}% of actionable emails. Only ${outlookOnly} items found exclusively by outlook-email.`,
      confidence: 'high',
    };
  }

  if (scoutCoverage >= 0.80) {
    return {
      action: 'continue_parallel',
      reason: `Scout covers ${Math.round(scoutCoverage * 100)}% but ${outlookOnly} items are outlook-only. Continue parallel run for more data.`,
      confidence: 'medium',
    };
  }

  return {
    action: 'keep_both',
    reason: `Scout coverage is ${Math.round(scoutCoverage * 100)}%, meaning ${outlookOnly} actionable items would be missed. Keep both connectors.`,
    confidence: 'medium',
  };
}
