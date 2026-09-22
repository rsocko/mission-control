import type { IConnector } from '@/lib/connectors';
import type { SourceList } from '@/types';
import { syncLogger } from '@/lib/logger';
import { persistGitHubPrimaryIdentityBatch } from '@/lib/external-identities/primary-identity';
import type { ExternalIdentityWrite } from '@/lib/external-identities/types';
import type { GitHubStableIdentityRuntime } from '@/lib/external-identities/stable-identity-runtime';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/**
 * Yield to the event loop so healthchecks and other callbacks can run.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 25));
}

const LIST_INSERT_BATCH_SIZE = 100;

/**
 * Upserts source lists discovered from a remote connector.
 * Uses batched DB operations to minimise per-list round trips.
 */
export async function upsertSourceLists(
  connectorId: string,
  remoteSourceLists: SourceList[],
  identityRuntime?: GitHubStableIdentityRuntime,
  inaccessibleSourceListIds: ReadonlySet<string> = new Set(),
  preserveStaleLists = false,
): Promise<Map<string, string>> {
  const now = new Date().toISOString();
  const discoveredListIds = new Set<string>();
  const execution = (await getWorkerPersistenceRepositories()).execution;
  if (identityRuntime) {
    execution.support.assertConnectorSupported({ type: 'github-issues' });
  }
  const persistence = execution.lists;

  // Pre-fetch all existing lists for this connector in one query
  const existingRows = await persistence.list(connectorId);

  const existingBySourceId = new Map<string, { id: string; groupId: string | null }>();
  const existingById = new Map<string, { id: string; groupId: string | null }>();
  for (const row of existingRows) {
    const value = { id: row.id, groupId: row.groupId };
    existingBySourceId.set(row.sourceId, value);
    existingById.set(row.id, value);
  }

  const pendingWrites: Array<{
    id: string;
    connectorInstanceId: string;
    sourceId: string;
    name: string;
    type: string;
    taskCount: number;
    lastSyncedAt: string | null;
    wellKnownListName: string | null;
    lastKnownRemoteName: string | null;
  }> = [];
  const persistedIdsBySourceId = new Map<string, string>();
  const stableDecisions = new Map<string, Awaited<ReturnType<
    GitHubStableIdentityRuntime['resolveBatch']
  >>[number]>();

  if (identityRuntime) {
    for (let index = 0; index < remoteSourceLists.length; index += 500) {
      const chunk = remoteSourceLists.slice(index, index + 500);
      const decisions = await identityRuntime.resolveBatch(
        'source_list',
        'source_list',
        chunk.map((remoteSourceList) => {
          const existing = existingBySourceId.get(remoteSourceList.sourceId);
          return {
            candidateKey: remoteSourceList.sourceId,
            // Locator match is a guard only: an existing row without a NodeID
            // binding blocks instead of being adopted or duplicated.
            locatorMatchedLocalIds: existing ? [existing.id] : [],
            boundAction: 'update' as const,
            unboundAction: 'create' as const,
            evidence: remoteSourceList.externalIdentity,
            localSourceListId: existing?.id,
          };
        }),
      );
      for (const decision of decisions) stableDecisions.set(decision.candidateKey, decision);
    }
  }

  for (const remoteSourceList of remoteSourceLists) {
    const stableDecision = identityRuntime
      ? stableDecisions.get(remoteSourceList.sourceId)
      : undefined;
    if (identityRuntime && stableDecision?.appliedSource !== 'stable') {
      identityRuntime.markBlocked('source_list_identity_resolution_blocked');
      continue;
    }
    const listId = remoteSourceList.id || `${connectorId}:${remoteSourceList.sourceId}`;
    const existing = identityRuntime
      ? (stableDecision?.selectedLocalId
          ? existingById.get(stableDecision.selectedLocalId)
          : undefined)
      : existingBySourceId.get(remoteSourceList.sourceId);
    const persistedId = existing?.id || listId;
    persistedIdsBySourceId.set(remoteSourceList.sourceId, persistedId);
    discoveredListIds.add(persistedId);

    pendingWrites.push({
      id: persistedId,
      connectorInstanceId: connectorId,
      sourceId: remoteSourceList.sourceId,
      name: remoteSourceList.name,
      type: remoteSourceList.type,
      taskCount: remoteSourceList.taskCount ?? 0,
      lastSyncedAt: remoteSourceList.lastSyncedAt || now,
      wellKnownListName: remoteSourceList.wellKnownListName || null,
      lastKnownRemoteName: remoteSourceList.name,
    });
  }

  await identityRuntime?.assertDecisionsCurrent(stableDecisions.values());

  const stale = existingRows.flatMap((row) => {
    if (discoveredListIds.has(row.id) || preserveStaleLists) return [];
    if (identityRuntime || inaccessibleSourceListIds.has(row.sourceId)) return [];
    return [{
      id: row.id,
      action: row.groupId ? 'mark-unobserved' as const : 'delete' as const,
    }];
  });

  // Bound adapter transactions so unusually large tenants remain responsive.
  for (let index = 0; index < pendingWrites.length; index += LIST_INSERT_BATCH_SIZE) {
    await identityRuntime?.assertDecisionsCurrent(stableDecisions.values());
    const finalBatch = index + LIST_INSERT_BATCH_SIZE >= pendingWrites.length;
    await persistence.applyDiscovery({
      connectorId,
      upserts: pendingWrites.slice(index, index + LIST_INSERT_BATCH_SIZE),
      stale: finalBatch ? stale : [],
    });
    if (!finalBatch) {
      await yieldToEventLoop();
    }
  }
  if (pendingWrites.length === 0 && stale.length > 0) {
    await persistence.applyDiscovery({ connectorId, upserts: [], stale });
  }

  if (identityRuntime) {
    const identityWrites: ExternalIdentityWrite[] = remoteSourceLists.flatMap((remoteSourceList) => {
      if (!remoteSourceList.externalIdentity) return [];
      const localId = persistedIdsBySourceId.get(remoteSourceList.sourceId);
      if (!localId) return [];
      return [{
        target: {
          connectorInstanceId: connectorId,
          bindingType: 'source_list',
          localId,
          legacyIdentity: remoteSourceList.sourceId,
        },
        evidence: remoteSourceList.externalIdentity,
      }];
    });
    for (let index = 0; index < identityWrites.length; index += 500) {
      const results = await persistGitHubPrimaryIdentityBatch(
        identityWrites.slice(index, index + 500),
        identityRuntime.modeSnapshot,
      );
      const failed = results.find((result) => result.state !== 'bound');
      if (failed) {
        throw new Error(
          `GitHub source-list identity persistence failed: ${
            failed.collisionCategory ?? failed.state
          }`,
        );
      }
    }
  }

  return persistedIdsBySourceId;
}

