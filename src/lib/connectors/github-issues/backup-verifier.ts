import type { GitHubRecoveryBackupAttestation } from '@/db/persistence/github-recovery';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

export interface GitHubRepointBackupVerifier {
  inspect(
    backupPath: string,
    now?: Date,
  ): Promise<GitHubRecoveryBackupAttestation>;
}

let verifier: GitHubRepointBackupVerifier | null = null;

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
