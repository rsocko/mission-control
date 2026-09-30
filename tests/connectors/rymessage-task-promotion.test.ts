import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionActionClient } from '@/lib/connectors/rymessage/companion-action-client';
import type {
  CompanionActionFeedPageV2,
  CompanionActionFeedProjectionV2,
} from '@/lib/connectors/rymessage/action-contract-v2';

const getTask = vi.hoisted(() => vi.fn());
const upsertTask = vi.hoisted(() => vi.fn());
const findByProviderIdentity = vi.hoisted(() => vi.fn());
const getConnectorConfig = vi.hoisted(() => vi.fn());
const getOrInitializeConnector = vi.hoisted(() => vi.fn());
const submitMutationV2 = vi.hoisted(() => vi.fn());
const fetchPageV2 = vi.hoisted(() => vi.fn());

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    tasks: { get: getTask, upsert: upsertTask, findByProviderIdentity },
    connectors: { get: getConnectorConfig },
  }),
}));
vi.mock('@/lib/connectors/runtime', () => ({ getOrInitializeConnector }));
vi.mock('@/lib/connectors/rymessage/companion-action-client', () => ({
  createCompanionActionClient: () => ({ submitMutationV2, fetchPageV2 }),
}));
vi.mock('@/lib/connectors/rymessage/durable-v2-mutations', () => ({
  submitDurableRyMessageV2Mutation: (
    _connectorId: string,
    client: CompanionActionClient,
    request: Parameters<CompanionActionClient['submitMutationV2']>[0],
  ) => client.submitMutationV2(request),
}));

import {
  applyManagedRyMessageCommands,
  attachImportedRyMessageManagers,
  fulfillRyMessagePromotionIntent,
  observeManagedRyMessageTasks,
  unlinkRyMessageMaterialization,
} from '@/lib/connectors/rymessage/task-promotion';

const NOW = '2026-09-29T22:00:00.000Z';
const ACTION_ID = '00000000-0000-4000-8000-000000000001';
const RELATION_ID = '00000000-0000-5000-8000-000000000002';

function page(
  overrides: Partial<CompanionActionFeedProjectionV2> = {},
): CompanionActionFeedPageV2 {
  return {
    schemaVersion: '2.0',
    feedId: '00000000-0000-4000-8000-000000000010',
    mode: 'incremental',
    producedAt: NOW,
    nextCursor: 'cursor',
    complete: true,
    items: [{
      eventId: '00000000-0000-4000-8000-000000000011',
      operationId: '00000000-0000-4000-8000-000000000012',
      aggregateId: ACTION_ID,
      aggregateVersion: 1,
      sourceId: 'source',
      occurredAt: NOW,
      kind: 'upsert',
      action: {} as never,
      projection: {
        action: {} as never,
        taskMaterializations: [{
          contractVersion: 2,
          relationId: RELATION_ID,
          revision: 1,
          actionId: ACTION_ID,
          underlying: {
            providerId: 'github-issues',
            providerAccountId: 'github-1',
            providerTaskId: 'owner/repo#1',
          },
          state: 'linked',
          snapshot: {
            providerLabel: 'GitHub',
            providerIconKey: 'github-issues',
            title: 'Task',
            status: 'in-progress',
            providerVersion: 'old',
            openUrl: 'https://mc.example.test/',
            observedAt: NOW,
            availability: 'live',
          },
          management: {
            manager: 'mission-control',
            managerInstanceId: 'principal-injected',
            managerTaskId: 'mc-task',
            managerVersion: 'old',
            canonicalUrl: 'https://mc.example.test/',
          },
          createdAt: NOW,
          updatedAt: NOW,
        }],
        creationIntents: [],
        managedTaskCommands: [],
        taskLifecycle: {
          provenance: 'task-aggregate',
          state: 'linked',
          derivedAt: NOW,
        },
        ...overrides,
      },
    } as CompanionActionFeedPageV2['items'][number]],
  };
}

function client(): CompanionActionClient {
  return {
    fetchPage: vi.fn(),
    fetchPageV2,
    validateMutationV2: vi.fn(() => true),
    submitMutation: vi.fn(),
    submitMutationV2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN = 'secret';
  getConnectorConfig.mockResolvedValue({
    id: 'rymessage-1',
    type: 'rymessage',
    enabled: true,
    settings: {
      companionBaseUrl: 'https://companion.example.test',
      trustedMissionControlOrigin: 'https://mc.example.test',
    },
  });
  submitMutationV2.mockResolvedValue({
    operationId: '00000000-0000-4000-8000-000000000099',
    actionId: ACTION_ID,
    outcome: 'applied',
    revision: 2,
  });
});

