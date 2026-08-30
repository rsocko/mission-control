import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SyncRunRecord,
  SyncRunRepository,
} from '@/db/persistence/worker-repositories';

interface SyncRunRepositoryHarness {
  repository: SyncRunRepository;
  deleteConnectorRuns(connectorId: string): Promise<void> | void;
  close(): Promise<void> | void;
}

function record(
  connectorId: string,
  overrides: Partial<SyncRunRecord> = {},
): SyncRunRecord {
  return {
    id: randomUUID(),
    connectorId,
    success: true,
    tasksAdded: 1,
    tasksUpdated: 2,
    tasksRemoved: 3,
    tasksPushed: 4,
    localOnlyProtected: 6,
    notificationsAdded: 5,
    errors: [],
    details: [{ action: 'contract' }],
    syncedAt: '2026-08-26T00:00:00.000Z',
    durationMs: 100,
    jobId: null,
    identityMode: null,
    identityModeRevision: null,
    ...overrides,
  };
}

export function describeSyncRunRepositoryContract(
  name: string,
  createHarness: () => SyncRunRepositoryHarness | Promise<SyncRunRepositoryHarness>,
): void {
  describe(`${name} SyncRunRepository contract`, () => {
    let harness: SyncRunRepositoryHarness;
    const connectorIds = new Set<string>();

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      for (const connectorId of connectorIds) {
        await harness.deleteConnectorRuns(connectorId);
      }
      connectorIds.clear();
      await harness.close();
    });

    it('returns the newest successful real pull per connector', async () => {
      const connectorId = `contract-sync-run-${randomUUID()}`;
      const secondConnectorId = `contract-sync-run-${randomUUID()}`;
      connectorIds.add(connectorId);
      connectorIds.add(secondConnectorId);

      await harness.repository.append(record(connectorId, {
        success: false,
        syncedAt: '2026-08-26T03:00:00.000Z',
        errors: ['failed'],
      }));
      await harness.repository.append(record(connectorId, {
        durationMs: 0,
        syncedAt: '2026-08-26T02:00:00.000Z',
      }));
      await harness.repository.append(record(connectorId, {
        tasksAdded: 8,
        syncedAt: '2026-08-26T01:00:00.000Z',
      }));
      await harness.repository.append(record(connectorId, {
        tasksAdded: 7,
        syncedAt: '2026-08-26T00:00:00.000Z',
      }));
      await harness.repository.append(record(secondConnectorId, {
        tasksAdded: 9,
      }));

      const baselines = await harness.repository.listLatestSuccessfulPulls();
      expect(baselines.find((entry) => entry.connectorId === connectorId))
        .toMatchObject({
          tasksAdded: 8,
          syncedAt: '2026-08-26T01:00:00.000Z',
          success: true,
        });
      expect(baselines.filter((entry) => entry.connectorId === connectorId))
        .toHaveLength(1);
      expect(baselines.find((entry) => entry.connectorId === secondConnectorId))
        .toMatchObject({ tasksAdded: 9 });
    });
  });
}
