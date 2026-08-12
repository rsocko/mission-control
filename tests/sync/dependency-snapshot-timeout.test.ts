import { describe, expect, it } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import { fetchDependencySnapshot } from '@/lib/sync/dependency-snapshot';

describe('dependency snapshot timeout', () => {
  it('aborts and rejects an unresponsive snapshot', async () => {
    process.env.MC_DEPENDENCY_SNAPSHOT_TIMEOUT_MS = '5';
    let receivedSignal: AbortSignal | undefined;
    const connector = {
      fetchTaskDependencies: async (
        _sourceIds: string[],
        options?: { signal?: AbortSignal },
      ) => {
        receivedSignal = options?.signal;
        return new Promise<never>(() => {});
      },
    } as IConnector;

    await expect(fetchDependencySnapshot(connector, ['acme/app:20']))
      .rejects.toThrow('Dependency snapshot timed out after 5ms');
    expect(receivedSignal?.aborted).toBe(true);
    delete process.env.MC_DEPENDENCY_SNAPSHOT_TIMEOUT_MS;
  });
});
