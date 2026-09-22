import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  GitHubProjectDecisionCheck,
  GitHubProjectPersistence,
  GitHubProjectReconciliation,
} from '@/db/persistence/github-projects';

export interface SeededBinding {
  externalEntityId: string;
  bindingRevision: string;
  locatorRevision: number;
}

export interface GitHubProjectHarness {
  repositories: GitHubProjectPersistence;
  reset(): Promise<void>;
  seedControl(connectorInstanceId: string, modeRevision: number): Promise<void>;
  seedTask(row: {
    id: string;
    sourceId: string;
    connectorInstanceId: string;
  }): Promise<void>;
  /**
   * Seeds an active task binding + current locator so a decision-currency check
   * built from the returned revisions passes the adapter's in-transaction fence.
   */
  seedActiveBinding(row: {
    connectorInstanceId: string;
    localId: string;
    bindingType?: 'task' | 'source_list';
  }): Promise<SeededBinding>;
  seedExistingLink(projectId: string, taskId: string): Promise<void>;
  getHubProject(projectId: string): Promise<{
    name: string;
    description: string | null;
    metadata: Record<string, unknown>;
  } | null>;
  listLinkedTaskIds(projectId: string): Promise<string[]>;
  close(): Promise<void> | void;
}

const CONNECTOR = 'gh-project-contract';

function projectId(number: number): string {
  return `gh-project:${CONNECTOR}:${number}`;
}

function reconciliation(
  overrides: Partial<GitHubProjectReconciliation> & { number: number },
): GitHubProjectReconciliation {
  return {
    name: `Project ${overrides.number}`,
    description: `Description ${overrides.number}`,
    url: `https://github.com/orgs/acme/projects/${overrides.number}`,
    authoritative: true,
    taskSourceIds: [],
    useStableRouting: false,
    resolveIdentityDigest: () => `digest-${overrides.number}`,
    ...overrides,
  };
}

export function describeGitHubProjectRepositoriesContract(
  backend: string,
  createHarness: () => Promise<GitHubProjectHarness>,
): void {
  describe(`GitHubProjectPersistence (${backend})`, () => {
    let harness: GitHubProjectHarness;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('upserts the hub project and links source-routed tasks', async () => {
      await harness.seedTask({ id: 'task-1', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'task-2', sourceId: 'acme/app:2', connectorInstanceId: CONNECTOR });

      await harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        projects: [reconciliation({
          number: 7,
          name: 'Roadmap',
          description: 'Team roadmap',
          taskSourceIds: ['acme/app:1', 'acme/app:2'],
        })],
      });

      const project = await harness.getHubProject(projectId(7));
      expect(project?.name).toBe('Roadmap');
      expect(project?.description).toBe('Team roadmap');
      expect(project?.metadata).toMatchObject({
        githubProjectNumber: 7,
        githubProjectIdentityDigest: 'digest-7',
        syncManaged: true,
      });
      expect((await harness.listLinkedTaskIds(projectId(7))).sort()).toEqual(['task-1', 'task-2']);
    });

    it('creates idempotent project links on replay', async () => {
      await harness.seedTask({ id: 'task-1', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      const input = {
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        projects: [reconciliation({ number: 3, taskSourceIds: ['acme/app:1'] })],
      };
      await harness.repositories.reconcileSyncManagedProjects(input);
      await harness.repositories.reconcileSyncManagedProjects(input);
      expect(await harness.listLinkedTaskIds(projectId(3))).toEqual(['task-1']);
    });

    it('routes associations by stable task id when stable routing is enabled', async () => {
      await harness.seedTask({ id: 'stable-task', sourceId: 'acme/app:9', connectorInstanceId: CONNECTOR });

      await harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        projects: [reconciliation({
          number: 4,
          useStableRouting: true,
          stableTaskIds: ['stable-task'],
          // Source ids are ignored under stable routing.
          taskSourceIds: ['acme/app:9'],
        })],
      });

      expect(await harness.listLinkedTaskIds(projectId(4))).toEqual(['stable-task']);
    });

    it('does not delete existing associations for an incomplete (non-authoritative) observation', async () => {
      await harness.seedTask({ id: 'kept-task', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedExistingLink(projectId(5), 'kept-task');

      await harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        projects: [reconciliation({
          number: 5,
          authoritative: false,
          taskSourceIds: [],
        })],
      });

      expect(await harness.listLinkedTaskIds(projectId(5))).toEqual(['kept-task']);
    });

    it('prunes stale associations only for a complete (authoritative) observation', async () => {
      await harness.seedTask({ id: 'stale-task', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedExistingLink(projectId(6), 'stale-task');

      await harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        projects: [reconciliation({ number: 6, authoritative: true, taskSourceIds: [] })],
      });

      expect(await harness.listLinkedTaskIds(projectId(6))).toEqual([]);
    });

    it('never rewrites associations for a project number the caller withheld (blocked)', async () => {
      await harness.seedTask({ id: 'blocked-task', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'open-task', sourceId: 'acme/app:2', connectorInstanceId: CONNECTOR });
      // Project #5 is "blocked": the domain layer omits it from the reconcile set.
      await harness.seedExistingLink(projectId(5), 'blocked-task');

      await harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        projects: [reconciliation({ number: 7, authoritative: true, taskSourceIds: ['acme/app:2'] })],
      });

      expect(await harness.listLinkedTaskIds(projectId(5))).toEqual(['blocked-task']);
      expect(await harness.listLinkedTaskIds(projectId(7))).toEqual(['open-task']);
    });

    it('passes a current identity fence and commits', async () => {
      await harness.seedControl(CONNECTOR, 2);
      await harness.seedTask({ id: 'task-1', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      const binding = await harness.seedActiveBinding({ connectorInstanceId: CONNECTOR, localId: 'task-1' });
      const check: GitHubProjectDecisionCheck = {
        bindingType: 'task',
        localId: 'task-1',
        externalEntityId: binding.externalEntityId,
        bindingRevision: binding.bindingRevision,
        locatorRevision: binding.locatorRevision,
      };

      await harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        identityFence: { modeRevision: 2, checks: [check] },
        projects: [reconciliation({ number: 8, taskSourceIds: ['acme/app:1'] })],
      });

      expect(await harness.listLinkedTaskIds(projectId(8))).toEqual(['task-1']);
    });

    it('fails closed when the identity mode revision changed', async () => {
      await harness.seedControl(CONNECTOR, 5);
      await harness.seedTask({ id: 'task-1', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });

      await expect(harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        identityFence: { modeRevision: 4, checks: [] },
        projects: [reconciliation({ number: 9, taskSourceIds: ['acme/app:1'] })],
      })).rejects.toThrow('GitHub identity revision changed');

      expect(await harness.getHubProject(projectId(9))).toBeNull();
    });

    it('fails closed when a decision binding or locator is stale', async () => {
      await harness.seedControl(CONNECTOR, 2);
      await harness.seedTask({ id: 'task-1', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });

      await expect(harness.repositories.reconcileSyncManagedProjects({
        connectorInstanceId: CONNECTOR,
        now: '2026-08-09T00:00:00.000Z',
        identityFence: {
          modeRevision: 2,
          checks: [{
            bindingType: 'task',
            localId: 'task-1',
            externalEntityId: 'missing-entity',
            bindingRevision: '2026-08-09T00:00:00.000Z',
            locatorRevision: 1,
          }],
        },
        projects: [reconciliation({ number: 10, taskSourceIds: ['acme/app:1'] })],
      })).rejects.toThrow('GitHub stable decision binding or locator is stale');

      expect(await harness.getHubProject(projectId(10))).toBeNull();
    });
  });
}
