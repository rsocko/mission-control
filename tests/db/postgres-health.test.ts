import { describe, expect, it } from 'vitest';
import { PostgresDatabaseHealthProbe } from '@/db/postgres/health';

function fakePool(
  overrides: Partial<{
    totalCount: number;
    idleCount: number;
    waitingCount: number;
    query: () => Promise<{ rows: Array<{ size_bytes?: string; seeded?: boolean }> }>;
  }> = {},
) {
  return {
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    query: async () => ({ rows: [{ size_bytes: '4096' }] }),
    ...overrides,
  };
}

describe('PostgreSQL health probe', () => {
  it('reports database size and pool state', async () => {
    const probe = new PostgresDatabaseHealthProbe(fakePool() as never);

    await expect(probe.inspect()).resolves.toMatchObject({
      connected: true,
      severity: 'healthy',
      sizeBytes: 4096,
      backend: {
        kind: 'postgres',
        details: {
          totalConnections: 2,
          idleConnections: 1,
          waitingClients: 0,
        },
      },
    });
  });

  it('degrades a saturated pool', async () => {
    const probe = new PostgresDatabaseHealthProbe(fakePool({
      idleCount: 0,
      waitingCount: 3,
    }) as never);

    await expect(probe.inspect()).resolves.toMatchObject({
      connected: true,
      severity: 'degraded',
      message: 'PostgreSQL connection pool is saturated',
    });
  });

  it('reports unavailable without exposing the driver error', async () => {
    const probe = new PostgresDatabaseHealthProbe(fakePool({
      query: async () => {
        throw new Error('password authentication failed for secret');
      },
    }) as never);

    const snapshot = await probe.inspect();
    expect(snapshot).toMatchObject({
      connected: false,
      severity: 'critical',
      message: 'PostgreSQL is unavailable',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('treats an unavailable seed marker as absent', async () => {
    const probe = new PostgresDatabaseHealthProbe(fakePool({
      query: async () => {
        throw new Error('connection failed');
      },
    }) as never);

    await expect(probe.hasSeedMarker()).resolves.toBe(false);
  });
});
