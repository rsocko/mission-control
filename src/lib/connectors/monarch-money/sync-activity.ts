import type { FinanceAttentionRoutingResult } from '@/db/persistence/finance-attention';
import type { DomainSyncResult } from '@/types';
import {
  SYNC_ACTIVITY_VERSION,
  type SyncActivityPayload,
} from '@/lib/sync/activity';

export function financeReferenceSyncActivity(
  result: Pick<DomainSyncResult, 'itemsAdded' | 'itemsUpdated' | 'itemsRemoved'>,
): SyncActivityPayload {
  return {
    version: SYNC_ACTIVITY_VERSION,
    groups: [{
      key: 'reference-data',
      label: 'Reference data synchronized',
      category: 'data',
      metrics: [
        {
          key: 'reference-records-created',
          label: 'reference records created',
          value: result.itemsAdded,
          kind: 'created',
        },
        {
          key: 'reference-records-updated',
          label: 'reference records updated',
          value: result.itemsUpdated,
          kind: 'updated',
        },
        {
          key: 'reference-records-removed',
          label: 'reference records removed',
          value: result.itemsRemoved,
          kind: 'removed',
        },
      ],
    }],
  };
}

export function financeAttentionSyncActivity(
  result: FinanceAttentionRoutingResult,
  status: SyncActivityPayload['status'],
): SyncActivityPayload {
  return {
    version: SYNC_ACTIVITY_VERSION,
    status,
    groups: [{
      key: 'attention-routing',
      label: 'Review activity',
      category: 'attention',
      metrics: [
        {
          key: 'attention-evaluated',
          label: 'review items evaluated',
          value: result.evaluated,
          kind: 'processed',
        },
        {
          key: 'attention-created',
          label: 'attention summaries created',
          value: result.notificationsCreated,
          kind: 'created',
        },
        {
          key: 'attention-updated',
          label: 'attention summaries updated',
          value: result.notificationsUpdated,
          kind: 'updated',
        },
        {
          key: 'attention-resolved',
          label: 'review items resolved',
          value: result.settled,
          kind: 'resolved',
        },
      ],
    }, {
      key: 'attention-work',
      label: 'User-facing work',
      category: 'work',
      metrics: [
        {
          key: 'attention-tasks-created',
          label: 'Tasks created',
          value: result.tasksCreated,
          kind: 'created',
        },
        {
          key: 'attention-tasks-updated',
          label: 'Tasks updated',
          value: result.tasksUpdated,
          kind: 'updated',
        },
        {
          key: 'attention-tasks-resolved',
          label: 'Tasks resolved',
          value: result.tasksSettled,
          kind: 'resolved',
        },
      ],
    }],
  };
}
