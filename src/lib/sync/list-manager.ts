import type { IConnector } from '@/lib/connectors';
import type { SourceList } from '@/types';
import db from '@/db';
import { sourceLists as sourceListsTable, listGroups as listGroupsTable } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { syncLogger } from '@/lib/logger';
import { persistExternalIdentityBatch } from '@/lib/external-identities';
import type { ExternalIdentityWrite } from '@/lib/external-identities/types';
import type { GitHubStableIdentityRuntime } from '@/lib/external-identities';

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

  // Pre-fetch all existing lists for this connector in one query
  const existingRows = await db.select({
    id: sourceListsTable.id,
    sourceId: sourceListsTable.sourceId,
    groupId: sourceListsTable.groupId,
  })
    .from(sourceListsTable)
    .where(eq(sourceListsTable.connectorInstanceId, connectorId));

  const existingBySourceId = new Map<string, { id: string; groupId: string | null }>();
  const existingById = new Map<string, { id: string; groupId: string | null }>();
  for (const row of existingRows) {
    const value = { id: row.id, groupId: row.groupId };
    existingBySourceId.set(row.sourceId, value);
    existingById.set(row.id, value);
  }

  const pendingInserts: Array<typeof sourceListsTable.$inferInsert> = [];
  const pendingUpdates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const persistedIdsBySourceId = new Map<string, string>();
  const stableDecisions = new Map<string, ReturnType<
    GitHubStableIdentityRuntime['resolveBatch']
  >[number]>();

  if (identityRuntime) {
    for (let index = 0; index < remoteSourceLists.length; index += 500) {
      const chunk = remoteSourceLists.slice(index, index + 500);
      const decisions = identityRuntime.resolveBatch(
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
    if (identityRuntime && stableDecision?.appliedSource !== 'stable') continue;
    const listId = remoteSourceList.id || `${connectorId}:${remoteSourceList.sourceId}`;
    const existing = identityRuntime
      ? (stableDecision?.selectedLocalId
          ? existingById.get(stableDecision.selectedLocalId)
          : undefined)
      : existingBySourceId.get(remoteSourceList.sourceId);
    const persistedId = existing?.id || listId;
    persistedIdsBySourceId.set(remoteSourceList.sourceId, persistedId);
    discoveredListIds.add(persistedId);

    if (existing) {
      pendingUpdates.push({
        id: persistedId,
        payload: {
          connectorInstanceId: connectorId,
          sourceId: remoteSourceList.sourceId,
          name: remoteSourceList.name,
          type: remoteSourceList.type,
          taskCount: remoteSourceList.taskCount ?? 0,
          lastSyncedAt: remoteSourceList.lastSyncedAt || now,
          wellKnownListName: remoteSourceList.wellKnownListName || null,
          lastKnownRemoteName: remoteSourceList.name,
        },
      });
    } else {
      pendingInserts.push({
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
  }

  identityRuntime?.assertDecisionsCurrent(stableDecisions.values());

  // Bound each synchronous SQLite statement so unusually large tenants do not
  // block health checks while persisting list discovery.
  for (let index = 0; index < pendingInserts.length; index += LIST_INSERT_BATCH_SIZE) {
    identityRuntime?.assertDecisionsCurrent(stableDecisions.values());
    await db.insert(sourceListsTable).values(
      pendingInserts.slice(index, index + LIST_INSERT_BATCH_SIZE),
    );
    if (index + LIST_INSERT_BATCH_SIZE < pendingInserts.length) {
      await yieldToEventLoop();
    }
  }

  // Execute updates in batches of 10 with yields
  for (let i = 0; i < pendingUpdates.length; i++) {
    const { id, payload } = pendingUpdates[i];
    identityRuntime?.assertDecisionsCurrent(stableDecisions.values());
    await db.update(sourceListsTable).set(payload).where(eq(sourceListsTable.id, id));
    if ((i + 1) % 10 === 0) await yieldToEventLoop();
  }

  // Remove stale lists (use pre-fetched data)
  for (const row of existingRows) {
    if (!discoveredListIds.has(row.id)) {
      if (preserveStaleLists) continue;
      // Under permanent NodeID identity, remote absence of a locator is never
      // authoritative for a GitHub source list: retain it and let repoint or
      // transfer tooling resolve the entity.
      if (identityRuntime || inaccessibleSourceListIds.has(row.sourceId)) continue;
      if (row.groupId) {
        await db.update(sourceListsTable)
          .set({ lastSyncedAt: null })
          .where(eq(sourceListsTable.id, row.id));
      } else {
        await db.delete(sourceListsTable)
          .where(eq(sourceListsTable.id, row.id));
      }
    }
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
      persistExternalIdentityBatch(
        identityWrites.slice(index, index + 500),
        identityRuntime.modeSnapshot,
      );
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

  const listsWithGroup = remoteSourceLists.filter(l => l.parentFolderGroupId);
  if (listsWithGroup.length === 0) return;

  try {
    const folderGroups = await (connector as { fetchFolderGroups: () => Promise<Array<{ id: string; name: string; orderDateTime?: string }>> }).fetchFolderGroups();
    if (folderGroups.length === 0) return;

    const groupMap = new Map(folderGroups.map(g => [g.id, g]));

    const existingGroups = await db.select().from(listGroupsTable);
    const remoteIdToLocalId = new Map<string, string>();
    const sourceIdToLocalGroup = new Map(
      existingGroups.filter(g => g.sourceId).map(g => [g.sourceId!, g.id])
    );
    const nameToLocalGroup = new Map(existingGroups.map(g => [g.name, g.id]));

    for (const [remoteId] of groupMap) {
      const bySourceId = sourceIdToLocalGroup.get(remoteId);
      if (bySourceId) {
        remoteIdToLocalId.set(remoteId, bySourceId);
      }
    }
    for (const eg of existingGroups) {
      for (const [remoteId, fg] of groupMap) {
        if (!remoteIdToLocalId.has(remoteId) && fg.name === eg.name) {
          remoteIdToLocalId.set(remoteId, eg.id);
          if (!eg.sourceId) {
            await db.update(listGroupsTable)
              .set({ sourceId: remoteId })
              .where(eq(listGroupsTable.id, eg.id));
          }
        }
      }
    }

    const now = new Date().toISOString();
    let sortOrder = existingGroups.length;
    for (const [remoteId, fg] of groupMap) {
      if (!remoteIdToLocalId.has(remoteId)) {
        const localId = nameToLocalGroup.get(fg.name);
        if (localId) {
          remoteIdToLocalId.set(remoteId, localId);
          const matchedGroup = existingGroups.find(g => g.id === localId);
          if (matchedGroup && !matchedGroup.sourceId) {
            await db.update(listGroupsTable)
              .set({ sourceId: remoteId })
              .where(eq(listGroupsTable.id, localId));
          }
        } else {
          const newId = `lg-${randomUUID().substring(0, 8)}`;
          await db.insert(listGroupsTable).values({
            id: newId,
            name: fg.name,
            sourceId: remoteId,
            sortOrder: sortOrder++,
            createdAt: now,
          });
          remoteIdToLocalId.set(remoteId, newId);
          nameToLocalGroup.set(fg.name, newId);
          syncLogger.info({ groupName: fg.name, groupId: newId }, 'Created list group');
        }
      }
    }

    let assigned = 0;
    for (const list of listsWithGroup) {
      const localGroupId = remoteIdToLocalId.get(list.parentFolderGroupId!);
      if (!localGroupId) continue;

      const [existing] = await db.select({ id: sourceListsTable.id, groupId: sourceListsTable.groupId })
        .from(sourceListsTable)
        .where(eq(sourceListsTable.sourceId, list.sourceId))
        .limit(1);

      if (existing && !existing.groupId) {
        await db.update(sourceListsTable)
          .set({ groupId: localGroupId })
          .where(eq(sourceListsTable.id, existing.id));
        assigned++;
      }
    }

    if (assigned > 0) {
      syncLogger.info({ assigned }, 'Auto-assigned lists to groups');
    }
  } catch (e) {
    syncLogger.warn({ err: e }, 'autoAssignFolderGroups failed (non-critical)');
  }
}
