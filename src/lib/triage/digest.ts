/**
 * Triage Digest Generator
 *
 * Produces daily/weekly summaries of triage queue activity:
 * - New items ingested (count by source)
 * - Items actioned (count by action type)
 * - Current queue depth
 * - Stale items warning
 * - Top pending suggestions awaiting action
 */
import db from '@/db';
import { triageItems } from '@/db/schema';
import { sql, and, eq, gte, desc } from 'drizzle-orm';
import logger from '@/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DigestPayload {
  period: 'daily' | 'weekly';
  generatedAt: string;
  newItems: { total: number; bySource: Record<string, number> };
  actioned: { total: number; byAction: Record<string, number> };
  queueDepth: number;
  staleCount: number;
  topPending: Array<{ id: string; title: string; age: string; suggestion?: string }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPeriodStart(period: 'daily' | 'weekly'): string {
  const now = new Date();
  const msBack = period === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - msBack).toISOString();
}

function formatAge(capturedAt: string): string {
  const ms = Date.now() - new Date(capturedAt).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ─── Digest Generation ──────────────────────────────────────────────────────

export async function generateTriageDigest(period: 'daily' | 'weekly'): Promise<DigestPayload> {
  const periodStart = getPeriodStart(period);
  const now = new Date().toISOString();

  // New items ingested in period (by source)
  const newItemRows = await db
    .select({
      sourcePlatform: triageItems.sourcePlatform,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(triageItems)
    .where(gte(triageItems.ingestedAt, periodStart))
    .groupBy(triageItems.sourcePlatform);

  const bySource: Record<string, number> = {};
  let totalNew = 0;
  for (const row of newItemRows) {
    bySource[row.sourcePlatform] = row.count;
    totalNew += row.count;
  }

  // Items actioned in period
  // actioned = status is 'actioned' or 'dismissed' and was updated in period
  // We check items whose status changed in the period by looking at actionsTaken array
  const actionedRows = await db
    .select({
      status: triageItems.status,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(triageItems)
    .where(
      and(
        sql`${triageItems.status} IN ('actioned', 'dismissed')`,
        gte(triageItems.ingestedAt, periodStart),
      ),
    )
    .groupBy(triageItems.status);

  const byAction: Record<string, number> = {};
  let totalActioned = 0;
  for (const row of actionedRows) {
    byAction[row.status] = row.count;
    totalActioned += row.count;
  }

  // Current queue depth (pending items)
  const [depthResult] = await db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(triageItems)
    .where(eq(triageItems.status, 'pending'));
  const queueDepth = depthResult?.count ?? 0;

  // Stale items (pending > 7 days old)
  const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [staleResult] = await db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(triageItems)
    .where(
      and(
        eq(triageItems.status, 'pending'),
        sql`${triageItems.capturedAt} < ${staleThreshold}`,
      ),
    );
  const staleCount = staleResult?.count ?? 0;

  // Top pending items (oldest first, up to 10)
  const topPendingRows = await db
    .select({
      id: triageItems.id,
      title: triageItems.title,
      capturedAt: triageItems.capturedAt,
      aiSuggestedActions: triageItems.aiSuggestedActions,
    })
    .from(triageItems)
    .where(eq(triageItems.status, 'pending'))
    .orderBy(triageItems.capturedAt)
    .limit(10);

  const topPending = topPendingRows.map((row) => {
    const suggestions = Array.isArray(row.aiSuggestedActions) ? row.aiSuggestedActions : [];
    const firstSuggestion = suggestions[0];
    return {
      id: row.id,
      title: row.title,
      age: formatAge(row.capturedAt),
      suggestion: typeof firstSuggestion === 'object' && firstSuggestion !== null
        ? (firstSuggestion as { action?: string }).action
        : typeof firstSuggestion === 'string' ? firstSuggestion : undefined,
    };
  });

  const digest: DigestPayload = {
    period,
    generatedAt: now,
    newItems: { total: totalNew, bySource },
    actioned: { total: totalActioned, byAction },
    queueDepth,
    staleCount,
    topPending,
  };

  logger.info({ period, queueDepth, totalNew, totalActioned, staleCount }, 'Triage digest generated');
  return digest;
}

// ─── Digest Delivery ────────────────────────────────────────────────────────

export async function sendDigestWebhook(digest: DigestPayload): Promise<{ sent: boolean; error?: string }> {
  const webhookUrl = process.env.MC_DIGEST_WEBHOOK_URL;
  if (!webhookUrl) {
    return { sent: false, error: 'MC_DIGEST_WEBHOOK_URL not configured' };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'triage_digest',
        ...digest,
        // Format a readable summary for webhook consumers
        summary: formatDigestSummary(digest),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { sent: false, error: `Webhook returned ${response.status}: ${text.slice(0, 200)}` };
    }

    logger.info({ period: digest.period, webhookUrl }, 'Digest webhook sent');
    return { sent: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, webhookUrl }, 'Failed to send digest webhook');
    return { sent: false, error: errorMsg };
  }
}

function formatDigestSummary(digest: DigestPayload): string {
  const lines: string[] = [
    `📋 Triage ${digest.period} digest — ${new Date(digest.generatedAt).toLocaleDateString()}`,
    '',
    `**New items:** ${digest.newItems.total}`,
  ];

  if (Object.keys(digest.newItems.bySource).length > 0) {
    const sourceParts = Object.entries(digest.newItems.bySource)
      .map(([src, count]) => `${src}: ${count}`)
      .join(', ');
    lines.push(`  Sources: ${sourceParts}`);
  }

  lines.push(`**Actioned:** ${digest.actioned.total}`);
  lines.push(`**Queue depth:** ${digest.queueDepth}`);

  if (digest.staleCount > 0) {
    lines.push(`⚠️ **Stale items:** ${digest.staleCount} items pending > 7 days`);
  }

  if (digest.topPending.length > 0) {
    lines.push('', '**Top pending:**');
    for (const item of digest.topPending.slice(0, 5)) {
      const suffix = item.suggestion ? ` → ${item.suggestion}` : '';
      lines.push(`  • ${item.title} (${item.age})${suffix}`);
    }
  }

  return lines.join('\n');
}