describe('RyMessage task promotion convergence', () => {
  it('fulfills the immutable provider tuple with principal-injected management atomically', async () => {
    await fulfillRyMessagePromotionIntent({
      actionId: ACTION_ID,
      intentId: '00000000-0000-4000-8000-000000000020',
      connectorId: 'rymessage-1',
      expectedRevision: 2,
    }, {
      id: 'mc-task',
      sourceId: 'owner/repo#1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      sourceListId: 'owner/repo',
      title: 'Task',
      status: 'todo',
      updatedAt: NOW,
    });

    const fulfill = submitMutationV2.mock.calls[0]![0];
    expect(fulfill.mutation).toMatchObject({
      kind: 'materialization.fulfill-intent',
      underlying: {
        providerId: 'github-issues',
        providerAccountId: 'github-1',
        providerContainerId: 'owner/repo',
        providerTaskId: 'owner/repo#1',
      },
      managerTaskId: 'mc-task',
      managerVersion: NOW,
      managerCanonicalUrl: 'https://mc.example.test/tasks/mc-task',
    });
    expect(submitMutationV2).toHaveBeenCalledTimes(1);
  });

  it('reports provider deletion as terminal instead of recreating the task', async () => {
    getTask.mockResolvedValue(null);
    await observeManagedRyMessageTasks(page(), client());
    expect(upsertTask).not.toHaveBeenCalled();
    expect(submitMutationV2).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        kind: 'materialization.observe',
        snapshot: expect.objectContaining({
          status: 'deleted',
          availability: 'unavailable',
        }),
      }),
    }));
  });

  it('attaches an exact imported Microsoft To Do tuple without creating a task', async () => {
    findByProviderIdentity.mockResolvedValue({
      id: 'mc-imported',
      updatedAt: NOW,
    });

    const importedPage = page({
      taskMaterializations: [{
        contractVersion: 2,
        relationId: RELATION_ID,
        revision: 1,
        actionId: ACTION_ID,
        underlying: {
          providerId: 'microsoft-todo',
          providerAccountId: 'todo-connector',
          providerContainerId: 'list-1',
          providerTaskId: 'todo-task-1',
        },
        state: 'linked',
        snapshot: {
          providerLabel: 'Microsoft To Do',
          providerIconKey: 'microsoft-todo',
          title: 'Imported',
          status: 'in-progress',
          providerVersion: 'etag-1',
          openUrl: 'https://mc.example.test/tasks/mc-imported',
          observedAt: NOW,
          availability: 'live',
        },
        createdAt: NOW,
        updatedAt: NOW,
      }],
    });

    await attachImportedRyMessageManagers(
      importedPage,
      client(),
      'rymessage-1',
      'https://mc.example.test',
    );
    expect(findByProviderIdentity).toHaveBeenCalledWith({
      connectorInstanceId: 'todo-connector',
      providerContainerId: 'list-1',
      providerTaskId: 'todo-task-1',
    });
    expect(upsertTask).not.toHaveBeenCalled();
    expect(submitMutationV2).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        kind: 'materialization.attach-manager',
        managerTaskId: 'mc-imported',
      }),
    }));
  });

  it('emits explicit unlink without deleting the provider task', async () => {
    await unlinkRyMessageMaterialization({
      connectorId: 'rymessage-1',
      actionId: ACTION_ID,
      relationId: RELATION_ID,
      expectedRevision: 4,
    });
    expect(submitMutationV2).toHaveBeenCalledWith({
      contractVersion: '2.0',
      operationId: expect.any(String),
      actionId: ACTION_ID,
      expectedRevision: 4,
      mutation: {
        kind: 'materialization.unlink',
        relationId: RELATION_ID,
      },
    });
    expect(upsertTask).not.toHaveBeenCalled();
  });

  it('fails a managed edit when the provider adapter is unavailable without local fallback', async () => {
    getTask.mockResolvedValue({
      id: 'mc-task',
      sourceId: 'owner/repo#1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: 'Old',
      status: 'todo',
      updatedAt: NOW,
      metadata: {},
    });
    getOrInitializeConnector.mockResolvedValue(null);
    const feed = page({
      managedTaskCommands: [{
        commandId: '00000000-0000-4000-8000-000000000030',
        revision: 1,
        actionId: ACTION_ID,
        relationId: RELATION_ID,
        kind: 'patch',
        patch: { title: 'New' },
        state: 'pending',
        createdAt: NOW,
        updatedAt: NOW,
      }],
    } as never);
    await applyManagedRyMessageCommands(feed, client());
    expect(upsertTask).not.toHaveBeenCalled();
    expect(submitMutationV2).toHaveBeenLastCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        kind: 'managed-task-command.fail',
        failureCode: 'provider_update_unavailable',
      }),
    }));
  });

  it('rejects stale manager versions and unsupported provider fields before provider mutation', async () => {
    getTask.mockResolvedValue({
      id: 'mc-task',
      sourceId: 'owner/repo#1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: 'Old',
      status: 'todo',
      priority: 'none',
      updatedAt: '2026-09-29T23:00:00.000Z',
      metadata: {},
    });
    const stale = page({
      managedTaskCommands: [{
        commandId: '00000000-0000-4000-8000-000000000031',
        revision: 1,
        actionId: ACTION_ID,
        relationId: RELATION_ID,
        expectedManagerVersion: NOW,
        kind: 'patch',
        patch: { title: 'New' },
        state: 'pending',
        createdAt: NOW,
        updatedAt: NOW,
      }],
    } as never);
    await applyManagedRyMessageCommands(stale, client());
    expect(getOrInitializeConnector).not.toHaveBeenCalled();
    expect(submitMutationV2).toHaveBeenLastCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        kind: 'managed-task-command.fail',
        failureCode: 'manager_version_conflict',
      }),
    }));

    vi.clearAllMocks();
    getTask.mockResolvedValue({
      id: 'mc-task',
      sourceId: 'owner/repo#1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: 'Old',
      status: 'todo',
      priority: 'none',
      updatedAt: NOW,
      metadata: {},
    });
    submitMutationV2.mockResolvedValue({ outcome: 'applied', revision: 2 });
    const unsupported = page({
      managedTaskCommands: [{
        commandId: '00000000-0000-4000-8000-000000000032',
        revision: 1,
        actionId: ACTION_ID,
        relationId: RELATION_ID,
        kind: 'patch',
        patch: { dueAt: '2026-09-30T22:00:00.000Z' },
        state: 'pending',
        createdAt: NOW,
        updatedAt: NOW,
      }],
    } as never);
    await applyManagedRyMessageCommands(unsupported, client());
    expect(getOrInitializeConnector).not.toHaveBeenCalled();
    expect(submitMutationV2).toHaveBeenLastCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        kind: 'managed-task-command.fail',
        failureCode: 'provider_field_unsupported',
      }),
    }));
  });
});
