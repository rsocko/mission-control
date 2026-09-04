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
import logger from '@/lib/logger';
import { getTriagePersistenceRepositories } from './persistence';

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
  const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const snapshot = await getTriagePersistenceRepositories().health.getDigestSnapshot({
    periodStart,
    staleBeforeAt: staleThreshold,
    topPendingLimit: 10,
  });
  const totalNew = Object.values(snapshot.newItemsBySource)
    .reduce((sum, count) => sum + count, 0);
  const totalActioned = Object.values(snapshot.actionedByStatus)
    .reduce((sum, count) => sum + count, 0);

  const topPending = snapshot.topPending.map((row) => {
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
    newItems: { total: totalNew, bySource: snapshot.newItemsBySource },
    actioned: { total: totalActioned, byAction: snapshot.actionedByStatus },
    queueDepth: snapshot.queueDepth,
    staleCount: snapshot.staleCount,
    topPending,
  };

  logger.info({
    period,
    queueDepth: snapshot.queueDepth,
    totalNew,
    totalActioned,
    staleCount: snapshot.staleCount,
  }, 'Triage digest generated');
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
