import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  companionTaskRelationIdV2,
  isCompanionActionFeedPageV2,
  isCompanionActionMutationRequestV2,
  isCompanionTaskMaterializationV2,
  isManagedTaskCommandV1,
  normalizeTrustedOrigin,
  normalizeTrustedTaskUrl,
  type CompanionTaskMaterializationV2,
} from '@/lib/connectors/rymessage/action-contract-v2';
import {
  isCompanionActionV1,
  type CompanionActionV1,
} from '@/lib/connectors/rymessage/action-contract';

const NOW = '2026-09-29T22:00:00.000Z';

function uuidFromDigest(namespace: string, value: string): string {
  const bytes = createHash('sha256')
    .update(`${namespace}\0`, 'utf8')
    .update(value, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

function action(): CompanionActionV1 {
  const stableKey = `ak1:${'a'.repeat(64)}`;
  return {
    contractVersion: 1,
    actionId: uuidFromDigest('rymessage:action:v1', stableKey),
    stableKey,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    source: {
      identity: { kind: 'provider_message', provider: 'microsoft', id: 'private' },
      sourceKind: 'message',
    },
    content: { title: 'Review report', actionType: 'follow-up', priority: 'high' },
    classification: {
      derivationMethod: 'deterministic',
      inputFingerprint: 'b'.repeat(64),
    },
    lifecycle: { state: 'visible' },
    fieldRevisions: { title: 1, lifecycle: 1 },
    materializations: [],
  };
}

function materialization(actionId: string): CompanionTaskMaterializationV2 {
  const tuple = {
    actionId,
    providerId: 'microsoft-todo',
    providerAccountId: 'account',
    providerContainerId: 'list',
    providerTaskId: 'task',
  };
  return {
    relationId: companionTaskRelationIdV2(tuple),
    revision: 1,
    providerId: tuple.providerId,
    providerAccountId: tuple.providerAccountId,
    providerContainerId: tuple.providerContainerId,
    providerTaskId: tuple.providerTaskId,
    state: 'linked',
    snapshot: {
      providerLabel: 'Microsoft To Do',
      providerIconKey: 'microsoft-todo',
      title: 'Review report',
      status: 'in-progress',
      providerVersion: 'etag-1',
      openUrl: 'https://tasks.example.test/task',
      observedAt: NOW,
      availability: 'live',
    },
    updatedAt: NOW,
  };
}

describe('Companion ActionV2 contract', () => {
  it('pins the standard relation UUIDv5 vector without tuple normalization', () => {
    expect(companionTaskRelationIdV2({
      actionId: '00000000-0000-4000-8000-000000000001',
      providerId: 'microsoft-todo',
      providerAccountId: 'account',
      providerContainerId: 'list',
      providerTaskId: 'task',
    })).toBe('cc1ee9ad-ad34-5b29-957c-08fb19507768');
  });

  it('validates tuple-derived relation identity and bounded task commands', () => {
    const canonicalAction = action();
    const relation = materialization(canonicalAction.actionId);
    expect(isCompanionTaskMaterializationV2(relation, canonicalAction.actionId)).toBe(true);
    expect(isCompanionTaskMaterializationV2({
      ...relation,
      relationId: '00000000-0000-4000-8000-000000000002',
    }, canonicalAction.actionId)).toBe(false);
    expect(isManagedTaskCommandV1({
      commandId: '00000000-0000-4000-8000-000000000003',
      revision: 1,
      actionId: canonicalAction.actionId,
      relationId: relation.relationId,
      kind: 'patch',
      patch: { status: 'completed', notes: '' },
      state: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    })).toBe(true);
    expect(isManagedTaskCommandV1({
      commandId: '00000000-0000-4000-8000-000000000003',
      revision: 1,
      actionId: canonicalAction.actionId,
      relationId: relation.relationId,
      kind: 'patch',
      patch: { status: 'deleted' },
      state: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    })).toBe(false);
  });

  it('accepts an additive V2 page while preserving the exact V1 action validator', () => {
    const canonicalAction = action();
    const relation = materialization(canonicalAction.actionId);
    expect(isCompanionActionFeedPageV2({
      schemaVersion: '2.0',
      feedId: '00000000-0000-4000-8000-000000000010',
      mode: 'full',
      producedAt: NOW,
      nextCursor: 'cursor',
      complete: true,
      items: [{
        eventId: '00000000-0000-4000-8000-000000000011',
        operationId: '00000000-0000-4000-8000-000000000012',
        aggregateId: canonicalAction.actionId,
        aggregateVersion: 1,
        sourceId: 'source',
        occurredAt: NOW,
        kind: 'upsert',
        action: canonicalAction,
        taskMaterializations: [relation],
        creationIntents: [],
        managedTaskCommands: [],
        taskLifecycleProvenance: {
          source: 'task-aggregate',
          state: 'linked',
          updatedAt: NOW,
        },
      }],
    }, isCompanionActionV1)).toBe(true);
  });

  it('enforces exact trusted origins and strips no task URL data silently', () => {
    expect(normalizeTrustedOrigin('HTTP://LOCALHOST:3099')).toBe('http://localhost:3099');
    expect(normalizeTrustedOrigin('http://localhost:3099/path')).toBeNull();
    expect(normalizeTrustedTaskUrl(
      'http://localhost:3099/tasks/123',
      'http://localhost:3099',
    )).toBe('http://localhost:3099/tasks/123');
    expect(normalizeTrustedTaskUrl(
      'http://localhost:3099/tasks/123?token=secret',
      'http://localhost:3099',
    )).toBeNull();
    expect(normalizeTrustedTaskUrl(
      'http://127.0.0.1:3099/tasks/123',
      'http://localhost:3099',
    )).toBeNull();
  });

  it('freezes provider-neutral register, attach-manager, and unlink envelopes', () => {
    const actionId = action().actionId;
    const operationId = '00000000-0000-4000-8000-000000000021';
    const intentId = '00000000-0000-4000-8000-000000000022';
    expect(isCompanionActionMutationRequestV2({
      contractVersion: '2.0',
      operationId,
      actionId,
      expectedRevision: 1,
      mutation: {
        kind: 'creation-intent.register',
        intentId,
        draft: {
          title: 'Review report',
          notes: 'Portable notes',
          dueAt: NOW,
          reminderAt: NOW,
          priority: true,
        },
      },
    })).toBe(true);
    expect(isCompanionActionMutationRequestV2({
      contractVersion: '2.0',
      operationId,
      actionId,
      expectedRevision: 1,
      mutation: {
        kind: 'creation-intent.register',
        intentId,
        draft: {
          title: 'Review report',
          providerAccountId: 'forbidden',
        },
      },
    })).toBe(false);

    const relation = materialization(actionId);
    expect(isCompanionActionMutationRequestV2({
      contractVersion: '2.0',
      operationId,
      actionId,
      expectedRevision: 2,
      mutation: {
        kind: 'materialization.attach-manager',
        relationId: relation.relationId,
        underlying: {
          providerId: relation.providerId,
          providerAccountId: relation.providerAccountId,
          providerContainerId: relation.providerContainerId,
          providerTaskId: relation.providerTaskId,
        },
        snapshot: relation.snapshot,
        managerTaskId: 'mc-task-1',
        managerVersion: '7',
        managerCanonicalUrl: 'https://mc.example.test/tasks/mc-task-1',
      },
    })).toBe(true);
    expect(isCompanionActionMutationRequestV2({
      contractVersion: '2.0',
      operationId,
      actionId,
      expectedRevision: 3,
      mutation: {
        kind: 'materialization.unlink',
        relationId: relation.relationId,
      },
    })).toBe(true);
  });
});
