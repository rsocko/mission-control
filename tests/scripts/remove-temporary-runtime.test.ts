import { describe, expect, it, vi } from 'vitest';
import { removeTemporaryRuntime } from '../../scripts/remove-temporary-runtime.mjs';

describe('removeTemporaryRuntime', () => {
  it('retries transient non-empty directory cleanup failures', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    await removeTemporaryRuntime('/tmp/mc-worker-runtime-test', remove);

    expect(remove).toHaveBeenCalledWith('/tmp/mc-worker-runtime-test', {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
});
