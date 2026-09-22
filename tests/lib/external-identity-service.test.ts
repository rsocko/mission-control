import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import type { ExternalIdentityWrite } from '@/lib/external-identities/types';

vi.unmock('drizzle-orm');

const directory = mkdtempSync(join(tmpdir(), 'mc-external-identity-service-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let service: typeof import('@/lib/external-identities/service');

beforeAll(async () => {
  database = await importInitializedSqliteDatabase();
  schema = await import('@/db/schema');
  service = await import('@/lib/external-identities/service');
  const now = '2026-08-08T12:00:00.000Z';
  database.default.insert(schema.connectorConfigs).values([
    connector('github-shadow', now),
    connector('github-disabled', now),
  ]).run();
  database.default.insert(schema.githubIdentityMigrations).values([
    { connectorInstanceId: 'github-shadow', phase: 'shadow_write', updatedAt: now },
    { connectorInstanceId: 'github-disabled', phase: 'disabled', updatedAt: now },
  ]).run();
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('external identity persistence service', () => {
  it('enforces Stage 1 migration phase transitions', async () => {
    const now = '2026-08-08T13:00:00.000Z';
    database.default.insert(schema.connectorConfigs).values([
      connector('github-transition-disabled', now),
      connector('github-transition-shadow', now),
    ]).run();
    database.default.insert(schema.githubIdentityMigrations).values([
      { connectorInstanceId: 'github-transition-disabled', phase: 'disabled', updatedAt: now },
      { connectorInstanceId: 'github-transition-shadow', phase: 'shadow_write', updatedAt: now },
    ]).run();

    await expect(service.updateGitHubIdentityPhase(
      'github-transition-disabled',
      'backfilling',
      now,
    )).rejects.toThrow('cannot transition from disabled to backfilling');
    await expect(service.updateGitHubIdentityPhase(
      'github-transition-shadow',
      'paused',
      now,
    )).rejects.toThrow('cannot transition from shadow_write to paused');

    await service.updateGitHubIdentityPhase('github-transition-shadow', 'backfilling', now);
    await service.updateGitHubIdentityPhase('github-transition-shadow', 'paused', now);
    await service.updateGitHubIdentityPhase('github-transition-shadow', 'backfilling', now);
    expect(await service.getGitHubIdentityPhase('github-transition-shadow')).toBe('backfilling');
  });

  it('creates idempotent repository and issue bindings with locator history', async () => {
    const initial = issueWrite('github-shadow', 'task-1', 'I_1', 'R_1');
    expect((await service.persistExternalIdentityBatch([initial]))[0].state).toBe('bound');
    await service.persistExternalIdentityBatch([initial]);

    const issueEntity = database.default.select().from(schema.externalEntities)
      .where(eq(schema.externalEntities.entityType, 'issue')).get();
    expect(issueEntity).toBeDefined();
    expect(database.default.select().from(schema.externalEntityLocators)
      .where(eq(schema.externalEntityLocators.externalEntityId, issueEntity!.id)).all()).toHaveLength(1);

    const renamed = issueWrite('github-shadow', 'task-1', 'I_1', 'R_1', 'renamed-owner', 'renamed-repo');
    await service.persistExternalIdentityBatch([renamed]);
    const locators = database.default.select().from(schema.externalEntityLocators)
      .where(eq(schema.externalEntityLocators.externalEntityId, issueEntity!.id))
      .orderBy(schema.externalEntityLocators.locatorRevision)
      .all();
    expect(locators).toHaveLength(2);
    expect(locators[0].validTo).not.toBeNull();
    expect(locators[1]).toMatchObject({
      owner: 'renamed-owner',
      repository: 'renamed-repo',
      validTo: null,
      locatorRevision: 2,
    });
  });

  it('records collisions without selecting a winner', async () => {
    const first = issueWrite(
      'github-shadow',
      'task-collision-a',
      'I_collision',
      'R_collision',
      'collision-owner',
      'collision-repo',
    );
    const second = issueWrite(
      'github-shadow',
      'task-collision-b',
      'I_collision',
      'R_collision',
      'collision-owner',
      'collision-repo',
    );
    expect((await service.persistExternalIdentityBatch([first]))[0].state).toBe('bound');
    expect((await service.persistExternalIdentityBatch([second]))[0]).toMatchObject({
      state: 'collision',
      collisionCategory: 'multiple_local_one_stable',
    });

    const collisions = database.default.select().from(schema.githubIdentityCollisions).all();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      state: 'open',
      category: 'multiple_local_one_stable',
      localIds: ['task-collision-a', 'task-collision-b'],
    });
    expect(database.default.select().from(schema.externalEntityBindings)
      .where(eq(schema.externalEntityBindings.localId, 'task-collision-b')).all()).toEqual([]);
  });

  it('reopens collision fingerprints and rejects one local row with two identities', async () => {
    const first = issueWrite(
      'github-shadow',
      'task-rebound',
      'I_rebound_1',
      'R_rebound',
      'rebound-owner',
      'rebound-repo',
    );
    const second = issueWrite(
      'github-shadow',
      'task-rebound',
      'I_rebound_2',
      'R_rebound',
      'rebound-owner',
      'rebound-repo',
    );
    expect((await service.persistExternalIdentityBatch([first]))[0].state).toBe('bound');
    expect((await service.persistExternalIdentityBatch([second]))[0]).toMatchObject({
      state: 'collision',
      collisionCategory: 'one_local_multiple_stable',
    });
    const collision = database.default.select().from(schema.githubIdentityCollisions)
      .where(eq(schema.githubIdentityCollisions.category, 'one_local_multiple_stable')).get()!;
    database.default.update(schema.githubIdentityCollisions).set({
      state: 'resolved',
      resolution: { rationale: 'test resolution' },
      resolvedAt: '2026-08-08T14:00:00.000Z',
      resolvedBy: 'operator',
    }).where(eq(schema.githubIdentityCollisions.id, collision.id)).run();

    await service.persistExternalIdentityBatch([second]);
    expect(database.default.select().from(schema.githubIdentityCollisions)
      .where(eq(schema.githubIdentityCollisions.id, collision.id)).get()).toMatchObject({
      state: 'open',
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  it('keeps identical node IDs distinct across hosts', async () => {
    const github = issueWrite(
      'github-shadow',
      'task-host-github',
      'I_shared',
      'R_host_github',
      'host-owner',
      'host-repo',
    );
    const enterprise = issueWrite(
      'github-shadow',
      'task-host-enterprise',
      'I_shared',
      'R_host_enterprise',
      'host-owner',
      'host-repo',
    );
    enterprise.evidence.entity.identity.hostKey = 'github.example.com';
    enterprise.evidence.repository!.identity.hostKey = 'github.example.com';
    enterprise.evidence.entity.locator.webUrl = 'https://github.example.com/owner/repo/issues/1';
    enterprise.evidence.repository!.locator.webUrl = 'https://github.example.com/owner/repo';

    expect((await service.persistExternalIdentityBatch([github]))[0].state).toBe('bound');
    expect((await service.persistExternalIdentityBatch([enterprise]))[0].state).toBe('bound');
    const shared = database.default.select().from(schema.externalEntities)
      .where(eq(schema.externalEntities.stableId, 'I_shared')).all();
    expect(shared.map((row) => row.hostKey).sort()).toEqual([
      'github.com',
      'github.example.com',
    ]);
  });

  it('persists 100-row pages with bounded queries, latency, and storage', async () => {
    const writes = Array.from({ length: 100 }, (_, index) => issueWrite(
      'github-shadow',
      `bulk-task-${index}`,
      `I_bulk_${index}`,
      'R_bulk',
      'bulk-owner',
      'bulk-repo',
      index + 1,
    ));
    const pageSize = database.sqlite.pragma('page_size', { simple: true }) as number;
    const pagesBefore = database.sqlite.pragma('page_count', { simple: true }) as number;
    const operationBaseline = database.getDatabaseTelemetry().sampleInterval.operationCount;
    const durations: number[] = [];

    for (let sample = 0; sample < 20; sample++) {
      const startedAt = performance.now();
      const results = await service.persistExternalIdentityBatch(writes);
      durations.push(performance.now() - startedAt);
      expect(results.every((result) => result.state === 'bound')).toBe(true);
    }

    const operationCount = database.getDatabaseTelemetry().sampleInterval.operationCount
      - operationBaseline;
    const sortedDurations = [...durations].sort((left, right) => left - right);
    const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1];
    const p99 = sortedDurations[Math.ceil(sortedDurations.length * 0.99) - 1];
    const pagesAfter = database.sqlite.pragma('page_count', { simple: true }) as number;

    expect(operationCount / durations.length).toBeLessThanOrEqual(12);
    expect(p95).toBeLessThan(100);
    expect(p99).toBeLessThan(500);
    expect(((pagesAfter - pagesBefore) * pageSize) / writes.length).toBeLessThan(2048);
  });
});

function connector(id: string, now: string) {
  return {
    id,
    type: 'github-issues',
    name: id,
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: { token: 'test-token' },
    settings: { repos: ['owner/repo'] },
    syncedLists: ['owner/repo'],
    createdAt: now,
    updatedAt: now,
  };
}

function issueWrite(
  connectorInstanceId: string,
  localId: string,
  issueStableId: string,
  repositoryStableId: string,
  owner = 'owner',
  repository = 'repo',
  issueNumber = 1,
): ExternalIdentityWrite {
  const observedAt = owner === 'owner'
    ? '2026-08-08T12:00:00.000Z'
    : '2026-08-08T13:00:00.000Z';
  return {
    target: {
      connectorInstanceId,
      bindingType: 'task',
      localId,
      legacyIdentity: `${owner}/${repository}:${issueNumber}`,
    },
    evidence: {
      repository: {
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'repository',
          stableId: repositoryStableId,
        },
        locator: {
          owner,
          repository,
          webUrl: `https://github.com/${owner}/${repository}`,
        },
        observationSource: 'graphql',
        observedAt,
      },
      entity: {
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue',
          stableId: issueStableId,
        },
        locator: {
          owner,
          repository,
          issueNumber,
          webUrl: `https://github.com/${owner}/${repository}/issues/${issueNumber}`,
        },
        observationSource: 'graphql',
        observedAt,
      },
    },
  };
}
