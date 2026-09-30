import type { TaskItem } from '@/types';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { stableCompanionOperationId } from './action-contract';
import {
  companionTaskRelationIdV2,
  normalizeTrustedOrigin,
  type CompanionTaskMaterializationV2,
  type CompanionActionFeedPageV2,
  type CompanionActionMutationRequestV2,
  type ManagedTaskCommandV1,
} from './action-contract-v2';
import {
  createCompanionActionClient,
  type CompanionActionClient,
} from './companion-action-client';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { submitDurableRyMessageV2Mutation } from './durable-v2-mutations';

function submitConnectorMutation(
  connectorId: string | undefined,
  client: CompanionActionClient,
  request: CompanionActionMutationRequestV2,
) {
  return connectorId
    ? submitDurableRyMessageV2Mutation(connectorId, client, request)
    : client.submitMutationV2(request);
}

interface PromotionIdentity {
  actionId: string;
  intentId: string;
  connectorId: string;
  expectedRevision?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function promotionClient(connectorId: string) {
  const connector = await getCorePersistenceRepositories().connectors.get(connectorId);
  if (!connector || connector.type !== 'rymessage' || !connector.enabled) {
    throw new Error('RyMessage connector is unavailable');
  }
  const settings = record(connector.settings);
  const baseUrl = typeof settings.companionBaseUrl === 'string'
    ? settings.companionBaseUrl.trim()
    : '';
  const credentialEnv = typeof settings.credentialEnv === 'string'
    ? settings.credentialEnv
    : 'RYMESSAGE_COMPANION_ACTION_FEED_TOKEN';
  const credential = process.env[credentialEnv];
  const trustedOrigin = normalizeTrustedOrigin(settings.trustedMissionControlOrigin);
  if (!baseUrl || !credential || !trustedOrigin) {
    throw new Error('RyMessage Companion promotion runtime is not configured');
  }
  return {
    client: createCompanionActionClient({ baseUrl, credential, maxRetries: 0 }),
    trustedOrigin,
  };
}

async function findIntent(
  identity: PromotionIdentity,
): Promise<'pending' | 'claimed' | 'fulfilled' | 'failed' | 'cancelled' | null> {
  const { client } = await promotionClient(identity.connectorId);
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await client.fetchPageV2(cursor);
    for (const item of page.items) {
      if (item.kind !== 'upsert' || item.aggregateId !== identity.actionId) continue;
      const intent = item.creationIntents.find(candidate => candidate.intentId === identity.intentId);
      if (intent) return intent.state;
    }

    if (page.complete || !page.nextCursor || page.nextCursor === cursor) return null;
    cursor = page.nextCursor;
  }

  return null;
}

