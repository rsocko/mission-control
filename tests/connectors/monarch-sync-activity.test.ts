import { describe, expect, it } from 'vitest';
import {
  financeAttentionSyncActivity,
  financeReferenceSyncActivity,
} from '@/lib/connectors/monarch-money/sync-activity';

describe('Tyrion sync activity metrics', () => {
  it('keeps exact reference-data deltas semantically distinct', () => {
    const activity = financeReferenceSyncActivity({
      itemsAdded: 3,
      itemsUpdated: 2,
      itemsRemoved: 1,
    });

    expect(activity.groups[0]?.metrics).toEqual([
      expect.objectContaining({ value: 3, kind: 'created' }),
      expect.objectContaining({ value: 2, kind: 'updated' }),
      expect.objectContaining({ value: 1, kind: 'removed' }),
    ]);
  });

  it('reports review routing and user-facing work outcomes without identities', () => {
    const activity = financeAttentionSyncActivity({
      evaluated: 10,
      notificationsCreated: 2,
      notificationsUpdated: 3,
      tasksCreated: 1,
      tasksUpdated: 1,
      tasksSettled: 1,
      taskPromoted: 1,
      autoIncluded: 0,
      deferred: 4,
      settled: 2,
      stalePreserved: 0,
      statusOnly: 0,
      deliveriesReceived: 0,
      deliveriesApplied: 0,
      deliveriesReplayed: 0,
      deliveriesOutOfOrder: 0,
    }, 'complete');

    expect(activity.groups).toEqual([
      expect.objectContaining({
        category: 'attention',
        metrics: expect.arrayContaining([
          expect.objectContaining({ key: 'attention-evaluated', value: 10, kind: 'processed' }),
          expect.objectContaining({ key: 'attention-created', value: 2, kind: 'created' }),
          expect.objectContaining({ key: 'attention-updated', value: 3, kind: 'updated' }),
          expect.objectContaining({ key: 'attention-resolved', value: 2, kind: 'resolved' }),
        ]),
      }),
      expect.objectContaining({
        category: 'work',
        metrics: expect.arrayContaining([
          expect.objectContaining({ key: 'attention-tasks-created', value: 1, kind: 'created' }),
          expect.objectContaining({ key: 'attention-tasks-resolved', value: 1, kind: 'resolved' }),
        ]),
      }),
    ]);
    expect(JSON.stringify(activity)).not.toMatch(/account|transactionId|merchant|sourceRef/);
  });
});
