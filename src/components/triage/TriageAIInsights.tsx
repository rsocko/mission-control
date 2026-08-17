'use client';

import { AlertTriangle, Calendar, Zap } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ACTION_META } from '@/components/triage/types';
import type { TriageActionType, TriageItem } from '@/types';
import { parseLocalDate } from '@/lib/utils/date-format';

interface Insight {
  id: string;
  type: 'time_sensitive' | 'batch_action';
  title: string;
  description: string;
  icon: typeof AlertTriangle;
  iconClass: string;
  action?: { label: string; onClick: () => void };
}

interface TriageAIInsightsProps {
  items: TriageItem[];
  onBatchAction: (itemIds: string[], actionType: TriageActionType) => void;
}

const BATCH_CONFIDENCE_THRESHOLD = 0.8;
const MIN_BATCH_SIZE = 2;

function computeInsights(items: TriageItem[], onBatchAction: (ids: string[], action: TriageActionType) => void): Insight[] {
  const insights: Insight[] = [];
  const pendingItems = items.filter((item) => item.status === 'pending');

  // 1. Time-sensitive items with detected due dates expiring within 7 days
  const timeSensitive = pendingItems.filter((item) => {
    if (item.aiUrgency !== 'time_sensitive') return false;
    const dueDate = item.rawMetadata?.parsedDueDate as string | undefined;
    if (!dueDate) return true; // marked time_sensitive but no specific date — still worth flagging
    const due = parseLocalDate(dueDate);
    if (!due) return true;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysUntil = Math.round((due.getTime() - today.getTime()) / 86400000);
    return daysUntil <= 7 && daysUntil >= -1; // within 7 days or 1 day past
  });

  if (timeSensitive.length > 0) {
    const expiringItem = timeSensitive[0];
    const dueDateStr = expiringItem.rawMetadata?.parsedDueDateLabel as string
      || expiringItem.rawMetadata?.parsedDueDate as string
      || '';
    insights.push({
      id: 'time-sensitive',
      type: 'time_sensitive',
      title: timeSensitive.length === 1
        ? `"${expiringItem.title.slice(0, 40)}${expiringItem.title.length > 40 ? '…' : ''}" is time-sensitive`
        : `${timeSensitive.length} items are time-sensitive`,
      description: dueDateStr ? `Due: ${dueDateStr}` : 'Requires action soon',
      icon: Calendar,
      iconClass: 'text-amber-400',
    });
  }

  // 2. High-confidence batch actions — group items by their top suggestion
  const actionGroups = new Map<TriageActionType, string[]>();
  for (const item of pendingItems) {
    const topSuggestion = item.aiSuggestedActions[0];
    if (!topSuggestion || topSuggestion.confidence < BATCH_CONFIDENCE_THRESHOLD) continue;
    const ids = actionGroups.get(topSuggestion.actionType) || [];
    ids.push(item.id);
    actionGroups.set(topSuggestion.actionType, ids);
  }

  for (const [actionType, itemIds] of actionGroups) {
    if (itemIds.length < MIN_BATCH_SIZE) continue;
    if (actionType === 'dismiss') continue; // don't suggest batch-dismiss as "actionable"
    const meta = ACTION_META[actionType];
    insights.push({
      id: `batch-${actionType}`,
      type: 'batch_action',
      title: `${itemIds.length} items → ${meta.label}`,
      description: `High confidence (${BATCH_CONFIDENCE_THRESHOLD * 100}%+) — batch send?`,
      icon: Zap,
      iconClass: 'text-[var(--accent-400)]',
      action: {
        label: `Send all ${itemIds.length} to ${meta.label}`,
        onClick: () => onBatchAction(itemIds, actionType),
      },
    });
  }

  return insights;
}

export default function TriageAIInsights({ items, onBatchAction }: TriageAIInsightsProps) {
  const insights = computeInsights(items, onBatchAction);

  if (insights.length === 0) return null;

  return (
    <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface-0)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">AI Insights</div>
      <div className="space-y-2">
        {insights.map((insight) => {
          const Icon = insight.icon;
          return (
            <div key={insight.id} className="flex items-start gap-2.5">
              <div className={cn('mt-0.5 shrink-0', insight.iconClass)}>
                <Icon size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--text-primary)]">{insight.title}</div>
                <div className="text-xs text-[var(--text-tertiary)]">{insight.description}</div>
                {insight.action && (
                  <button
                    type="button"
                    onClick={insight.action.onClick}
                    className="mt-1.5 inline-flex items-center gap-1 rounded-[8px] border border-[var(--accent)]/30 bg-[var(--accent-900)]/20 px-2 py-1 text-xs font-medium text-[var(--accent-300)] transition-colors hover:bg-[var(--accent-900)]/40"
                  >
                    {insight.action.label}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
