import { describe, expect, it } from 'vitest';
import { assertSyncWorkerArtifact } from '../../scripts/assert-sync-worker-artifact.mjs';

describe('sync worker artifact guard', () => {
  const financeActivation = [
    'FinanceSnapshotSynchronizer',
    'FinanceDatasetSynchronizer',
    'FinanceAttributionCoordinator',
    'normalizeFinanceProviderAlias(connector.type)',
    'allowsLegacyWorkflow("notification-dispatcher")',
  ].join('\n');

  it('rejects a bundle containing the retired finance backlog emitter', () => {
    const retiredCode = ['finance', 'attention', 'backlog', 'exceeded'].join('_');
    expect(() => assertSyncWorkerArtifact(`${financeActivation}\nthrow new Error('${retiredCode}')`))
      .toThrow(`Sync worker bundle contains retired error code: ${retiredCode}`);
  });

  it('rejects a bundle missing the portable finance execution composition', () => {
    expect(() => assertSyncWorkerArtifact('SOURCE_BATCH_SIZE = 500'))
      .toThrow('Sync worker bundle omitted required finance activation markers');
  });

  it('rejects the retired PostgreSQL finance support gate', () => {
    expect(() => assertSyncWorkerArtifact(
      `${financeActivation}\nif (config.type === "finance-manager") { `
      + 'throw new UnsupportedConnectorExecutionError("connector-owned state"); }',
    )).toThrow('Sync worker bundle retained the PostgreSQL finance support rejection');
  });

  it('accepts the activated finance worker with separately gated delivery', () => {
    expect(() => assertSyncWorkerArtifact(financeActivation)).not.toThrow();
  });
});
