import { describe, expect, it, vi } from 'vitest';
import {
  InvalidIdeationExpansionError,
  normalizeIdeationExpansionOutput,
} from '@/lib/ai/ideation-expand';

describe('normalizeIdeationExpansionOutput', () => {
  it('removes model and existing-child duplicates while preserving valid proposals', () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `proposal-${Math.random()}`) });

    const result = normalizeIdeationExpansionOutput({
      proposals: [
        { label: 'Research users', rationale: 'Understand needs.' },
        { label: ' research   users ', rationale: 'Duplicate.' },
        { label: 'Map constraints', rationale: 'Find boundaries.' },
        { label: 'Prototype flow', rationale: 'Test the approach.' },
        { label: 'Plan rollout', rationale: 'Prepare delivery.' },
      ],
    }, ['Existing child']);

    expect(result.map((proposal) => proposal.label)).toEqual([
      'Research users',
      'Map constraints',
      'Prototype flow',
      'Plan rollout',
    ]);
  });

  it('rejects empty or insufficient unique model output', () => {
    expect(() => normalizeIdeationExpansionOutput({ proposals: [] }, [])).toThrow(
      InvalidIdeationExpansionError,
    );
    expect(() => normalizeIdeationExpansionOutput({
      proposals: [
        { label: 'Existing', rationale: 'Duplicate.' },
        { label: 'New one', rationale: 'Only one.' },
        { label: 'New one', rationale: 'Duplicate.' },
      ],
    }, ['Existing'])).toThrow(InvalidIdeationExpansionError);
  });
});
