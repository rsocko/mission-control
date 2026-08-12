import { describe, expect, it } from 'vitest';
import { assertSyncWorkerArtifact } from '../../scripts/assert-sync-worker-artifact.mjs';

describe('sync worker artifact guard', () => {
  it('rejects a bundle containing the retired finance backlog emitter', () => {
    const retiredCode = ['finance', 'attention', 'backlog', 'exceeded'].join('_');
    expect(() => assertSyncWorkerArtifact(`throw new Error('${retiredCode}')`))
      .toThrow(`Sync worker bundle contains retired error code: ${retiredCode}`);
  });

  it('accepts the paged finance attention router bundle', () => {
    expect(() => assertSyncWorkerArtifact('SOURCE_BATCH_SIZE = 500')).not.toThrow();
  });
});
