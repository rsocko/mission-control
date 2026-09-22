import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import type { ExternalEntityIdentity } from '@/lib/external-identities';

vi.unmock('drizzle-orm');

const directory = mkdtempSync(join(tmpdir(), 'mc-external-identity-public-api-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identity: typeof import('@/lib/external-identities');

beforeAll(async () => {
  database = await importInitializedSqliteDatabase();
  schema = await import('@/db/schema');
  identity = await import('@/lib/external-identities');
  const now = '2026-08-09T04:00:00.000Z';
  database.default.insert(schema.connectorConfigs).values({
    id: 'public-api-connector',
    type: 'github-issues',
    name: 'Public API connector',
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: { token: 'test-token' },
    settings: { repos: ['owner/repository'] },
    syncedLists: ['owner/repository'],
    createdAt: now,
    updatedAt: now,
  }).run();
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('external identity public repository API', () => {
  it('constructs exact keys and safely upserts and looks up entities', async () => {
    const key = identity.createExternalEntityKey({
      provider: 'github',
      hostKey: 'github.example.com',
      entityType: 'repository',
      stableId: 'R_public',
    });
    expect(Object.isFrozen(key)).toBe(true);

    const created = await identity.upsertExternalEntity({
      identity: key,
      observedAt: '2026-08-09T04:01:00.000Z',
    });
    const repeated = await identity.upsertExternalEntity({
      identity: key,
      observedAt: '2026-08-09T04:00:30.000Z',
    });

    expect(repeated.id).toBe(created.id);
    expect(repeated.lastSeenAt).toBe('2026-08-09T04:01:00.000Z');
    expect(await identity.getExternalEntityByKey(key)).toEqual(repeated);
    expect(await identity.getExternalEntityByKey(identity.createExternalEntityKey({
      ...key,
      stableId: 'R_missing',
    }))).toBeNull();
    expect(identity.normalizeExternalEntityLocator({
      owner: 'Mixed-Owner',
      repository: 'Mixed-Repository',
    })).toMatchObject({
      ownerKey: 'mixed-owner',
      repositoryKey: 'mixed-repository',
      issueNumber: null,
    });
  });

  it('observes operator locator revisions idempotently and reads history', async () => {
    const entity = await identity.upsertExternalEntity({
      identity: repositoryIdentity('R_locator'),
      observedAt: '2026-08-09T04:02:00.000Z',
    });
    const initial = locatorObservation(entity.id, entity.identity, 'owner', 'repository', '2026-08-09T04:02:00.000Z');

    const first = await identity.observeOperatorExternalEntityLocator(initial);
    const repeated = await identity.observeOperatorExternalEntityLocator({
      ...initial,
      observedAt: '2026-08-09T04:03:00.000Z',
    });
    const renamed = await identity.observeOperatorExternalEntityLocator({
      ...initial,
      locator: { owner: 'renamed-owner', repository: 'renamed-repository' },
      observedAt: '2026-08-09T04:04:00.000Z',
    });

    expect(first).toMatchObject({ state: 'update', locatorRecord: { locatorRevision: 1 } });
    expect(repeated).toMatchObject({ state: 'unchanged', locatorRecord: { locatorRevision: 1 } });
    expect(renamed).toMatchObject({ state: 'update', locatorRecord: { locatorRevision: 2 } });
    expect(await identity.getCurrentExternalEntityLocator(entity.id)).toMatchObject({
      owner: 'renamed-owner',
      repository: 'renamed-repository',
      locatorRevision: 2,
      validTo: null,
    });
    expect(await identity.listExternalEntityLocatorHistory(entity.id)).toMatchObject([
      { locatorRevision: 1, validTo: '2026-08-09T04:04:00.000Z' },
      { locatorRevision: 2, validTo: null },
    ]);
  });

  it('participates in caller-owned transactions and rolls back atomically', async () => {
    const key = identity.createExternalEntityKey(repositoryIdentity('R_rollback'));
    expect(() => database.runTransaction((tx) => {
      const entity = identity.upsertExternalEntityInTransaction(tx, {
        identity: key,
        observedAt: '2026-08-09T04:05:00.000Z',
      });
      identity.observeOperatorExternalEntityLocatorInTransaction(
        tx,
        locatorObservation(
          entity.id,
          entity.identity,
          'rollback-owner',
          'rollback-repository',
          '2026-08-09T04:05:00.000Z',
        ),
      );
      throw new Error('rollback public identity transaction');
    })).toThrow('rollback public identity transaction');

    expect(await identity.getExternalEntityByKey(key)).toBeNull();
  });

  it('preflights locator collisions, records them durably, and makes no partial update', async () => {
    const firstEntity = await identity.upsertExternalEntity({
      identity: repositoryIdentity('R_collision_public_1'),
      observedAt: '2026-08-09T04:06:00.000Z',
    });
    const secondEntity = await identity.upsertExternalEntity({
      identity: repositoryIdentity('R_collision_public_2'),
      observedAt: '2026-08-09T04:06:00.000Z',
    });
    await identity.observeOperatorExternalEntityLocator(locatorObservation(
      firstEntity.id,
      firstEntity.identity,
      'collision-owner',
      'collision-repository',
      '2026-08-09T04:06:00.000Z',
    ));
    const conflicting = locatorObservation(
      secondEntity.id,
      secondEntity.identity,
      'collision-owner',
      'collision-repository',
      '2026-08-09T04:07:00.000Z',
    );

    expect(await identity.preflightExternalEntityLocator(conflicting)).toMatchObject({
      state: 'collision',
      collisionCategory: 'repository_path_replacement',
      conflictingEntityId: firstEntity.id,
    });
    expect(await identity.observeOperatorExternalEntityLocator(conflicting)).toMatchObject({
      state: 'collision',
      locatorRecord: null,
    });
    expect(await identity.listExternalEntityLocatorHistory(secondEntity.id)).toEqual([]);
    expect(await identity.getCurrentExternalEntityLocator(firstEntity.id)).toMatchObject({
      owner: 'collision-owner',
      repository: 'collision-repository',
      validTo: null,
    });

    const collisionInput = {
      connectorInstanceId: 'public-api-connector',
      category: 'repository_path_replacement' as const,
      bindingType: 'source_list' as const,
      localIds: ['source-list-2', 'source-list-1'],
      externalEntityIds: [secondEntity.id, firstEntity.id],
      legacyIdentity: 'collision-owner/collision-repository',
      observedAt: '2026-08-09T04:07:00.000Z',
    };
    const recorded = await identity.recordExternalIdentityCollision(collisionInput);
    const repeated = await identity.recordExternalIdentityCollision({
      ...collisionInput,
      observedAt: '2026-08-09T04:08:00.000Z',
    });
    expect(repeated).toMatchObject({
      id: recorded.id,
      fingerprint: recorded.fingerprint,
      state: 'open',
      localIds: ['source-list-1', 'source-list-2'],
      lastSeenAt: '2026-08-09T04:08:00.000Z',
    });
    expect(database.default.select().from(schema.githubIdentityCollisions).all()).toHaveLength(1);

    expect(() => database.runTransaction((tx) => {
      identity.recordExternalIdentityCollisionInTransaction(tx, {
        ...collisionInput,
        category: 'locator_overlap_or_regression',
        observedAt: '2026-08-09T04:09:00.000Z',
      });
      throw new Error('rollback collision record');
    })).toThrow('rollback collision record');
    expect(database.default.select().from(schema.githubIdentityCollisions).all()).toHaveLength(1);
  });
});

function repositoryIdentity(stableId: string) {
  return {
    provider: 'github',
    hostKey: 'github.com',
    entityType: 'repository' as const,
    stableId,
  };
}

function locatorObservation(
  entityId: string,
  entityIdentity: ExternalEntityIdentity,
  owner: string,
  repository: string,
  observedAt: string,
) {
  return {
    entityId,
    identity: entityIdentity,
    locator: { owner, repository },
    observedAt,
  };
}
