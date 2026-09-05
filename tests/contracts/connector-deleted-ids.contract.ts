import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectorDeletedIdsRepository } from '@/db/persistence/core-repositories';
import type { ConnectorConfig } from '@/types';

interface ConnectorDeletedIdsHarness {
  repository: ConnectorDeletedIdsRepository;
  close(ids: readonly string[]): void | Promise<void>;
}

const connector = (id: string): ConnectorConfig => ({
  id,
  type: 'custom-rest',
  name: id,
  enabled: true,
  syncMode: 'poll',
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: false,
    tagWriteBack: false,
  },
  credentials: {},
  settings: {},
  syncedLists: [],
});

export function describeConnectorDeletedIdsContract(
  name: string,
  createHarness: () => ConnectorDeletedIdsHarness | Promise<ConnectorDeletedIdsHarness>,
): void {
  describe(`${name} ConnectorRepository deleted-ID contract`, () => {
    let harness: ConnectorDeletedIdsHarness;
    const createdIds: string[] = [];

    beforeEach(async () => {
      createdIds.length = 0;
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close(createdIds);
    });

    it('returns only soft-deleted IDs in deterministic binary order and reflects restoration', async () => {
      const suffix = randomUUID();
      const active = connector(`connector-active-${suffix}`);
      const deletedLower = connector(`connector-deleted-a-${suffix}`);
      const deletedUpper = connector(`connector-deleted-A-${suffix}`);
      createdIds.push(active.id, deletedLower.id, deletedUpper.id);
      await harness.repository.upsert(deletedLower);
      await harness.repository.upsert(active);
      await harness.repository.upsert(deletedUpper);

      await expect(harness.repository.listDeletedIds()).resolves.toEqual([]);
      await harness.repository.delete(deletedLower.id);
      await harness.repository.delete(deletedUpper.id);

      await expect(harness.repository.listDeletedIds()).resolves.toEqual([
        deletedUpper.id,
        deletedLower.id,
      ]);

      await harness.repository.upsert(deletedUpper);
      await expect(harness.repository.listDeletedIds()).resolves.toEqual([deletedLower.id]);
    });
  });
}
