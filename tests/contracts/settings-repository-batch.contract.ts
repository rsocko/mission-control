import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistenceJson } from '@/db/persistence/contracts';
import type {
  ActiveEmbeddingIdentity,
  AtomicSettingsRepository,
} from '@/db/persistence/core-repositories';

export interface SettingsRepositoryBatchHarness {
  repository: AtomicSettingsRepository;
  concurrentRepository: AtomicSettingsRepository;
  freshRepository(): AtomicSettingsRepository;
  forceRollback(firstKey: string, failureKey: string): Promise<void>;
  ensureActiveEmbeddingIdentity(): Promise<ActiveEmbeddingIdentity>;
  close(): Promise<void>;
}

export function describeSettingsRepositoryBatchContract(
  name: string,
  createHarness: () => Promise<SettingsRepositoryBatchHarness>,
): void {
  describe(`${name} SettingsRepository batch contract`, () => {
    let harness: SettingsRepositoryBatchHarness;
    const prefix = `settings-batch-${randomUUID()}`;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('round trips a complete multi-key snapshot and repeated saves idempotently', async () => {
      const first = `${prefix}-first`;
      const second = `${prefix}-second`;
      await expect(harness.repository.getMany([first, second])).resolves.toEqual({
        [first]: null,
        [second]: null,
      });

      const entries: ReadonlyArray<readonly [string, PersistenceJson]> = [
        [first, { provider: 'ollama', enabled: true }],
        [second, { allowedRoutes: ['ollama'], version: 2 }],
      ];
      await harness.repository.setMany(entries);
      await harness.repository.setMany(entries);

      await expect(harness.repository.getMany([first, second])).resolves.toEqual({
        [first]: { provider: 'ollama', enabled: true },
        [second]: { allowedRoutes: ['ollama'], version: 2 },
      });
    });

    it('never exposes a torn pair during concurrent last-commit-wins saves', async () => {
      const first = `${prefix}-concurrent-first`;
      const second = `${prefix}-concurrent-second`;
      await harness.repository.setMany([[first, 'initial'], [second, 'initial']]);

      const writes = Array.from({ length: 20 }, (_, index) => {
        const value = index % 2 === 0 ? 'alpha' : 'beta';
        const repository = index % 2 === 0
          ? harness.repository
          : harness.concurrentRepository;
        return repository.setMany([[first, value], [second, value]]);
      });
      const reads = Array.from({ length: 20 }, async () => {
        const pair = await harness.concurrentRepository.getMany([first, second]);
        expect(pair[first]).toBe(pair[second]);
      });
      await Promise.all([...writes, ...reads]);

      const finalPair = await harness.freshRepository().getMany([first, second]);
      expect(finalPair[first]).toBe(finalPair[second]);
      expect(['alpha', 'beta']).toContain(finalPair[first]);
    });

    it('rolls back the complete pair when one entry fails', async () => {
      const first = `${prefix}-rollback-first`;
      const failure = `${prefix}-rollback-failure`;
      await harness.repository.setMany([[first, 'before'], [failure, 'before']]);

      await expect(harness.forceRollback(first, failure)).rejects.toThrow();

      await expect(harness.freshRepository().getMany([first, failure])).resolves.toEqual({
        [first]: 'before',
        [failure]: 'before',
      });
    });

    it('rejects duplicate keys consistently instead of applying backend-specific ordering', async () => {
      const key = `${prefix}-duplicate`;
      await expect(harness.repository.setMany([[key, 'first'], [key, 'second']]))
        .rejects.toThrow('Settings batch keys must be unique');
      await expect(harness.repository.get(key)).resolves.toBeNull();
    });

    it('recovers committed settings and the active embedding identity through a fresh adapter', async () => {
      const key = `${prefix}-recovery`;
      await harness.repository.setMany([[key, { committed: true }]]);
      await expect(harness.freshRepository().get(key)).resolves.toEqual({ committed: true });

      const expected = await harness.ensureActiveEmbeddingIdentity();
      await expect(harness.freshRepository().getActiveEmbeddingIdentity())
        .resolves.toEqual(expected);
    });
  });
}
