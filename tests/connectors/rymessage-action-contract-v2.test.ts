import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  companionActionV2Digest,
  companionTaskRelationIdV2,
  isCompanionActionFeedPageV2,
  isCompanionActionMutationReceiptV2,
  isCompanionActionMutationRequestV2,
  isCompanionTaskMaterializationV2,
  isManagedTaskCommandV1,
  normalizeTrustedOrigin,
  normalizeTrustedTaskUrl,
} from '@/lib/connectors/rymessage/action-contract-v2';
import { isCompanionActionV1 } from '@/lib/connectors/rymessage/action-contract';

const FIXTURE_ROOT = join(
  process.cwd(),
  'tests',
  'fixtures',
  'rymessage-action-task-links',
  'v2',
);
const NOW = '2026-01-02T03:04:05.000Z';
const ACTION_ID = '00000000-0000-4000-8000-000000000001';
const RELATION_ID = 'cc1ee9ad-ad34-5b29-957c-08fb19507768';
const TRUSTED_MC_ORIGIN = 'https://mission-control.example';
const TRUSTED_ORIGINS = new Set([
  TRUSTED_MC_ORIGIN,
  'https://github.com',
  'https://to-do.office.com',
]);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fixtureText(name)) as Record<string, unknown>;
}

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, name), 'utf8').replaceAll('\r\n', '\n');
}

function hydrateFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)
    .replaceAll('<feed-id>', '00000000-0000-4000-8000-000000000010')
    .replaceAll('<timestamp>', NOW)
    .replaceAll('<opaque-cursor>', 'cursor')
    .replaceAll('<event-id>', '00000000-0000-4000-8000-000000000011')
    .replaceAll('<operation-id>', '00000000-0000-4000-8000-000000000012')
    .replaceAll('<action-id>', ACTION_ID)) as T;
}

function snapshot() {
  return {
    providerLabel: 'Microsoft To Do',
    providerIconKey: 'microsoft-todo',
    title: 'Review report',
    status: 'in-progress',
    observedAt: NOW,
    availability: 'live',
  };
}

function request(mutation: Record<string, unknown>) {
  return {
    contractVersion: '2.0',
    operationId: '00000000-0000-4000-8000-000000000021',
    actionId: ACTION_ID,
    expectedRevision: 1,
    mutation,
  };
}

