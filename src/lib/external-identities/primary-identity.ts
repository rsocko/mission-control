import { syncLogger } from '@/lib/logger';
import { digestExternalIdentifier } from './identifier-digest';
import type { GitHubIdentityModeSnapshot } from './stable-identity-types';
import type {
  ExternalIdentityWrite,
  ExternalIdentityWriteResult,
} from './types';
import { getGitHubIdentityRepository } from './worker-persistence';

const MAX_BATCH_SIZE = 500;

/**
 * Persists normal-execution GitHub identity observations through the selected
 * Layer 3A composition. Operator and recovery workflows intentionally retain
 * their separate SQLite-only transaction paths.
 */
export async function persistGitHubPrimaryIdentityBatch(
  writes: readonly ExternalIdentityWrite[],
  modeSnapshot?: GitHubIdentityModeSnapshot,
): Promise<readonly ExternalIdentityWriteResult[]> {
  if (writes.length === 0) return [];
  if (writes.length > MAX_BATCH_SIZE) {
    throw new Error(`External identity batch exceeds the maximum of ${MAX_BATCH_SIZE}`);
  }

  const connectorInstanceId = writes[0].target.connectorInstanceId;
  if (
    writes.some((write) => write.target.connectorInstanceId !== connectorInstanceId)
    || (
      modeSnapshot
      && modeSnapshot.connectorInstanceId !== connectorInstanceId
    )
  ) {
    throw new Error('External identity writes do not match the frozen connector');
  }

  const results = await (await getGitHubIdentityRepository()).persistExternalIdentityBatch({
    connectorInstanceId,
    modeSnapshot,
    writes,
  });
  const writesByTarget = new Map(writes.map((write) => [
    `${write.target.bindingType}\0${write.target.localId}`,
    write,
  ]));
  for (const result of results) {
    const write = writesByTarget.get(
      `${result.target.bindingType}\0${result.target.localId}`,
    );
    const context = {
      connectorId: result.target.connectorInstanceId,
      bindingType: result.target.bindingType,
      localId: result.target.localId,
      stableIdDigest: write
        ? digestExternalIdentifier(write.evidence.entity.identity.stableId)
        : undefined,
    };
    if (result.state === 'bound') {
      syncLogger.debug(context, 'Persisted external identity active binding');
    } else if (result.state === 'collision') {
      syncLogger.warn(
        { ...context, collisionCategory: result.collisionCategory },
        'External identity collision recorded',
      );
    }
  }
  return results;
}
