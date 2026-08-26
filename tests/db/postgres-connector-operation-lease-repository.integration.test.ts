import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresConnectorOperationLeaseRepository } from '@/db/postgres/sync/connector-operation-lease-repository';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL connector-operation lease repository integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-lease-repository-test',
          }),
        }
      : {}),
  });
  let repository: PostgresConnectorOperationLeaseRepository;
  const connectorIds = new Set<string>();

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    repository = new PostgresConnectorOperationLeaseRepository(backend.context.pool);
  }, 120_000);

  afterAll(async () => {
    for (const id of connectorIds) {
      await backend.context.pool.query('DELETE FROM connector_operation_leases WHERE connector_id = $1', [id]);
    }
    await backend.shutdown();
  });

  function newConnectorId(): string {
    const id = `connector-lease-${randomUUID()}`;
    connectorIds.add(id);
    return id;
  }

  it('acquires a lease and rejects a concurrent conflicting acquisition', async () => {
    const connectorId = newConnectorId();
    const at = new Date().toISOString();

    const first = await repository.acquire({
      connectorId,
      operationType: 'transfer',
      owner: 'owner-a',
      leaseDurationMs: 60_000,
      at,
    });
    expect(first.status).toBe('acquired');

    const second = await repository.acquire({
      connectorId,
      operationType: 'transfer',
      owner: 'owner-b',
      leaseDurationMs: 60_000,
      at,
    });
    expect(second.status).toBe('conflict');
  });

  it('allows acquisition once the previous lease has expired', async () => {
    const connectorId = newConnectorId();
    const past = new Date(Date.now() - 5_000).toISOString();

    const expired = await repository.acquire({
      connectorId,
      operationType: 'transfer',
      owner: 'owner-a',
      leaseDurationMs: 1,
      at: past,
    });
    expect(expired.status).toBe('acquired');

    const now = new Date().toISOString();
    const reacquired = await repository.acquire({
      connectorId,
      operationType: 'transfer',
      owner: 'owner-b',
      leaseDurationMs: 60_000,
      at: now,
    });
    expect(reacquired.status).toBe('acquired');
  });

  it('renews an owned lease and rejects renewal by a non-owner', async () => {
    const connectorId = newConnectorId();
    const at = new Date().toISOString();
    await repository.acquire({
      connectorId,
      operationType: 'transfer',
      owner: 'owner-a',
      leaseDurationMs: 60_000,
      at,
    });

    const renewed = await repository.renew({
      connectorId,
      owner: 'owner-a',
      leaseDurationMs: 60_000,
      at: new Date().toISOString(),
    });
    expect(renewed.status).toBe('renewed');

    const lost = await repository.renew({
      connectorId,
      owner: 'owner-b',
      leaseDurationMs: 60_000,
      at: new Date().toISOString(),
    });
    expect(lost.status).toBe('lost');
  });

  it('releases an owned lease and reports loss for a mismatched owner', async () => {
    const connectorId = newConnectorId();
    const at = new Date().toISOString();
    await repository.acquire({
      connectorId,
      operationType: 'transfer',
      owner: 'owner-a',
      leaseDurationMs: 60_000,
      at,
    });

    const wrongOwner = await repository.release({ connectorId, owner: 'owner-b' });
    expect(wrongOwner.status).toBe('lost');

    const released = await repository.release({ connectorId, owner: 'owner-a' });
    expect(released.status).toBe('released');
  });

  it('reports no active lease for an unrelated job id', async () => {
    const connectorId = newConnectorId();
    const active = await repository.hasActiveSyncJobLease({
      connectorId,
      jobId: 'nonexistent-job',
      at: new Date().toISOString(),
    });
    expect(active).toBe(false);
  });
});