describe('Companion ActionV2 canonical contract parity', () => {
  it('pins the normalized bytes of all three vendored RyMessage #1184 fixtures', () => {
    const expectedHashes = {
      'materializations.json':
        '2c7f37f0953f15a0f5cd7312254237cdab6a8641ce4f719ec95c150c43e00655',
      'mutations.json':
        '74603a39b7e348038273974ea8fc4dd501bd1e6216852c655650f7d29a4f7579',
      'feed-page.json':
        '2db759654bec4f2feb798b04aa62a2b5e59183a6dac99c2fcb513ffb4f0048e7',
    };
    for (const [name, expectedHash] of Object.entries(expectedHashes)) {
      expect(createHash('sha256').update(fixtureText(name), 'utf8').digest('hex'))
        .toBe(expectedHash);
    }
  });

  it('validates the byte-equivalent frozen RyMessage materialization fixture', () => {
    const value = fixture('materializations.json');
    const trustedOrigins = new Set(value.trustedOrigins as string[]);
    expect(value.materializations).toEqual(expect.any(Array));
    for (const materialization of value.materializations as unknown[]) {
      expect(isCompanionTaskMaterializationV2(materialization, trustedOrigins)).toBe(true);
    }
    expect(value.expectedTaskLifecycle).toEqual({
      state: 'linked',
      provenance: 'task-aggregate',
    });
  });

  it('validates every frozen RyMessage request and receipt without shape widening', () => {
    const value = fixture('mutations.json');
    expect(value.path).toBe('/v2/integrations/action-feed/mutations');
    for (const candidate of Object.values(value.requests as Record<string, unknown>)) {
      expect(isCompanionActionMutationRequestV2(candidate, TRUSTED_ORIGINS)).toBe(true);
    }
    for (const candidate of Object.values(value.receipts as Record<string, unknown>)) {
      expect(isCompanionActionMutationReceiptV2(candidate)).toBe(true);
    }
    const attach = (value.requests as Record<string, Record<string, unknown>>).attachManager;
    expect(isCompanionActionMutationRequestV2({
      ...attach,
      mutation: {
        ...(attach.mutation as Record<string, unknown>),
        managerCanonicalUrl: 'https://attacker.example/tasks/1',
      },
    }, new Set([TRUSTED_MC_ORIGIN]))).toBe(false);
  });

  it('accepts the canonical V1-plus-projection route envelope and rejects flattening', () => {
    const wrapper = fixture('feed-page.json');
    expect(wrapper.path).toBe('/v2/integrations/action-feed');
    const page = hydrateFixture(wrapper.upsertPage as Record<string, unknown>);
    expect(isCompanionActionFeedPageV2(
      page,
      isCompanionActionV1,
      TRUSTED_ORIGINS,
    )).toBe(true);
    const upsert = (page.items as Array<Record<string, unknown>>)[0]!;
    const projection = upsert.projection as Record<string, unknown>;
    const flattened = {
      ...upsert,
      ...projection,
    };
    delete flattened.projection;
    expect(isCompanionActionFeedPageV2({
      ...page,
      items: [flattened],
    }, isCompanionActionV1, TRUSTED_ORIGINS)).toBe(false);
    expect(isCompanionActionFeedPageV2({
      ...page,
      items: [{
        ...upsert,
        projection: {
          ...projection,
          action: {
            ...(projection.action as Record<string, unknown>),
            content: {
              ...((projection.action as Record<string, unknown>)
                .content as Record<string, unknown>),
              title: 'Divergent title',
            },
          },
        },
      }],
    }, isCompanionActionV1, TRUSTED_ORIGINS)).toBe(false);

    const tombstoneItem = hydrateFixture(
      wrapper.tombstoneItem as Record<string, unknown>,
    );
    expect(isCompanionActionFeedPageV2({
      ...page,
      items: [tombstoneItem],
    }, isCompanionActionV1, TRUSTED_ORIGINS)).toBe(true);
    expect(tombstoneItem).not.toHaveProperty('projection');
    expect(tombstoneItem).not.toHaveProperty('action');
  });

  it('pins RFC 4122 UUIDv5 identity without tuple normalization', () => {
    expect(companionTaskRelationIdV2({
      actionId: ACTION_ID,
      providerId: 'microsoft-todo',
      providerAccountId: 'account',
      providerContainerId: 'list',
      providerTaskId: 'task',
    })).toBe(RELATION_ID);
    expect(companionTaskRelationIdV2({
      actionId: ACTION_ID,
      providerId: 'microsoft-todo',
      providerAccountId: 'Account',
      providerContainerId: 'list',
      providerTaskId: 'task',
    })).not.toBe(RELATION_ID);
  });

  it('uses canonical JSON for digest key-order equivalence and content changes', () => {
    expect(companionActionV2Digest({
      z: 1,
      nested: { b: true, a: ['x', 2] },
    })).toBe(companionActionV2Digest({
      nested: { a: ['x', 2], b: true },
      z: 1,
    }));
    expect(companionActionV2Digest({ a: 1 })).not.toBe(
      companionActionV2Digest({ a: 2 }),
    );
  });

  it('validates the canonical claim, fail, fulfill, observe, and command mutations', () => {
    const underlying = {
      providerId: 'microsoft-todo',
      providerAccountId: 'account',
      providerContainerId: 'list',
      providerTaskId: 'task',
    };
    const candidates = [
      { kind: 'creation-intent.claim', intentId: '00000000-0000-4000-8000-000000000011' },
      {
        kind: 'creation-intent.fail',
        intentId: '00000000-0000-4000-8000-000000000011',
        failureCode: 'provider_delivery_failed',
      },
      {
        kind: 'materialization.fulfill-intent',
        intentId: '00000000-0000-4000-8000-000000000011',
        relationId: RELATION_ID,
        underlying,
        snapshot: snapshot(),
        managerTaskId: 'mc-task',
        managerVersion: '7',
        managerCanonicalUrl: `${TRUSTED_MC_ORIGIN}/tasks/mc-task`,
      },
      {
        kind: 'materialization.observe',
        relationId: RELATION_ID,
        snapshot: snapshot(),
        state: 'linked',
        managerVersion: '8',
        managerCanonicalUrl: `${TRUSTED_MC_ORIGIN}/tasks/mc-task`,
      },
      {
        kind: 'managed-task-command.claim',
        commandId: '00000000-0000-4000-8000-000000000031',
      },
      {
        kind: 'managed-task-command.complete',
        commandId: '00000000-0000-4000-8000-000000000031',
        snapshot: snapshot(),
        managerVersion: '9',
      },
      {
        kind: 'managed-task-command.fail',
        commandId: '00000000-0000-4000-8000-000000000031',
        failureCode: 'provider_update_failed',
      },
    ];
    for (const mutation of candidates) {
      expect(isCompanionActionMutationRequestV2(
        request(mutation),
        new Set([TRUSTED_MC_ORIGIN]),
      )).toBe(true);
    }
  });

  it('enforces optional snapshots, exact bounds, and text semantics', () => {
    const materializations = fixture('materializations.json').materializations as unknown[];
    expect(isCompanionTaskMaterializationV2(
      materializations[0],
      TRUSTED_ORIGINS,
    )).toBe(true);
    expect(isCompanionTaskMaterializationV2({
      ...(materializations[0] as Record<string, unknown>),
      management: {
        manager: 'mission-control',
        managerInstanceId: 'm'.repeat(129),
        managerTaskId: 'task',
      },
    }, TRUSTED_ORIGINS)).toBe(false);
    expect(isCompanionActionMutationRequestV2(request({
      kind: 'creation-intent.register',
      intentId: '00000000-0000-4000-8000-000000000011',
      draft: { title: 'Valid', notes: 'control\u0007' },
    }))).toBe(false);
    expect(isManagedTaskCommandV1({
      commandId: '00000000-0000-4000-8000-000000000031',
      revision: 1,
      actionId: ACTION_ID,
      relationId: RELATION_ID,
      kind: 'patch',
      patch: { notes: '' },
      state: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    }, ACTION_ID)).toBe(true);
  });

  it('normalizes exact trusted origins and rejects origin drift', () => {
    expect(normalizeTrustedOrigin('HTTPS://MISSION-CONTROL.EXAMPLE')).toBe(
      TRUSTED_MC_ORIGIN,
    );
    expect(normalizeTrustedOrigin(`${TRUSTED_MC_ORIGIN}/path`)).toBeNull();
    expect(normalizeTrustedTaskUrl(
      `${TRUSTED_MC_ORIGIN}/tasks/123`,
      TRUSTED_MC_ORIGIN,
    )).toBe(`${TRUSTED_MC_ORIGIN}/tasks/123`);
    expect(normalizeTrustedTaskUrl(
      'https://attacker.example/tasks/123',
      TRUSTED_MC_ORIGIN,
    )).toBeNull();
  });
});
