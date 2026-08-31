import { readFile } from 'node:fs/promises';

const RETIRED_FINANCE_BACKLOG_CODE = [
  'finance',
  'attention',
  'backlog',
  'exceeded',
].join('_');

const REQUIRED_FINANCE_WORKER_TOKENS = [
  'FinanceSnapshotSynchronizer',
  'FinanceDatasetSynchronizer',
  'FinanceAttributionCoordinator',
  'normalizeFinanceProviderAlias(connector.type)',
  'allowsLegacyWorkflow("notification-dispatcher")',
];

const REQUIRED_TRIAGE_WORKER_TOKENS = [
  'TriageSyncScheduler',
  'createPostgresTriagePersistenceRepositories',
  'MAX_DOCUMENT_INTELLIGENCE_BATCH_SIZE',
  'Triage auto-sync completed',
];

export function assertSyncWorkerArtifact(source) {
  if (source.includes(RETIRED_FINANCE_BACKLOG_CODE)) {
    throw new Error(
      `Sync worker bundle contains retired error code: ${RETIRED_FINANCE_BACKLOG_CODE}`,
    );
  }
  const missing = REQUIRED_FINANCE_WORKER_TOKENS.filter((token) => !source.includes(token));
  if (missing.length > 0) {
    throw new Error(
      `Sync worker bundle omitted required finance activation markers:\n${missing.join('\n')}`,
    );
  }
  const missingTriage = REQUIRED_TRIAGE_WORKER_TOKENS.filter(
    (token) => !source.includes(token),
  );
  if (missingTriage.length > 0) {
    throw new Error(
      `Sync worker bundle omitted required triage activation markers:\n${missingTriage.join('\n')}`,
    );
  }
  if (
    /config\.type === ["']finance-manager["'][\s\S]{0,200}connector-owned state/
      .test(source)
  ) {
    throw new Error('Sync worker bundle retained the PostgreSQL finance support rejection');
  }
}

export async function assertSyncWorkerArtifactFile(file) {
  assertSyncWorkerArtifact(await readFile(file, 'utf8'));
}
