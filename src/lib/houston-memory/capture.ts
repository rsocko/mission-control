import { aiLogger } from '@/lib/logger';
import { generateMinimizedHoustonSummary, houstonSummaryCaptureSchema } from './summary';
import { getHoustonMemorySettings } from './settings';
import { inspectHoustonMemory, upsertHoustonMemory } from './service';

export type HoustonMemoryCaptureResult =
  | { status: 'captured' }
  | { status: 'skipped'; reason: 'disabled' | 'excluded' };

export async function captureHoustonMemory(input: unknown): Promise<HoustonMemoryCaptureResult> {
  const parsed = houstonSummaryCaptureSchema.parse(input);
  const settings = await getHoustonMemorySettings();
  if (!settings.enabled) return { status: 'skipped', reason: 'disabled' };

  const existing = await inspectHoustonMemory(parsed.conversationId);
  if (existing?.excludedAt) return { status: 'skipped', reason: 'excluded' };

  const summary = await generateMinimizedHoustonSummary(parsed);
  const now = new Date();
  const retainUntil = new Date(
    now.getTime() + settings.retentionDays * 24 * 60 * 60 * 1_000,
  ).toISOString();
  await upsertHoustonMemory({
    id: parsed.conversationId,
    ...summary,
    sensitivity: 'restricted',
    retainUntil,
    now: now.toISOString(),
  });
  aiLogger.info({
    event: 'houston_memory_captured',
    decisionCount: summary.decisions.length,
    commitmentCount: summary.commitments.length,
    linkedEntityCount: summary.linkedEntities.length,
  }, 'Houston minimized memory captured');
  return { status: 'captured' };
}
