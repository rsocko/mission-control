import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  GitHubFenceTaskRow,
  GitHubIdentityRepositories,
  GitHubWriteIdentity,
} from '@/db/persistence/github-identity';

/**
 * Backend-neutral contract for the GitHub durable-identity + write-fence port.
 *
 * The SQLite and PostgreSQL adapter test files each provide a {@link GitHubIdentityHarness}
 * that seeds the shared baseline (a `github-fence` connector at mode revision 4 with one
 * task bound to a github issue, whose repository is bound to a source list) and exposes a
 * few durable-row readbacks. Every assertion drives the port only.
 */

export const GITHUB_IDENTITY_CONTRACT = {
  connectorInstanceId: 'github-fence',
  taskId: 'task-1',
  sourceListId: 'repo-list',
  sourceId: 'owner/repo:7',
  taskVersion: '2026-08-10T12:00:00.000Z',
  pushLeaseToken: 'push-token-1',
  modeRevision: 4,
  repositoryStableId: 'R_repo',
  issueStableId: 'I_issue',
  linkedSourceId: 'link-1',
} as const;

export interface GitHubIdentityHarness {
  repositories: GitHubIdentityRepositories;
  /** Seeds a bare github connector config (no identity controls) for the given id. */
  seedConnector(connectorInstanceId: string, now: string): Promise<void>;
  /** Seeds connector controls (revision 4), the task, its issue/repository identity, and a linked source. */
  seedBaseline(now: string): Promise<void>;
  /** Records an accepted terminal-inaccessible exception for the seeded task. */
  seedTerminalException(now: string): Promise<void>;
  leaseState(
    leaseId: string,
  ): Promise<{ state: string; modeRevision: number; dispatchedAt: string | null } | null>;
  writeCycleState(cycleId: string): Promise<string | null>;
  primaryBinding(input: {
    connectorInstanceId: string;
    bindingType: 'task' | 'source_list';
    localId: string;
  }): Promise<{
    stableId: string;
    state: string;
    verifiedAt: string | null;
  } | null>;
  close(): void | Promise<void>;
}

const NOW = GITHUB_IDENTITY_CONTRACT.taskVersion;
const LATER = '2026-08-10T12:05:00.000Z';
const EXPIRES = '2026-08-10T12:30:00.000Z';

function deriveUpdateIdentity(task: GitHubFenceTaskRow): GitHubWriteIdentity {
  return {
    idempotencyKey: `idem:${task.id}:update`,
    intent: { kind: 'update', digest: 'digest-1' },
    initialCreate: false,
  };
}

