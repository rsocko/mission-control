import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { SyncJobRepository } from '@/lib/sync/job-repository';

export interface SyncJobRepositoryContractHarness {
  enabled?: boolean;
  setup(): Promise<void>;
  reset(): Promise<void>;
  teardown(): Promise<void>;
  repository(): SyncJobRepository;
  createConnector(label: string): Promise<string>;
  makeRunnable(jobId: string): Promise<void>;
}

export function runSyncJobRepositoryContract(
  name: string,
  harness: SyncJobRepositoryContractHarness,
): void {
  describe.skipIf(harness.enabled === false)(name, () => {
    beforeAll(() => harness.setup(), 120_000);
    beforeEach(() => harness.reset());
    afterAll(() => harness.teardown());

    it('deduplicates and upgrades a queued connector job', async () => {
      const connectorId = await harness.createConnector('dedupe');
      const repository = harness.repository();
      const first = await repository.enqueue(connectorId);
      const duplicate = await repository.enqueue(connectorId, { full: true });

      expect(duplicate.id).toBe(first.id);
      expect(duplicate.full).toBe(true);
      await expect(repository.countQueued()).resolves.toBe(1);
    });

    it('deduplicates concurrent enqueue requests for one connector', async () => {
      const connectorId = await harness.createConnector('concurrent-dedupe');
      const repository = harness.repository();
      const jobs = await Promise.all(
        Array.from({ length: 4 }, () => repository.enqueue(connectorId)),
      );

      expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
      await expect(repository.countQueued()).resolves.toBe(1);
    });

    it('claims full work first and grants one concurrent owner', async () => {
      const repository = harness.repository();
      const normalConnector = await harness.createConnector('normal');
      const fullConnector = await harness.createConnector('full');
      await repository.enqueue(normalConnector);
      const full = await repository.enqueue(fullConnector, { full: true });

      const first = await repository.claimNext('contract-worker-a', 60_000);
      expect(first?.id).toBe(full.id);
      expect(first?.attempt).toBe(1);

      const competing = await Promise.all([
        repository.claimNext('contract-worker-b', 60_000),
        repository.claimNext('contract-worker-c', 60_000),
      ]);
      expect(competing.filter(Boolean)).toHaveLength(1);
      expect(competing.find(Boolean)?.connectorId).toBe(normalConnector);
    });

    it('fences an earlier attempt reclaimed by the same owner', async () => {
      const repository = harness.repository();
      const connectorId = await harness.createConnector('attempt');
      const queued = await repository.enqueue(connectorId, { maxAttempts: 2 });
      const first = await repository.claimNext('contract-worker', 60_000);
      expect(first?.id).toBe(queued.id);
      await expect(repository.fail(first!, 'contract-worker', 'retry')).resolves.toBe('queued');
      await harness.makeRunnable(queued.id);
      const second = await repository.claimNext('contract-worker', 60_000);
      expect(second?.attempt).toBe(first!.attempt + 1);

      await expect(repository.renewLease(
        first!.id,
        'contract-worker',
        first!.attempt,
        60_000,
      )).resolves.toBe(false);
      await expect(repository.release(
        first!.id,
        'contract-worker',
        first!.attempt,
        'stale release',
      )).resolves.toBe(false);
      await expect(repository.complete(
        first!.id,
        'contract-worker',
        first!.attempt,
        {
          connectorId,
          success: true,
          tasksAdded: 0,
          tasksUpdated: 0,
          tasksRemoved: 0,
          notificationsAdded: 0,
          errors: [],
          syncedAt: new Date().toISOString(),
        },
      )).rejects.toThrow(/ownership was lost/);
      await repository.requestCancellation({ jobId: second!.id });
      await expect(repository.isCancellationRequested(
        first!.id,
        'contract-worker',
        first!.attempt,
      )).resolves.toBe(false);
      await expect(repository.isCancellationRequested(
        second!.id,
        'contract-worker',
        second!.attempt,
      )).resolves.toBe(true);
      await expect(repository.fail(first!, 'contract-worker', 'stale failure'))
        .rejects.toThrow(/ownership was lost/);
      await expect(repository.get(second!.id)).resolves.toMatchObject({
        status: 'running',
        attempt: second!.attempt,
      });
    });

    it('recovers an expired claim with a fenced next attempt', async () => {
      const repository = harness.repository();
      const connectorId = await harness.createConnector('lease-recovery');
      const queued = await repository.enqueue(connectorId, { maxAttempts: 2 });
      const first = await repository.claimNext('expired-worker', 5);
      expect(first?.id).toBe(queued.id);

      await new Promise((resolve) => setTimeout(resolve, 25));
      const recovered = await repository.claimNext('recovery-worker', 60_000);

      expect(recovered).toMatchObject({
        id: queued.id,
        leaseOwner: 'recovery-worker',
        attempt: first!.attempt + 1,
      });
      await expect(repository.renewLease(
        queued.id,
        'expired-worker',
        first!.attempt,
        60_000,
      )).resolves.toBe(false);
    });
  });
}