/**
 * Auto-assign list groups from Substrate folder groups.
 * Creates missing groups and assigns lists that have a parentFolderGroupId
 * but no existing groupId in our DB.
 */
export async function autoAssignFolderGroups(
  connector: IConnector,
  remoteSourceLists: SourceList[],
): Promise<void> {
  if (!('fetchFolderGroups' in connector)) return;
  const execution = (await getWorkerPersistenceRepositories()).execution;
  execution.support.assertConnectorSupported(connector);

  const listsWithGroup = remoteSourceLists.filter(l => l.parentFolderGroupId);
  if (listsWithGroup.length === 0) return;

  try {
    const folderGroups = await (connector as { fetchFolderGroups: () => Promise<Array<{ id: string; name: string; orderDateTime?: string }>> }).fetchFolderGroups();
    if (folderGroups.length === 0) return;
    const assigned = await execution.lists.assignFolderGroups({
      groups: folderGroups.map((group) => ({ sourceId: group.id, name: group.name })),
      lists: listsWithGroup.map((list) => ({
        sourceId: list.sourceId,
        parentFolderGroupId: list.parentFolderGroupId!,
      })),
      now: new Date().toISOString(),
    });

    if (assigned > 0) {
      syncLogger.info({ assigned }, 'Auto-assigned lists to groups');
    }
  } catch (e) {
    syncLogger.warn({ err: e }, 'autoAssignFolderGroups failed (non-critical)');
  }
}
