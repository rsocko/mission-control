import { describe, expect, it } from 'vitest';
import {
  AI_CONTEXT_MAX_CHARACTERS,
  applyAIContextCharacterBudget,
} from '@/lib/ai/context-budget';

describe('AI context character budget', () => {
  it('preserves context inside the budget', () => {
    expect(applyAIContextCharacterBudget('short context', 'test')).toBe('short context');
  });

  it('truncates oversized context deterministically', () => {
    const result = applyAIContextCharacterBudget(
      'x'.repeat(AI_CONTEXT_MAX_CHARACTERS + 100),
      'test',
    );

    expect(result).toHaveLength(AI_CONTEXT_MAX_CHARACTERS - 4);
    expect(result.endsWith('[Context truncated]')).toBe(true);
  });
});
