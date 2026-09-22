import { aiLogger } from '@/lib/logger';
import type {
  AIDigestSnapshot,
  AIDigestTask,
} from '@/db/persistence/ai-workflows';
import { getAIWorkflowPersistence } from './workflow-persistence';

export const AI_CONTEXT_ROWS_PER_CATEGORY = 5;
export const AI_CONTEXT_MAX_CHARACTERS = 6_000;

export type AIContextTask = AIDigestTask;
export type AIContextSnapshot = AIDigestSnapshot;

export async function loadAIContextSnapshot(today: string): Promise<AIContextSnapshot> {
  return (await getAIWorkflowPersistence()).context.loadDigestSnapshot({
    today,
    now: new Date().toISOString(),
    rowsPerCategory: AI_CONTEXT_ROWS_PER_CATEGORY,
  });
}

export function applyAIContextCharacterBudget(context: string, featureId: string): string {
  const bounded = context.length <= AI_CONTEXT_MAX_CHARACTERS
    ? context
    : `${context.slice(0, AI_CONTEXT_MAX_CHARACTERS - 24)}\n[Context truncated]`;
  aiLogger.info({
    event: 'ai_context_built',
    featureId,
    contextCharacters: bounded.length,
    contextTruncated: bounded.length < context.length,
  }, 'Built bounded AI context');
  return bounded;
}
