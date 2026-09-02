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
  const triageActivation = [
    'TriageSyncScheduler',
    'createPostgresTriagePersistenceRepositories',
    'MAX_DOCUMENT_INTELLIGENCE_BATCH_SIZE',
    'Triage auto-sync completed',
  ].join('\n');
  const finalActivation = [
    'createPostgresFinanceConnectionRecoveryPersistence',
    'financeConnectionEpisodeId',
    'Selected worker persistence composition is incomplete',
    'legacy durable AI run worker is disabled on PostgreSQL',
    'semantic index worker is disabled for this persistence backend',
  ].join('\n');
  const eventOutboxActivation = [
    'EventOutboxDispatcher',
    'createPostgresEventDeliveryRepositories',
    'createSqliteEventDeliveryRepositories',
    'durable event outbox dispatcher initialized',
    'Event delivery lease was fenced out mid-flight',
    'Event delivery moved to dead letter',
  ].join('\n');
  const completeActivation =
    `${financeActivation}\n${triageActivation}\n${finalActivation}\n${eventOutboxActivation}`;

  it('rejects a bundle containing the retired finance backlog emitter', () => {
    const retiredCode = ['finance', 'attention', 'backlog', 'exceeded'].join('_');
    expect(() => assertSyncWorkerArtifact(`${completeActivation}\nthrow new Error('${retiredCode}')`))
      .toThrow(`Sync worker bundle contains retired error code: ${retiredCode}`);
  });

  it('rejects a bundle missing the portable finance execution composition', () => {
    expect(() => assertSyncWorkerArtifact(triageActivation))
      .toThrow('Sync worker bundle omitted required finance activation markers');
  });

  it('rejects a bundle missing the portable triage execution composition', () => {
    expect(() => assertSyncWorkerArtifact(financeActivation))
      .toThrow('Sync worker bundle omitted required triage activation markers');
  });

  it('rejects the retired PostgreSQL finance support gate', () => {
    expect(() => assertSyncWorkerArtifact(
      `${completeActivation}\nif (config.type === "finance-manager") { `
      + 'throw new UnsupportedConnectorExecutionError("connector-owned state"); }',
    )).toThrow('Sync worker bundle retained the PostgreSQL finance support rejection');
  });

  it('rejects a bundle missing the packaged durable event outbox runtime', () => {
    expect(() => assertSyncWorkerArtifact(
      `${financeActivation}\n${triageActivation}\n${finalActivation}`,
    )).toThrow('Sync worker bundle omitted durable event outbox markers');
  });

  it('accepts the activated finance and triage worker with separately gated delivery', () => {
    expect(() => assertSyncWorkerArtifact(completeActivation)).not.toThrow();
  });
});
