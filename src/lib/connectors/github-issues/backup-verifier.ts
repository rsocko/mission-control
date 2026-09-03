import { createHash } from 'node:crypto';
import { createReadStream, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { GitHubRecoveryBackupAttestation } from '@/db/persistence/github-recovery';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import {
  BACKUP_ATTESTATION_MAX_AGE_MS,
  BACKUP_ATTESTATION_MAX_CLOCK_SKEW_MS,
} from '@/db/persistence/github-recovery-values';

export interface GitHubRepointBackupVerifier {
  inspect(
    backupPath: string,
    now?: Date,
  ): Promise<GitHubRecoveryBackupAttestation>;
}

let verifier: GitHubRepointBackupVerifier | null = null;

async function inspectSqliteBackup(
  backupPath: string,
  now = new Date(),
): Promise<GitHubRecoveryBackupAttestation> {
  const resolvedBackup = path.resolve(backupPath);
  const databasePath = path.resolve(
    process.env.MC_DB_PATH ?? path.join(process.cwd(), 'data', 'mission-control.db'),
  );
  if (resolvedBackup === databasePath) {
    throw new Error('Backup path must not be the active Mission Control database');
  }
  const initialStat = statSync(resolvedBackup);
  if (!initialStat.isFile() || initialStat.size <= 0) {
    throw new Error('Backup must be a non-empty file');
  }
  const Database = (await import('better-sqlite3')).default;
  const backup = new Database(resolvedBackup, { readonly: true, fileMustExist: true });
  try {
    const rows = backup.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error('Backup integrity check did not return exactly "ok"');
    }
  } finally {
    backup.close();
  }
  assertBackupUnchanged(initialStat, statSync(resolvedBackup));
  const sha256 = await hashFile(resolvedBackup);
  assertBackupUnchanged(initialStat, statSync(resolvedBackup));
  const modifiedAt = initialStat.mtime.toISOString();
  if (initialStat.mtimeMs - now.getTime() > BACKUP_ATTESTATION_MAX_CLOCK_SKEW_MS) {
    throw new Error('Backup modification time is more than five minutes in the future');
  }
  if (now.getTime() - initialStat.mtimeMs > BACKUP_ATTESTATION_MAX_AGE_MS) {
    throw new Error('Backup is older than 24 hours');
  }
  return {
    path: resolvedBackup,
    sha256,
    sizeBytes: initialStat.size,
    modifiedAt,
    integrityCheck: 'ok',
    verifiedAt: now.toISOString(),
    source: 'sqlite-file',
  };
}

function assertBackupUnchanged(before: Stats, after: Stats): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error('Backup changed while it was being verified');
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

const sqliteVerifier: GitHubRepointBackupVerifier = {
  inspect: inspectSqliteBackup,
};

export function registerGitHubRepointBackupVerifier(
  next: GitHubRepointBackupVerifier,
): void {
  assertCanRegisterGitHubRepointBackupVerifier(next);
  verifier = next;
}

export function assertCanRegisterGitHubRepointBackupVerifier(
  next: GitHubRepointBackupVerifier,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (verifier && verifier !== next) {
    throw new Error('GitHub repoint backup verifier is already selected');
  }
}

export function clearGitHubRepointBackupVerifier(
  expectedVerifier?: GitHubRepointBackupVerifier,
): void {
  if (expectedVerifier && verifier !== expectedVerifier) return;
  verifier = null;
}

export function registerSqliteGitHubRepointBackupVerifier(): void {
  registerGitHubRepointBackupVerifier(sqliteVerifier);
}

export function assertCanRegisterSqliteGitHubRepointBackupVerifier(): void {
  assertCanRegisterGitHubRepointBackupVerifier(sqliteVerifier);
}

export function clearSqliteGitHubRepointBackupVerifier(): void {
  clearGitHubRepointBackupVerifier(sqliteVerifier);
}

export async function inspectGitHubRepointBackup(
  backupPath: string,
  now = new Date(),
): Promise<GitHubRecoveryBackupAttestation> {
  assertPersistenceCompositionAccessAllowed();
  if (!verifier) {
    throw new Error('GitHub backup verification is unavailable for the selected backend');
  }
  return verifier.inspect(backupPath, now);
}
