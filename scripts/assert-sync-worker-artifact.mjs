import { readFile } from 'node:fs/promises';

const RETIRED_FINANCE_BACKLOG_CODE = [
  'finance',
  'attention',
  'backlog',
  'exceeded',
].join('_');

export function assertSyncWorkerArtifact(source) {
  if (source.includes(RETIRED_FINANCE_BACKLOG_CODE)) {
    throw new Error(
      `Sync worker bundle contains retired error code: ${RETIRED_FINANCE_BACKLOG_CODE}`,
    );
  }
}

export async function assertSyncWorkerArtifactFile(file) {
  assertSyncWorkerArtifact(await readFile(file, 'utf8'));
}
