import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExternalIdentityEvidence } from '@/lib/external-identities';
import {
  digestHistoricalProof,
  historicalProofDigestMatches,
} from '@/db/persistence/github-transfer-succession';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-github-task-transfer-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

const now = '2026-08-11T16:00:00.000Z';
let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identities: typeof import('@/lib/external-identities');
let service: typeof import('@/lib/connectors/github-issues/repoint-service');

beforeAll(async () => {
  database = await import('@/db');
  schema = await import('@/db/schema');
  identities = await import('@/lib/external-identities');
  service = await import('@/lib/connectors/github-issues/repoint-service');
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('historical GitHub task transfer reconciliation', () => {
  it('uses a JSONB-stable digest while accepting legacy SQLite proof digests', () => {
    const original = { requestedSourceId: 'a:1', successorSourceId: 'b:2' };
    const reordered = { successorSourceId: 'b:2', requestedSourceId: 'a:1' };
    const legacyDigest = createHash('sha256')
      .update(JSON.stringify(original))
      .digest('hex');

    expect(digestHistoricalProof(reordered)).toBe(digestHistoricalProof(original));
    expect(historicalProofDigestMatches(original, legacyDigest)).toBe(true);
  });

  it('records the exact historical endpoint to observable successor proof', async () => {
    const connectorId = 'historical-transfer-exact';
    const pair = await seedTransferPair(connectorId);
    const observation = restObservation(
      connectorId,
      'I_kwDOTWhjas8AAAABMFO0qg',
      'octo-org/mission-control:2402',
    );

    const request = {
      connectorInstanceId: connectorId,
      sourceTaskId: pair.sourceTaskId,
      successorTaskId: pair.successorTaskId,
      expectedRevision: 4,
      actor: 'test-operator',
      reason: 'REST historical endpoint resolves to the bound successor',
      idempotencyKey: 'historical-transfer-exact-1',
    };
    const dependencies = {
      now: () => new Date(now),
      remote: historicalRemote(observation),
    };
    const result = await service.reconcileHistoricalGitHubIssueTransfer(
      request,
      dependencies,
    );

    expect(result).toMatchObject({
      changed: true,
      sourceTaskId: pair.sourceTaskId,
      successorTaskId: pair.successorTaskId,
      proofKind: 'rest_historical_redirect',
    });
    expect(database.default.select()
      .from(schema.githubIdentityTaskTransferReconciliations).all())
      .toEqual([
        expect.objectContaining({
          connectorInstanceId: connectorId,
          sourceExternalEntityId: expect.any(String),
          successorExternalEntityId: expect.any(String),
          expectedModeRevision: 4,
          observedAt: now,
          proofDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          proof: expect.objectContaining({
            requestedSourceId: 'octo-org/tyrion:135',
            successorSourceId: 'octo-org/mission-control:2402',
            sourceStableId: 'I_kwDOTx0z_s8AAAABMEm6Ww',
            successorStableId: 'I_kwDOTWhjas8AAAABMFO0qg',
          }),
        }),
      ]);
    await expect(service.reconcileHistoricalGitHubIssueTransfer(
      request,
      dependencies,
    )).resolves.toMatchObject({ changed: false });

    const { and, eq } = await import('drizzle-orm');
    database.default.update(schema.externalEntityBindings).set({
      state: 'collision',
      updatedAt: now,
    }).where(and(
      eq(schema.externalEntityBindings.connectorInstanceId, connectorId),
      eq(schema.externalEntityBindings.localId, pair.successorTaskId),
    )).run();
    await expect(service.reconcileHistoricalGitHubIssueTransfer(
      request,
      dependencies,
    )).rejects.toThrow('has no active stable binding');
  });

  it('rejects stable-identity and canonical-locator near matches without persisting proof', async () => {
    const stableMismatchConnector = 'historical-transfer-stable-mismatch';
    const stableMismatchPair = await seedTransferPair(stableMismatchConnector);
    await expect(service.reconcileHistoricalGitHubIssueTransfer({
      connectorInstanceId: stableMismatchConnector,
      sourceTaskId: stableMismatchPair.sourceTaskId,
      successorTaskId: stableMismatchPair.successorTaskId,
      expectedRevision: 4,
      actor: 'test-operator',
      reason: 'Near-match stable identity must fail closed',
      idempotencyKey: 'historical-transfer-mismatch-1',
    }, {
      remote: historicalRemote(restObservation(
        stableMismatchConnector,
        'I_different_issue',
        'octo-org/mission-control:2402',
      )),
    })).rejects.toThrow('did not resolve to the successor stable identity');

    const locatorMismatchConnector = 'historical-transfer-locator-mismatch';
    const locatorMismatchPair = await seedTransferPair(locatorMismatchConnector);
    await expect(service.reconcileHistoricalGitHubIssueTransfer({
      connectorInstanceId: locatorMismatchConnector,
      sourceTaskId: locatorMismatchPair.sourceTaskId,
      successorTaskId: locatorMismatchPair.successorTaskId,
      expectedRevision: 4,
      actor: 'test-operator',
      reason: 'Near-match locator must fail closed',
      idempotencyKey: 'historical-transfer-mismatch-2',
    }, {
      remote: historicalRemote(restObservation(
        locatorMismatchConnector,
        'I_kwDOTWhjas8AAAABMFO0qg',
        'octo-org/mission-control:2403',
      )),
    })).rejects.toThrow('canonical locator does not match the successor task');

    const { inArray } = await import('drizzle-orm');
    expect(database.default.select()
      .from(schema.githubIdentityTaskTransferReconciliations)
      .where(inArray(
        schema.githubIdentityTaskTransferReconciliations.connectorInstanceId,
        [stableMismatchConnector, locatorMismatchConnector],
      )).all()).toHaveLength(0);
  });
});

async function seedTransferPair(connectorInstanceId: string): Promise<{
  sourceTaskId: string;
  successorTaskId: string;
}> {
  const sourceTaskId = `${connectorInstanceId}-historical-task`;
  const successorTaskId = `${connectorInstanceId}-successor-task`;
  database.default.insert(schema.connectorConfigs).values({
    id: connectorInstanceId,
    type: 'github-issues',
    name: connectorInstanceId,
    enabled: true,
    syncMode: 'manual',
    capabilities: { read: true, write: true },
    credentials: { token: 'test-token' },
    settings: { repos: ['octo-org/tyrion', 'octo-org/mission-control'] },
    syncedLists: ['octo-org/tyrion', 'octo-org/mission-control'],
    createdAt: now,
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId,
    phase: 'complete',
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId,
    modeRevision: 4,
    updatedAt: now,
  }).run();
  database.default.insert(schema.tasks).values([
    {
      id: sourceTaskId,
      sourceId: 'octo-org/tyrion:135',
      connectorType: 'github-issues',
      connectorInstanceId,
      title: 'Quick sort seems to re-show P3 items',
      status: 'cancelled',
      metadata: { issueNumber: 135, isDraft: false, isProjectDraft: false },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: successorTaskId,
      sourceId: 'octo-org/mission-control:2402',
      connectorType: 'github-issues',
      connectorInstanceId,
      title: 'Quick sort seems to re-show P3 items',
      status: 'done',
      metadata: { issueNumber: 2402, isDraft: false, isProjectDraft: false },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
  ]).run();
  await identities.persistExternalIdentityBatch([
    {
      target: {
        connectorInstanceId,
        bindingType: 'task',
        localId: sourceTaskId,
        legacyIdentity: 'octo-org/tyrion:135',
      },
      evidence: graphqlEvidence(
        connectorInstanceId,
        'I_kwDOTx0z_s8AAAABMEm6Ww',
        'octo-org/tyrion:135',
      ),
    },
    {
      target: {
        connectorInstanceId,
        bindingType: 'task',
        localId: successorTaskId,
        legacyIdentity: 'octo-org/mission-control:2402',
      },
      evidence: graphqlEvidence(
        connectorInstanceId,
        'I_kwDOTWhjas8AAAABMFO0qg',
        'octo-org/mission-control:2402',
      ),
    },
  ]);
  return { sourceTaskId, successorTaskId };
}

function historicalRemote(observation: ExternalIdentityEvidence) {
  return {
    async resolveRepository() {
      return null;
    },
    async resolveIssue() {
      return null;
    },
    async resolveHistoricalIssue() {
      return {
        evidence: observation,
        title: 'Quick sort seems to re-show P3 items',
        state: 'closed',
        stateReason: 'not_planned',
      };
    },
  };
}

function graphqlEvidence(
  connectorInstanceId: string,
  stableId: string,
  sourceId: string,
): ExternalIdentityEvidence {
  return evidence(connectorInstanceId, stableId, sourceId, 'graphql');
}

function restObservation(
  connectorInstanceId: string,
  stableId: string,
  sourceId: string,
): ExternalIdentityEvidence {
  return evidence(connectorInstanceId, stableId, sourceId, 'rest');
}

function evidence(
  connectorInstanceId: string,
  stableId: string,
  sourceId: string,
  observationSource: 'graphql' | 'rest',
): ExternalIdentityEvidence {
  const separator = sourceId.lastIndexOf(':');
  const [owner, repository] = sourceId.slice(0, separator).split('/');
  const issueNumber = Number(sourceId.slice(separator + 1));
  return {
    repository: {
      identity: {
        provider: 'github',
        hostKey: `${connectorInstanceId}.github.test`,
        entityType: 'repository',
        stableId: `R_${owner}_${repository}`,
      },
      locator: { owner, repository },
      observationSource,
      observedAt: now,
    },
    entity: {
      identity: {
        provider: 'github',
        hostKey: `${connectorInstanceId}.github.test`,
        entityType: 'issue',
        stableId,
      },
      locator: {
        owner,
        repository,
        issueNumber,
        apiUrl: `https://${connectorInstanceId}.github.test/repos/${owner}/${repository}/issues/${issueNumber}`,
        webUrl: `https://${connectorInstanceId}.github.test/${owner}/${repository}/issues/${issueNumber}`,
      },
      observationSource,
      observedAt: now,
    },
  };
}