export function describeGitHubIdentityRepositoriesContract(
  label: string,
  createHarness: () => Promise<GitHubIdentityHarness>,
): void {
  describe(`GitHub identity repositories (${label})`, () => {
    let harness: GitHubIdentityHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    describe('durable identity epoch', () => {
      it('ensures controls at revision 1 and reads the snapshot back', async () => {
        const connectorInstanceId = `fresh-${randomUUID()}`;
        await harness.seedConnector(connectorInstanceId, NOW);
        const { identity } = harness.repositories;
        const before = await identity.getModeSnapshot(connectorInstanceId, NOW);
        expect(before.modeRevision).toBe(0);

        await identity.ensureControls({ connectorInstanceId, now: NOW });
        const after = await identity.getModeSnapshot(connectorInstanceId, NOW);
        expect(after).toMatchObject({ connectorInstanceId, modeRevision: 1, capturedAt: NOW });

        // ensureControls is idempotent — a second call keeps the existing revision.
        await identity.ensureControls({ connectorInstanceId, now: LATER });
        expect((await identity.getModeSnapshot(connectorInstanceId, NOW)).modeRevision).toBe(1);
      });

      it('reflects the seeded connector revision', async () => {
        await harness.seedBaseline(NOW);
        const snapshot = await harness.repositories.identity.getModeSnapshot(
          GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          NOW,
        );
        expect(snapshot.modeRevision).toBe(GITHUB_IDENTITY_CONTRACT.modeRevision);
      });
    });

    describe('stable NodeID batch lookup', () => {
      it('resolves an active task binding from its NodeID', async () => {
        await harness.seedBaseline(NOW);
        const rows = await harness.repositories.identity.lookupStableIdentityBatch({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          namespace: {
            provider: 'github',
            hostKey: 'github.com',
            entityType: 'issue',
            bindingType: 'task',
          },
          rows: [
            {
              candidateKey: 'candidate-1',
              stableId: GITHUB_IDENTITY_CONTRACT.issueStableId,
              ownerKey: 'owner',
              repositoryKey: 'repo',
              issueNumber: 7,
            },
          ],
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          candidateKey: 'candidate-1',
          localId: GITHUB_IDENTITY_CONTRACT.taskId,
          bindingState: 'active',
          locatorRevision: 1,
        });
      });

      it('returns an empty result for an empty batch', async () => {
        await harness.seedBaseline(NOW);
        const rows = await harness.repositories.identity.lookupStableIdentityBatch({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          namespace: {
            provider: 'github',
            hostKey: 'github.com',
            entityType: 'issue',
            bindingType: 'task',
          },
          rows: [],
        });
        expect(rows).toEqual([]);
      });
    });

    describe('primary identity persistence', () => {
          it('fails closed when the connector identity controls are missing', async () => {
            const connectorInstanceId = `fresh-primary-${randomUUID()}`;
            const localId = `${connectorInstanceId}:list`;
            await harness.seedConnector(connectorInstanceId, NOW);
            const { identity } = harness.repositories;
            const modeSnapshot = await identity.getModeSnapshot(connectorInstanceId, NOW);
            expect(modeSnapshot.modeRevision).toBe(0);

            await expect(identity.persistExternalIdentityBatch({
              connectorInstanceId,
              modeSnapshot,
              writes: [{
                target: {
                  connectorInstanceId,
                  bindingType: 'source_list',
                  localId,
                  legacyIdentity: 'synthetic-owner/synthetic-repo',
                },
                evidence: {
                  entity: {
                    identity: {
                      provider: 'github',
                      hostKey: 'github.com',
                      entityType: 'repository',
                      stableId: `R_${connectorInstanceId}`,
                    },
                    locator: {
                      owner: 'synthetic-owner',
                      repository: 'synthetic-repo',
                    },
                    observationSource: 'graphql',
                    observedAt: NOW,
                  },
                },
              }],
            })).rejects.toThrow(/identity controls are missing/i);
            await expect(harness.primaryBinding({
              connectorInstanceId,
              bindingType: 'source_list',
              localId,
            })).resolves.toBeNull();
          });

          it('atomically binds normal-execution repository and issue evidence', async () => {
            const connectorInstanceId = `fresh-primary-${randomUUID()}`;
            const sourceListId = `${connectorInstanceId}:list`;
            const taskId = `${connectorInstanceId}:task`;
            await harness.seedConnector(connectorInstanceId, NOW);
            const { identity } = harness.repositories;
            await identity.ensureControls({ connectorInstanceId, now: NOW });
            const modeSnapshot = await identity.getModeSnapshot(connectorInstanceId, NOW);
            const repositoryName = `repo-${connectorInstanceId}`;
            const repository = {
              identity: {
                provider: 'github',
                hostKey: 'github.com',
                entityType: 'repository' as const,
                stableId: `R_${connectorInstanceId}`,
              },
              locator: { owner: 'synthetic-owner', repository: repositoryName },
              observationSource: 'graphql' as const,
              observedAt: NOW,
            };
            const issue = {
              identity: {
                provider: 'github',
                hostKey: 'github.com',
                entityType: 'issue' as const,
                stableId: `I_${connectorInstanceId}`,
              },
              locator: {
                owner: 'synthetic-owner',
                repository: repositoryName,
                issueNumber: 42,
              },
              observationSource: 'graphql' as const,
              observedAt: NOW,
            };
            const writes = [
              {
                target: {
                  connectorInstanceId,
                  bindingType: 'source_list' as const,
                  localId: sourceListId,
                  legacyIdentity: `synthetic-owner/${repositoryName}`,
                },
                evidence: { entity: repository },
              },
              {
                target: {
                  connectorInstanceId,
                  bindingType: 'task' as const,
                  localId: taskId,
                  legacyIdentity: `synthetic-owner/${repositoryName}:42`,
                },
                evidence: { entity: issue, repository },
              },
            ];

            const result = await identity.persistExternalIdentityBatch({
              connectorInstanceId,
              modeSnapshot,
              writes,
            });
            expect(result.map(({ state }) => state)).toEqual(['bound', 'bound']);
            await expect(harness.primaryBinding({
              connectorInstanceId,
              bindingType: 'source_list',
              localId: sourceListId,
            })).resolves.toMatchObject({
              stableId: repository.identity.stableId,
              state: 'active',
              verifiedAt: NOW,
            });
            await expect(harness.primaryBinding({
              connectorInstanceId,
              bindingType: 'task',
              localId: taskId,
            })).resolves.toMatchObject({
              stableId: issue.identity.stableId,
              state: 'active',
              verifiedAt: NOW,
            });

            await expect(identity.persistExternalIdentityBatch({
              connectorInstanceId,
              modeSnapshot: { ...modeSnapshot, modeRevision: modeSnapshot.modeRevision - 1 },
              writes: [{
                ...writes[1],
                target: { ...writes[1].target, localId: `${taskId}:stale` },
              }],
            })).rejects.toThrow(/identity revision changed/i);
            await expect(harness.primaryBinding({
              connectorInstanceId,
              bindingType: 'task',
              localId: `${taskId}:stale`,
            })).resolves.toBeNull();
          });

          it('records a collision instead of stealing an existing stable binding', async () => {
            const connectorInstanceId = `fresh-primary-${randomUUID()}`;
            await harness.seedConnector(connectorInstanceId, NOW);
            const { identity } = harness.repositories;
            await identity.ensureControls({ connectorInstanceId, now: NOW });
            const modeSnapshot = await identity.getModeSnapshot(connectorInstanceId, NOW);
            const repositoryName = `repo-${connectorInstanceId}`;
            const evidence = {
              entity: {
                identity: {
                  provider: 'github',
                  hostKey: 'github.com',
                  entityType: 'repository' as const,
                  stableId: `R_${connectorInstanceId}`,
                },
                locator: { owner: 'synthetic-owner', repository: repositoryName },
                observationSource: 'graphql' as const,
                observedAt: NOW,
              },
            };
            const firstLocalId = `${connectorInstanceId}:first`;
            const secondLocalId = `${connectorInstanceId}:second`;
            const target = {
              connectorInstanceId,
              bindingType: 'source_list' as const,
              localId: firstLocalId,
              legacyIdentity: `synthetic-owner/${repositoryName}`,
            };
            await identity.persistExternalIdentityBatch({
              connectorInstanceId,
              modeSnapshot,
              writes: [{ target, evidence }],
            });
            const [collision] = await identity.persistExternalIdentityBatch({
              connectorInstanceId,
              modeSnapshot,
              writes: [{
                target: { ...target, localId: secondLocalId },
                evidence,
              }],
            });
            expect(collision).toMatchObject({
              state: 'collision',
              collisionCategory: 'multiple_local_one_stable',
            });
            await expect(harness.primaryBinding({
              connectorInstanceId,
              bindingType: 'source_list',
              localId: firstLocalId,
            })).resolves.toMatchObject({ state: 'collision' });
            await expect(harness.primaryBinding({
              connectorInstanceId,
              bindingType: 'source_list',
              localId: secondLocalId,
            })).resolves.toBeNull();
          });
        });

    describe('linked-source identity', () => {
      it('associates a linked source with a matching NodeID and re-reads it', async () => {
        await harness.seedBaseline(NOW);
        const { identity } = harness.repositories;
        const results = await identity.persistLinkedSourceIdentityBatch({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          writes: [
            {
              linkedSourceId: GITHUB_IDENTITY_CONTRACT.linkedSourceId,
              hasEvidence: true,
              identityValid: true,
              provider: 'github',
              hostKey: 'github.com',
              entityType: 'issue',
              stableId: GITHUB_IDENTITY_CONTRACT.issueStableId,
              ownerKey: 'owner',
              repositoryKey: 'repo',
              issueNumber: 7,
              canonicalSourceId: GITHUB_IDENTITY_CONTRACT.sourceId,
              observedAt: NOW,
            },
          ],
        });
        expect(results).toEqual([
          { linkedSourceId: GITHUB_IDENTITY_CONTRACT.linkedSourceId, state: 'associated' },
        ]);

        const lookup = await identity.lookupLinkedSourceIdentityBatch({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          hostKey: 'github.com',
          rows: [
            {
              candidateKey: 'linked-candidate-1',
              linkedSourceId: GITHUB_IDENTITY_CONTRACT.linkedSourceId,
              stableId: GITHUB_IDENTITY_CONTRACT.issueStableId,
              ownerKey: 'owner',
              repositoryKey: 'repo',
              issueNumber: 7,
            },
          ],
        });
        expect(lookup).toHaveLength(1);
        expect(lookup[0]).toMatchObject({
          candidateKey: 'linked-candidate-1',
          linkedTaskId: GITHUB_IDENTITY_CONTRACT.taskId,
        });
      });

      it('reports an unbound state when there is no NodeID evidence', async () => {
        await harness.seedBaseline(NOW);
        const results = await harness.repositories.identity.persistLinkedSourceIdentityBatch({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          writes: [
            {
              linkedSourceId: GITHUB_IDENTITY_CONTRACT.linkedSourceId,
              hasEvidence: false,
              identityValid: false,
              provider: 'github',
              hostKey: 'github.com',
              entityType: 'issue',
              stableId: GITHUB_IDENTITY_CONTRACT.issueStableId,
              ownerKey: 'owner',
              repositoryKey: 'repo',
              issueNumber: 7,
              canonicalSourceId: GITHUB_IDENTITY_CONTRACT.sourceId,
              observedAt: NOW,
            },
          ],
        });
        expect(results).toEqual([
          { linkedSourceId: GITHUB_IDENTITY_CONTRACT.linkedSourceId, state: 'unbound' },
        ]);
      });
    });

    describe('decision currency', () => {
      it('confirms a current binding and rejects a stale locator revision', async () => {
        await harness.seedBaseline(NOW);
        const { identity } = harness.repositories;
        const currentCheck = {
          bindingType: 'task' as const,
          localId: GITHUB_IDENTITY_CONTRACT.taskId,
          externalEntityId: 'issue-entity',
          bindingRevision: NOW,
          locatorRevision: 1,
        };
        expect(
          await identity.checkDecisionsCurrent({
            connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
            checks: [currentCheck],
          }),
        ).toBe(true);
        expect(
          await identity.checkDecisionsCurrent({
            connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
            checks: [{ ...currentCheck, locatorRevision: 999 }],
          }),
        ).toBe(false);
      });
    });

    describe('terminal-inaccessible exception reads', () => {
      it('returns null when there is no exception and a snapshot once one is seeded', async () => {
        await harness.seedBaseline(NOW);
        const { identity } = harness.repositories;
        expect(
          await identity.getLatestTerminalInaccessibleException({
            connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
            bindingType: 'task',
            localId: GITHUB_IDENTITY_CONTRACT.taskId,
          }),
        ).toBeNull();

        await harness.seedTerminalException(NOW);
        const snapshot = await identity.getLatestTerminalInaccessibleException({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          bindingType: 'task',
          localId: GITHUB_IDENTITY_CONTRACT.taskId,
        });
        expect(snapshot).toMatchObject({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          bindingType: 'task',
          localId: GITHUB_IDENTITY_CONTRACT.taskId,
          category: 'terminal_inaccessible',
          action: 'accept',
        });
      });
    });

    describe('write fence lifecycle', () => {
      it('runs begin → authorize → observe → preflight → dispatch → finalize → finish', async () => {
        await harness.seedBaseline(NOW);
        const { writeFence } = harness.repositories;
        const cycleId = randomUUID();
        expect(
          await writeFence.beginWriteCycle({
            id: cycleId,
            connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
            expectedModeRevision: GITHUB_IDENTITY_CONTRACT.modeRevision,
            pendingCandidateCount: 1,
            now: NOW,
          }),
        ).toEqual({ ok: true });

        const leaseId = randomUUID();
        const token = randomUUID();
        const authorization = await writeFence.authorizeTaskWrite({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          taskId: GITHUB_IDENTITY_CONTRACT.taskId,
          operation: 'update',
          writeCycleId: cycleId,
          leaseId,
          token,
          expiresAt: EXPIRES,
          now: NOW,
          deriveWriteIdentity: deriveUpdateIdentity,
        });
        expect(authorization.ok).toBe(true);
        if (!authorization.ok) throw new Error('authorization failed');
        expect(authorization.leaseId).toBe(leaseId);
        expect(authorization.modeRevision).toBe(GITHUB_IDENTITY_CONTRACT.modeRevision);
        expect(authorization.targets.map((target) => target.role).sort()).toEqual([
          'primary_issue',
          'source_repository',
        ]);

        const authorizationRef = {
          leaseId,
          token,
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          taskId: GITHUB_IDENTITY_CONTRACT.taskId,
        };
        expect(await writeFence.recordCycleObservation({ leaseId, now: NOW })).toEqual({ ok: true });
        expect(
          await writeFence.verifyPreflight({
            leaseId,
            observed: {
              targets: {
                primary_issue: {
                  repositoryStableId: GITHUB_IDENTITY_CONTRACT.repositoryStableId,
                  issueStableId: GITHUB_IDENTITY_CONTRACT.issueStableId,
                },
                source_repository: {
                  repositoryStableId: GITHUB_IDENTITY_CONTRACT.repositoryStableId,
                },
              },
            },
          }),
        ).toBe(true);
        expect(
          await writeFence.confirmDispatch({ authorization: authorizationRef, now: LATER }),
        ).toBe(true);
        expect(
          await writeFence.finalizeWrite({
            authorization: authorizationRef,
            outcome: 'succeeded',
            safeReason: null,
            resultDigest: 'result-1',
            now: LATER,
          }),
        ).toEqual({ status: 'committed' });
        expect(await harness.leaseState(leaseId)).toMatchObject({ state: 'succeeded' });

        expect(
          await writeFence.finishWriteCycle({
            id: cycleId,
            outcome: { observed: 1, applied: 1, blocked: 0, failed: 0, unknown: 0 },
            now: LATER,
          }),
        ).toEqual({ committed: true });
        expect(await harness.writeCycleState(cycleId)).toBe('completed');

        // A prior success blocks re-authorizing the same durable intent.
        const replay = await writeFence.authorizeTaskWrite({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          taskId: GITHUB_IDENTITY_CONTRACT.taskId,
          operation: 'update',
          writeCycleId: cycleId,
          leaseId: randomUUID(),
          token: randomUUID(),
          expiresAt: EXPIRES,
          now: LATER,
          deriveWriteIdentity: deriveUpdateIdentity,
        });
        expect(replay).toMatchObject({ ok: false });

        expect(
          await writeFence.hasSucceededWrite({
            connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
            taskId: GITHUB_IDENTITY_CONTRACT.taskId,
            operation: 'update',
            expectedTaskVersion: GITHUB_IDENTITY_CONTRACT.taskVersion,
            taskPushLeaseToken: GITHUB_IDENTITY_CONTRACT.pushLeaseToken,
            now: LATER,
            deriveWriteIdentity: deriveUpdateIdentity,
          }),
        ).toBe(true);
      });

      it('rejects a write cycle opened against a stale mode revision', async () => {
        await harness.seedBaseline(NOW);
        const result = await harness.repositories.writeFence.beginWriteCycle({
          id: randomUUID(),
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          expectedModeRevision: 999,
          pendingCandidateCount: 1,
          now: NOW,
        });
        expect(result).toEqual({ ok: false, code: 'stale_write_cycle_mode' });
      });

      it('rejects authorization against a missing write cycle', async () => {
        await harness.seedBaseline(NOW);
        const result = await harness.repositories.writeFence.authorizeTaskWrite({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          taskId: GITHUB_IDENTITY_CONTRACT.taskId,
          operation: 'update',
          writeCycleId: 'does-not-exist',
          leaseId: randomUUID(),
          token: randomUUID(),
          expiresAt: EXPIRES,
          now: NOW,
          deriveWriteIdentity: deriveUpdateIdentity,
        });
        expect(result).toEqual({ ok: false, code: 'stale_write_cycle' });
      });

      it('rejects authorization for a task that does not exist', async () => {
        await harness.seedBaseline(NOW);
        const { writeFence } = harness.repositories;
        const cycleId = randomUUID();
        await writeFence.beginWriteCycle({
          id: cycleId,
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          expectedModeRevision: GITHUB_IDENTITY_CONTRACT.modeRevision,
          pendingCandidateCount: 1,
          now: NOW,
        });
        const result = await writeFence.authorizeTaskWrite({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          taskId: 'ghost-task',
          operation: 'update',
          writeCycleId: cycleId,
          leaseId: randomUUID(),
          token: randomUUID(),
          expiresAt: EXPIRES,
          now: NOW,
          deriveWriteIdentity: deriveUpdateIdentity,
        });
        expect(result).toEqual({ ok: false, code: 'missing_task' });
      });

      it('authorizes a source-list write against its bound repository', async () => {
        await harness.seedBaseline(NOW);
        const { writeFence } = harness.repositories;
        const cycleId = randomUUID();
        await writeFence.beginWriteCycle({
          id: cycleId,
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          expectedModeRevision: GITHUB_IDENTITY_CONTRACT.modeRevision,
          pendingCandidateCount: 1,
          now: NOW,
        });
        const leaseId = randomUUID();
        const result = await writeFence.authorizeSourceWrite({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          sourceListId: GITHUB_IDENTITY_CONTRACT.sourceListId,
          operation: 'label',
          writeCycleId: cycleId,
          leaseId,
          token: randomUUID(),
          expiresAt: EXPIRES,
          now: NOW,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('source authorization failed');
        expect(result.sourceList).toEqual({
          id: GITHUB_IDENTITY_CONTRACT.sourceListId,
          sourceId: 'owner/repo',
        });
        expect(result.target.role).toBe('source_repository');
        expect(result.leaseId).toBe(leaseId);
      });

      it('expires undispatched leases and returns the affected count', async () => {
        await harness.seedBaseline(NOW);
        const { writeFence } = harness.repositories;
        const cycleId = randomUUID();
        await writeFence.beginWriteCycle({
          id: cycleId,
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          expectedModeRevision: GITHUB_IDENTITY_CONTRACT.modeRevision,
          pendingCandidateCount: 1,
          now: NOW,
        });
        const leaseId = randomUUID();
        await writeFence.authorizeTaskWrite({
          connectorInstanceId: GITHUB_IDENTITY_CONTRACT.connectorInstanceId,
          taskId: GITHUB_IDENTITY_CONTRACT.taskId,
          operation: 'update',
          writeCycleId: cycleId,
          leaseId,
          token: randomUUID(),
          expiresAt: LATER,
          now: NOW,
          deriveWriteIdentity: deriveUpdateIdentity,
        });
        // No leases are expired while still inside their window.
        expect(await writeFence.expireUndispatchedLeases(NOW)).toBe(0);
        // Past the expiry the claimed, undispatched lease is expired.
        const expired = await writeFence.expireUndispatchedLeases('2026-08-10T13:00:00.000Z');
        expect(expired).toBe(1);
        expect(await harness.leaseState(leaseId)).toMatchObject({ state: 'expired' });
      });
    });
  });
}
