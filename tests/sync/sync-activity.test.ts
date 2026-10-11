import { describe, expect, it } from 'vitest';
import {
  hasSyncActivity,
  mergeSyncActivity,
  normalizeSyncActivity,
  type SyncActivityPayload,
} from '@/lib/sync/activity';

describe('sync activity payload', () => {
  const domainActivity: SyncActivityPayload = {
    version: 1,
    groups: [{
      key: 'transactions',
      label: 'Data synchronized',
      category: 'data',
      metrics: [{
        key: 'transactions-processed',
        label: 'transactions synchronized',
        value: 10,
        kind: 'processed',
      }],
    }],
  };

  it('normalizes a versioned connector-neutral payload', () => {
    expect(normalizeSyncActivity(domainActivity)).toEqual(domainActivity);
    expect(hasSyncActivity(domainActivity)).toBe(true);
  });

  it('does not treat a snapshot total as a per-run change', () => {
    expect(hasSyncActivity({
      version: 1,
      groups: [{
        key: 'snapshot',
        label: 'Snapshot',
        category: 'data',
        metrics: [{
          key: 'total',
          label: 'records in snapshot',
          value: 10,
          kind: 'snapshot',
        }],
      }],
    })).toBe(false);
  });

  it('rejects malformed and unsupported payloads safely', () => {
    expect(normalizeSyncActivity(null)).toBeNull();
    expect(normalizeSyncActivity({ version: 2, groups: [] })).toBeNull();
    expect(normalizeSyncActivity({
      version: 1,
      groups: [{
        key: 'invalid',
        label: 'Invalid',
        category: 'data',
        metrics: [{
          key: 'negative',
          label: 'records',
          value: -1,
          kind: 'processed',
        }],
      }],
    })).toBeNull();
  });

  it('merges connector phases and preserves partial status', () => {
    expect(mergeSyncActivity(
      domainActivity,
      {
        version: 1,
        status: 'partial',
        groups: [{
          key: 'review',
          label: 'Review activity',
          category: 'attention',
          metrics: [],
        }],
      },
    )).toMatchObject({
      version: 1,
      status: 'partial',
      groups: [
        { key: 'transactions' },
        { key: 'review' },
      ],
    });
  });
});