async function currentActionRevision(identity: PromotionIdentity): Promise<number> {
  const { client } = await promotionClient(identity.connectorId);
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await client.fetchPageV2(cursor);
    const item = page.items.find(candidate => (
      candidate.kind === 'upsert' && candidate.aggregateId === identity.actionId
    ));
    if (item) return item.aggregateVersion;
    if (page.complete || !page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  throw new Error('RyMessage action is unavailable');
}

export async function claimRyMessagePromotionIntent(
  identity: PromotionIdentity,
): Promise<number> {
  const { client } = await promotionClient(identity.connectorId);
  const expectedRevision = await currentActionRevision(identity);
  const receipt = await submitDurableRyMessageV2Mutation(identity.connectorId, client, {
    contractVersion: '2.0',
    operationId: stableCompanionOperationId(`rymessage:intent:claim:${identity.intentId}`),
    actionId: identity.actionId,
    expectedRevision,
    mutation: {
      kind: 'creation-intent.claim',
      intentId: identity.intentId,
      claimedAt: new Date().toISOString(),
    },
  });
  if (receipt.outcome !== 'conflict') return receipt.revision;
  const state = await findIntent(identity);
  if (state !== 'claimed' && state !== 'fulfilled') {
    throw new Error(`RyMessage promotion intent cannot be claimed (${state ?? 'missing'})`);
  }
  return currentActionRevision(identity);

}

export async function unlinkRyMessageMaterialization(input: {
  connectorId: string;
  actionId: string;
  relationId: string;
  expectedRevision: number;
}): Promise<void> {
  const { client } = await promotionClient(input.connectorId);
  const receipt = await submitDurableRyMessageV2Mutation(input.connectorId, client, {
    contractVersion: '2.0',
    operationId: stableCompanionOperationId(
      `rymessage:relation:unlink:${input.actionId}:${input.relationId}`,
    ),
    actionId: input.actionId,
    expectedRevision: input.expectedRevision,
    mutation: {
      kind: 'materialization.unlink',
      relationId: input.relationId,
    },
  });
  if (receipt.outcome === 'conflict') {
    throw new Error('RyMessage action changed before the task could be unlinked');
  }
}

function normalizedStatus(status: TaskItem['status']): CompanionTaskMaterializationV2['snapshot']['status'] {
  if (status === 'done') return 'completed';
  if (status === 'in_progress') return 'in-progress';
  if (status === 'cancelled') return 'cancelled';
  return 'not-started';
}

export async function fulfillRyMessagePromotionIntent(
  identity: PromotionIdentity,
  task: Pick<
    TaskItem,
    | 'id'
    | 'sourceId'
    | 'connectorType'
    | 'connectorInstanceId'
    | 'sourceListId'
    | 'title'
    | 'status'
    | 'updatedAt'
  >,
): Promise<void> {
  const { client, trustedOrigin } = await promotionClient(identity.connectorId);
  const providerId = task.connectorType === 'local'
    ? 'mission-control-local'
    : task.connectorType;
  const providerAccountId = task.connectorType === 'local'
    ? 'local'
    : task.connectorInstanceId;
  const providerTaskId = task.connectorType === 'local' ? task.id : task.sourceId;
  const tuple = {
    actionId: identity.actionId,
    providerId,
    providerAccountId,
    ...(task.sourceListId ? { providerContainerId: task.sourceListId } : {}),
    providerTaskId,
  };
  const canonicalUrl = `${trustedOrigin}/tasks/${encodeURIComponent(task.id)}`;
  const materialization: CompanionTaskMaterializationV2 = {
    relationId: companionTaskRelationIdV2(tuple),
    revision: 1,
    providerId,
    providerAccountId,
    ...(task.sourceListId ? { providerContainerId: task.sourceListId } : {}),
    providerTaskId,
    state: 'linked',
    snapshot: {
      providerLabel: task.connectorType === 'local' ? 'Mission Control' : task.connectorType,
      providerIconKey: providerId,
      title: task.title,
      status: normalizedStatus(task.status),
      providerVersion: task.updatedAt,
      openUrl: canonicalUrl,
      observedAt: new Date().toISOString(),
      availability: 'live',
    },
    updatedAt: new Date().toISOString(),
  };
  const receipt = await submitDurableRyMessageV2Mutation(identity.connectorId, client, {
    contractVersion: '2.0',
    operationId: stableCompanionOperationId(`rymessage:intent:fulfill:${identity.intentId}`),
    actionId: identity.actionId,
    expectedRevision: identity.expectedRevision ?? await currentActionRevision(identity),
    mutation: {
      kind: 'creation-intent.fulfill',
      intentId: identity.intentId,
      materialization,
    },
  });
  if (receipt.outcome === 'conflict') {
    const state = await findIntent(identity);
    if (state !== 'fulfilled') {
      throw new Error(`RyMessage promotion intent cannot be fulfilled (${state ?? 'missing'})`);
    }
  }
  await submitDurableRyMessageV2Mutation(identity.connectorId, client, {
    contractVersion: '2.0',
    operationId: stableCompanionOperationId(`rymessage:manager:attach:${identity.intentId}`),
    actionId: identity.actionId,
    expectedRevision: receipt.revision,
    mutation: {
      kind: 'materialization.attach-manager',
      relationId: materialization.relationId,
      underlying: {
        providerId,
        providerAccountId,
        ...(task.sourceListId ? { providerContainerId: task.sourceListId } : {}),
        providerTaskId,
      },
      snapshot: materialization.snapshot,
      managerTaskId: task.id,
      managerVersion: task.updatedAt,
      managerCanonicalUrl: canonicalUrl,
    },
  });
}

export async function observeManagedRyMessageTasks(
  page: CompanionActionFeedPageV2,
  client: CompanionActionClient,
  connectorId?: string,
): Promise<void> {
  const taskRepository = getCorePersistenceRepositories().tasks;
  for (const item of page.items) {
    if (item.kind !== 'upsert') continue;
    for (const relation of item.taskMaterializations) {
      if (!relation.management || relation.state === 'unlinked') continue;
      const task = await taskRepository.get(relation.management.managerTaskId);
      const status = task ? normalizedStatus(task.status) : 'deleted';
      const availability = task ? 'live' : 'unavailable';
      const providerVersion = task?.updatedAt ?? relation.snapshot.providerVersion;
      if (
        relation.snapshot.status === status
        && relation.snapshot.availability === availability
        && relation.snapshot.providerVersion === providerVersion
      ) continue;
      const observedAt = new Date().toISOString();
      await submitConnectorMutation(connectorId, client, {
        contractVersion: '2.0',
        operationId: stableCompanionOperationId([
          'rymessage:relation:observe',
          relation.relationId,
          relation.revision,
          status,
          providerVersion,
        ].join(':')),
        actionId: item.aggregateId,
        expectedRevision: item.aggregateVersion,
        mutation: {
          kind: 'materialization.observe',
          relationId: relation.relationId,
          snapshot: {
            ...relation.snapshot,
            title: task?.title ?? relation.snapshot.title,
            status,
            providerVersion,
            observedAt,
            availability,
          },
          management: {
            managerVersion: task?.updatedAt ?? relation.management.managerVersion,
            canonicalUrl: relation.management.canonicalUrl,
          },
        },
      });
    }

  }
}

export async function attachImportedRyMessageManagers(
  page: CompanionActionFeedPageV2,
  client: CompanionActionClient,
  connectorId: string,
  trustedOrigin: string,
): Promise<void> {
  const taskRepository = getCorePersistenceRepositories().tasks;
  if (!taskRepository.findByProviderIdentity) return;
  for (const item of page.items) {
    if (item.kind !== 'upsert') continue;
    let expectedRevision = item.aggregateVersion;
    for (const relation of item.taskMaterializations) {
      if (
        relation.management
        || relation.state !== 'linked'
        || !['microsoft-todo', 'microsoft_todo'].includes(relation.providerId)
      ) continue;
      const task = await taskRepository.findByProviderIdentity({
        connectorInstanceId: relation.providerAccountId,
        providerTaskId: relation.providerTaskId,
        ...(relation.providerContainerId
          ? { providerContainerId: relation.providerContainerId }
          : {}),
      });
      if (!task) continue;
      const receipt = await submitDurableRyMessageV2Mutation(connectorId, client, {
        contractVersion: '2.0',
        operationId: stableCompanionOperationId(
          `rymessage:manager:attach-imported:${relation.relationId}:${task.id}`,
        ),
        actionId: item.aggregateId,
        expectedRevision,
        mutation: {
          kind: 'materialization.attach-manager',
          relationId: relation.relationId,
          underlying: {
            providerId: relation.providerId,
            providerAccountId: relation.providerAccountId,
            ...(relation.providerContainerId
              ? { providerContainerId: relation.providerContainerId }
              : {}),
            providerTaskId: relation.providerTaskId,
          },
          snapshot: relation.snapshot,
          managerTaskId: task.id,
          managerVersion: task.updatedAt,
          managerCanonicalUrl: `${trustedOrigin}/tasks/${encodeURIComponent(task.id)}`,
        },
      });
      if (receipt.outcome !== 'conflict') expectedRevision = receipt.revision;
    }
  }
}

function managedTaskStatus(
    status: ManagedTaskCommandV1['patch']['status'],
  ): TaskItem['status'] | undefined {
    if (status === 'not-started') return 'todo';
    if (status === 'in-progress' || status === 'blocked') return 'in_progress';
    if (status === 'completed') return 'done';
    if (status === 'cancelled') return 'cancelled';
    return undefined;
  }

function assertManagedPatchSupported(
  connectorType: string,
  patch: ManagedTaskCommandV1['patch'],
): void {
  if (patch.reminderAt !== undefined) throw new Error('provider_field_unsupported');
  if (connectorType !== 'local' && patch.dueAt === null) {
    throw new Error('provider_field_unsupported');
  }
  if (
    connectorType === 'microsoft-todo'
    && (patch.notes === '' || patch.status === 'blocked')
  ) {
    throw new Error('provider_field_unsupported');
  }
  if (connectorType === 'github-issues') {
    if (
      patch.dueAt !== undefined
      || patch.reminderAt !== undefined
      || patch.notes === ''
      || (
        patch.status !== undefined
        && patch.status !== 'completed'
        && patch.status !== 'cancelled'
      )
    ) {
      throw new Error('provider_field_unsupported');
    }
    return;
  }
  if (!['local', 'microsoft-todo', 'custom-rest'].includes(connectorType)) {
    throw new Error('provider_field_unsupported');
  }
}

function assertManagedPatchApplied(
  patch: ManagedTaskCommandV1['patch'],
  task: TaskItem,
): void {
  if (patch.title !== undefined && task.title !== patch.title) {
    throw new Error('provider_state_mismatch');
  }
  if (patch.notes !== undefined && (task.description ?? '') !== patch.notes) {
    throw new Error('provider_state_mismatch');
  }
  if (patch.dueAt !== undefined && (task.dueDate ?? null) !== patch.dueAt) {
    throw new Error('provider_state_mismatch');
  }
  const expectedPriority = patch.priority === undefined
    ? undefined
    : patch.priority ? 'high' : 'none';
  if (expectedPriority !== undefined && task.priority !== expectedPriority) {
    throw new Error('provider_state_mismatch');
  }
  const expectedStatus = managedTaskStatus(patch.status);
  if (expectedStatus !== undefined && task.status !== expectedStatus) {
    throw new Error('provider_state_mismatch');
  }
}

export async function applyManagedRyMessageCommands(
    page: CompanionActionFeedPageV2,
    client: CompanionActionClient,
    connectorId?: string,
  ): Promise<void> {
    const taskRepository = getCorePersistenceRepositories().tasks;
    for (const item of page.items) {
      if (item.kind !== 'upsert') continue;
      for (const command of item.managedTaskCommands) {
        if (command.state !== 'pending' && command.state !== 'claimed') continue;
        const relation = item.taskMaterializations.find(
          candidate => candidate.relationId === command.relationId,
        );
        if (!relation?.management) continue;
        const initialTask = await taskRepository.get(relation.management.managerTaskId);
        let preflightError: Error | null = null;
        if (!initialTask) {
          preflightError = new Error('managed_task_missing');
        } else {
          try {
            if (
              command.expectedManagerVersion
              && (
                command.expectedManagerVersion !== relation.management.managerVersion
                || command.expectedManagerVersion !== initialTask.updatedAt
              )
            ) {
              throw new Error('manager_version_conflict');
            }
            assertManagedPatchSupported(initialTask.connectorType, command.patch);
          } catch (error) {
            preflightError = error instanceof Error
              ? error
              : new Error('provider_update_failed');
          }
        }
        try {
          if (command.state === 'pending') {
            const claim = await submitConnectorMutation(connectorId, client, {
              contractVersion: '2.0',
              operationId: stableCompanionOperationId(
                `rymessage:command:claim:${command.commandId}:${command.revision}`,
              ),
              actionId: item.aggregateId,
              expectedRevision: item.aggregateVersion,
              mutation: {
                kind: 'managed-command.claim',
                commandId: command.commandId,
                claimedAt: new Date().toISOString(),
              },
            });
            if (claim.outcome === 'conflict') continue;
          }

          if (preflightError) throw preflightError;
          const task = await taskRepository.get(relation.management.managerTaskId);
          if (!task) throw new Error('managed_task_missing');
          if (
            command.expectedManagerVersion
            && command.expectedManagerVersion !== task.updatedAt
          ) {
            throw new Error('manager_version_conflict');
          }
          const updates: Partial<TaskItem> = {
            ...(command.patch.title !== undefined ? { title: command.patch.title } : {}),
            ...(command.patch.notes !== undefined ? { description: command.patch.notes } : {}),
            ...(command.patch.dueAt !== undefined
              ? { dueDate: command.patch.dueAt ?? undefined }
              : {}),
            ...(command.patch.priority !== undefined
              ? { priority: command.patch.priority ? 'high' : 'none' }
              : {}),
            ...(command.patch.status !== undefined
              ? { status: managedTaskStatus(command.patch.status) }
              : {}),
            ...(command.patch.status === 'blocked'
              ? { microStatus: 'blocked_external' as const }
              : command.patch.status !== undefined ? { microStatus: undefined } : {}),
            updatedAt: new Date().toISOString(),
          };
          let updated: TaskItem;
          if (task.connectorType === 'local') {
            updated = await taskRepository.upsert({ ...task, ...updates });
          } else {
            const connector = await getOrInitializeConnector(task.connectorInstanceId);
            if (!connector?.updateTask) throw new Error('provider_update_unavailable');
            let providerTask: TaskItem;
            if (
              task.connectorType === 'github-issues'
              && (
                command.patch.status === 'completed'
                || command.patch.status === 'cancelled'
              )
            ) {
              const nonStatusUpdates = { ...updates };
              delete nonStatusUpdates.status;
              delete nonStatusUpdates.microStatus;
              const hasOtherUpdates = Object.keys(nonStatusUpdates)
                .some(key => key !== 'updatedAt');
              providerTask = hasOtherUpdates
                ? await connector.updateTask(task.sourceId, nonStatusUpdates)
                : task;
              if (command.patch.status === 'cancelled' && connector.cancelTask) {
                await connector.cancelTask(task.sourceId);
              } else if (connector.completeTask) {
                await connector.completeTask(task.sourceId);
              } else {
                throw new Error('provider_field_unsupported');
              }
              providerTask = {
                ...providerTask,
                status: command.patch.status === 'cancelled' ? 'cancelled' : 'done',
                updatedAt: new Date().toISOString(),
              };
            } else {
              providerTask = await connector.updateTask(task.sourceId, updates);
            }
            assertManagedPatchApplied(command.patch, providerTask);
            updated = await taskRepository.upsert({
              ...task,
              ...providerTask,
              id: task.id,
              connectorType: task.connectorType,
              connectorInstanceId: task.connectorInstanceId,
            });
          }
          assertManagedPatchApplied(command.patch, updated);
          await submitConnectorMutation(connectorId, client, {
            contractVersion: '2.0',
            operationId: stableCompanionOperationId(
              `rymessage:command:complete:${command.commandId}:${command.revision}`,
            ),
            actionId: item.aggregateId,
            expectedRevision: item.aggregateVersion + (command.state === 'pending' ? 1 : 0),
            mutation: {
              kind: 'managed-command.complete',
              commandId: command.commandId,
              managerVersion: updated.updatedAt,
              completedAt: new Date().toISOString(),
            },
          });
        } catch (error) {
          const code = error instanceof Error && /^[a-z][a-z0-9._-]{0,63}$/.test(error.message)
            ? error.message
            : 'provider_update_failed';
          await submitConnectorMutation(connectorId, client, {
            contractVersion: '2.0',
            operationId: stableCompanionOperationId(
              `rymessage:command:fail:${command.commandId}:${command.revision}:${code}`,
            ),
            actionId: item.aggregateId,
            expectedRevision: item.aggregateVersion + (command.state === 'pending' ? 1 : 0),
            mutation: {
              kind: 'managed-command.fail',
              commandId: command.commandId,
              errorCode: code,
              failedAt: new Date().toISOString(),
            },
          });
        }
    }
  }
}
