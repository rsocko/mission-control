import { describe, expect, it } from 'vitest';
import {
  createScoutIngestResult,
  mergeScoutMetadata,
} from '@/lib/connectors/scout/ingest-contract';

describe('Scout ingest contract', () => {
  it('updates Scout-owned provenance while preserving Mission Control metadata', () => {
    const merged = mergeScoutMetadata({
      sourceType: 'teams',
      scoutContext: { extractedAt: '2026-08-01T00:00:00.000Z' },
      confidence: 0.4,
      missionControl: { pinned: true },
      workflowState: { reviewedBy: 'user-1' },
    }, {
      sourceType: 'email',
      confidence: 0.9,
      context: {
        extractedAt: '2026-08-05T12:00:00.000Z',
        reasoning: 'Direct request',
        relatedSourceIds: ['message-2'],
      },
    }, '2026-08-05T13:00:00.000Z');

    expect(merged).toMatchObject({
      sourceType: 'email',
      confidence: 0.9,
      scoutContext: {
        confidence: 0.9,
        extractedAt: '2026-08-05T12:00:00.000Z',
        reasoning: 'Direct request',
        relatedSourceIds: ['message-2'],
      },
      missionControl: { pinned: true },
      workflowState: { reviewedBy: 'user-1' },
    });
  });

  it('rejects malformed stored metadata instead of replacing it', () => {
    expect(() => mergeScoutMetadata('[]', {
      sourceType: 'email',
    }, '2026-08-05T13:00:00.000Z')).toThrow('Task metadata must be a JSON object');
  });

  it('clears stale top-level confidence when the new observation omits it', () => {
    const merged = mergeScoutMetadata({
      confidence: 0.9,
      missionControl: { pinned: true },
    }, {
      sourceType: 'email',
    }, '2026-08-05T13:00:00.000Z');

    expect(merged).not.toHaveProperty('confidence');
    expect(merged).toMatchObject({ missionControl: { pinned: true } });
  });

  it('always emits stable field-report arrays', () => {
    expect(createScoutIngestResult({
      sourceId: 'scout:email:1',
      mcTaskId: null,
      action: 'suppressed',
      reason: 'ingest_tombstone',
    })).toEqual({
      sourceId: 'scout:email:1',
      mcTaskId: null,
      action: 'suppressed',
      reason: 'ingest_tombstone',
      appliedFields: [],
      preservedOverrides: [],
      unchangedFields: [],
    });
  });
});
