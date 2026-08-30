import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { GitHubRecoveryBackupAttestation } from '@/db/persistence/github-recovery';
import { BACKUP_ATTESTATION_MAX_AGE_MS } from '@/db/persistence/github-recovery-values';

/**
 * SQLite backup verification — an *edge helper*, not persistence.
 *
 * The GitHub recovery services only ever consume the bounded
 * {@link GitHubRecoveryBackupAttestation} value, so this module is the single
 * place that opens a database file. It is deliberately not part of the
 * persistence ports: PostgreSQL deployments verify their own dumps out of band
 * and pass an equivalent `source: 'external-preverified'` attestation, and this
 * repository ships no PostgreSQL dump, restore, or deployment tooling.
 */
export async function inspectGitHubRepointBackup(
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
  const stat = statSync(resolvedBackup);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Backup must be a non-empty file');
  const backup = new Database(resolvedBackup, { readonly: true, fileMustExist: true });
  try {
    const rows = backup.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error('Backup integrity check did not return exactly "ok"');
    }
  } finally {
    backup.close();
  }
  const modifiedAt = stat.mtime.toISOString();
  if (now.getTime() - stat.mtimeMs > BACKUP_ATTESTATION_MAX_AGE_MS) {
    throw new Error('Backup is older than 24 hours');
  }
  return {
    path: resolvedBackup,
    sha256: await hashFile(resolvedBackup),
    sizeBytes: stat.size,
    modifiedAt,
    integrityCheck: 'ok',
    verifiedAt: now.toISOString(),
    source: 'sqlite-file',
  };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
