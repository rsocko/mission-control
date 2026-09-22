import { describe, expect, it } from 'vitest';
import { projectHoustonSummary } from '@/lib/semantic-index/projections';

describe('Houston semantic projection', () => {
  it('projects only minimized fields and never downgrades sensitivity', () => {
    const document = projectHoustonSummary({
      entityType: 'houston-summary',
      semanticEligible: true,
      id: 'memory-1',
      authorizationScope: 'installation',
      title: 'Release planning',
      summary: 'Use a staged rollout.',
      decisions: ['Ship Friday'],
      commitments: [],
      topics: ['release'],
      linkedEntities: [{ type: 'project', id: 'project-1', label: 'Launch' }],
      sensitivity: 'local-only',
      retainUntil: '2026-06-01T00:00:00.000Z',
      excludedAt: null,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    }, {
      resolveSensitivity: () => 'standard',
    });

    expect(document.sensitivity).toBe('local-only');
    expect(document.retainUntil).toBe('2026-06-01T00:00:00.000Z');
    expect(document.metadata.authorizationScope).toBe('installation');
    expect(JSON.stringify(document)).not.toMatch(/transcript|message|tool.?output|reasoning/i);
    expect(document.metadata.navigationTarget).toBe('/ai?memory=memory-1');
  });
});
