import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import type {
  ConnectorOperationLeaseRepository,
} from '@/lib/sync/connector-operation-lease-repository';

export interface ConnectorOperationLeaseContractHarness {
  enabled?: boolean;
  setup(): Promise<void>;
  reset(): Promise<void>;
  teardown(): Promise<void>;
  repository(): ConnectorOperationLeaseRepository;
  createConnector(label: string): Promise<string>;
  setMaintenanceLock(connectorId: string, locked: boolean): Promise<void>;
}

export function runConnectorOperationLeaseRepositoryContract(
  name: string,
  harness: ConnectorOperationLeaseContractHarness,
): void {
  describe.skipIf(harness.enabled === false)(name, () => {
    beforeAll(() => harness.setup(), 120_000);
    afterEach(() => harness.reset());
    afterAll(() => harness.teardown());

    it('fences competing owners across renew and release', async () => {
      const connectorId = await harness.createConnector('owners');
      const repository = harness.repository();
      const request = {
        connectorId,
        operationType: 'transfer' as const,
        owner: 'contract-owner-a',
        leaseDurationMs: 60_000,
        at: '2026-01-01T00:00:00.000Z',
      };
      await expect(repository.acquire(request)).resolves.toMatchObject({ status: 'acquired' });
      await expect(repository.acquire({ ...request, owner: 'contract-owner-b' }))
        .resolves.toEqual({ status: 'conflict' });
      await expect(repository.renew({
        connectorId,
        owner: 'contract-owner-b',
        leaseDurationMs: 60_000,
        at: '2026-01-01T00:00:01.000Z',
      })).resolves.toEqual({ status: 'lost' });
      await expect(repository.release({ connectorId, owner: 'contract-owner-b' }))
        .resolves.toEqual({ status: 'lost' });
      await expect(repository.release({ connectorId, owner: 'contract-owner-a' }))
        .resolves.toEqual({ status: 'released' });
    });

    it('grants exactly one concurrent owner', async () => {
      const connectorId = await harness.createConnector('concurrent-owners');
      const repository = harness.repository();
      const outcomes = await Promise.all([
        repository.acquire({
          connectorId,
          operationType: 'transfer',
          owner: 'concurrent-owner-a',
          leaseDurationMs: 60_000,
          at: '2026-01-01T00:00:00.000Z',
        }),
        repository.acquire({
          connectorId,
          operationType: 'retention',
          owner: 'concurrent-owner-b',
          leaseDurationMs: 60_000,
          at: '2026-01-01T00:00:00.000Z',
        }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'acquired')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'conflict')).toHaveLength(1);
    });

    it('recovers an expired lease for a new owner', async () => {
      const connectorId = await harness.createConnector('expiry');
      const repository = harness.repository();
      await repository.acquire({
        connectorId,
        operationType: 'transfer',
        owner: 'expired-owner',
        leaseDurationMs: 1_000,
        at: '2026-01-01T00:00:00.000Z',
      });
      await expect(repository.acquire({
        connectorId,
        operationType: 'transfer',
        owner: 'recovery-owner',
        leaseDurationMs: 1_000,
        at: '2026-01-01T00:00:02.000Z',
      })).resolves.toMatchObject({ status: 'acquired' });
      await expect(repository.renew({
        connectorId,
        owner: 'expired-owner',
        leaseDurationMs: 1_000,
        at: '2026-01-01T00:00:02.000Z',
      })).resolves.toEqual({ status: 'lost' });
      await expect(repository.release({ connectorId, owner: 'expired-owner' }))
        .resolves.toEqual({ status: 'lost' });
    });

    it('excludes connector operations during maintenance', async () => {
      const connectorId = await harness.createConnector('maintenance');
      await harness.setMaintenanceLock(connectorId, true);
      await expect(harness.repository().acquire({
        connectorId,
        operationType: 'transfer',
        owner: 'maintenance-owner',
        leaseDurationMs: 60_000,
        at: '2026-01-01T00:00:00.000Z',
      })).resolves.toEqual({ status: 'conflict' });
    });
  });
}
