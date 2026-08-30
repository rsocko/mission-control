import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  GitHubHierarchyPersistence,
  GitHubHierarchyReconcileContext,
  GitHubHierarchyTaskUpdate,
} from '@/db/persistence/github-hierarchy';

export interface GitHubHierarchyHarness {
  repositories: GitHubHierarchyPersistence;
  /** True for PostgreSQL — enables the fail-closed succession-state assertions. */
  failsClosedOnSuccession: boolean;
  reset(): Promise<void>;
  seedControl(connectorInstanceId: string, modeRevision: number): Promise<void>;
  seedTask(row: {
    id: string;
    sourceId: string;
    connectorInstanceId: string;
    connectorType?: string;
    isChecklistItem?: boolean;
    parentId?: string | null;
    depth?: number;
    metadata?: Record<string, unknown> | null;
  }): Promise<void>;
  seedExceptionEvent(row: {
    connectorInstanceId: string;
    localId: string;
    action: 'accept' | 'revoke';
    category?: string;
    bindingType?: string;
  }): Promise<void>;
  /** Seeds one historical task-transfer succession row for the connector. */
  seedSuccessionState(connectorInstanceId: string): Promise<void>;
  getTaskState(id: string): Promise<{
    parentId: string | null;
    depth: number;
    metadata: Record<string, unknown>;
  } | null>;
  close(): Promise<void> | void;
}

const CONNECTOR = 'gh-hierarchy-contract';

/** Applies the whole re-read population as parent/depth/metadata updates. */
function updatesFrom(
  context: GitHubHierarchyReconcileContext,
  desired: ReadonlyMap<string, { parentId: string | null; depth: number; githubParent?: Record<string, unknown> }>,
): readonly GitHubHierarchyTaskUpdate[] {
  const updates: GitHubHierarchyTaskUpdate[] = [];
  for (const task of context.tasks) {
    const target = desired.get(task.id);
    if (!target) continue;
    const update: GitHubHierarchyTaskUpdate = {
      taskId: task.id,
      parentId: target.parentId,
      depth: target.depth,
    };
    if (target.githubParent !== undefined) {
      const existing = (task.metadata && typeof task.metadata === 'object'
        ? task.metadata as Record<string, unknown>
        : {});
      update.metadata = { ...existing, githubParent: target.githubParent };
    }
    updates.push(update);
  }
  return updates;
}

export function describeGitHubHierarchyRepositoriesContract(
  backend: string,
  createHarness: () => Promise<GitHubHierarchyHarness>,
): void {
  describe(`GitHubHierarchyPersistence (${backend})`, () => {
    let harness: GitHubHierarchyHarness;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('reads the identity mode snapshot for the fence', async () => {
      await harness.seedControl(CONNECTOR, 7);
      const snapshot = await harness.repositories.getIdentityModeSnapshot(CONNECTOR);
      expect(snapshot).toEqual({ connectorInstanceId: CONNECTOR, modeRevision: 7 });
    });

    it('defaults the mode revision to zero when no control row exists', async () => {
      const snapshot = await harness.repositories.getIdentityModeSnapshot(CONNECTOR);
      expect(snapshot.modeRevision).toBe(0);
    });

    it('lists connector task identities scoped to the connector', async () => {
      await harness.seedTask({ id: 'a', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'b', sourceId: 'acme/app:2', connectorInstanceId: 'other' });
      const rows = await harness.repositories.listConnectorTaskIdentities(CONNECTOR);
      expect(rows.map((row) => row.id)).toEqual(['a']);
    });

    it('returns terminal-inaccessible exception events latest-first per local id', async () => {
      await harness.seedExceptionEvent({ connectorInstanceId: CONNECTOR, localId: 'child', action: 'accept' });
      await harness.seedExceptionEvent({ connectorInstanceId: CONNECTOR, localId: 'child', action: 'revoke' });
      const events = await harness.repositories.listTerminalInaccessibleExceptions(CONNECTOR);
      expect(events).toHaveLength(2);
      // Latest event (highest id) is first, so callers derive the current action.
      expect(events[0].action).toBe('revoke');
      expect(events[1].action).toBe('accept');
    });

    it('applies parent/depth/metadata updates from a non-fenced verdict', async () => {
      await harness.seedControl(CONNECTOR, 1);
      await harness.seedTask({ id: 'parent', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'child', sourceId: 'acme/app:2', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'external', sourceId: 'acme/app:3', connectorInstanceId: CONNECTOR });

      const result = await harness.repositories.applyReconciliation({
        connectorInstanceId: CONNECTOR,
        observedEndpointTaskIds: ['parent', 'child', 'external'],
        reconcile: (context) => ({
          fenced: false,
          updates: updatesFrom(context, new Map([
            ['child', { parentId: 'parent', depth: 1 }],
            ['external', { parentId: null, depth: 0, githubParent: { sourceId: 'private/repo:9', repository: 'private/repo' } }],
          ])),
        }),
      });

      expect(result).toEqual({ applied: true, updated: 2, fenced: false });
      expect(await harness.getTaskState('child')).toMatchObject({ parentId: 'parent', depth: 1 });
      const external = await harness.getTaskState('external');
      expect(external?.parentId).toBeNull();
      expect(external?.metadata).toMatchObject({
        githubParent: { sourceId: 'private/repo:9', repository: 'private/repo' },
      });
    });

    it('applies nothing when the reconcile callback reports the fence tripped', async () => {
      await harness.seedControl(CONNECTOR, 1);
      await harness.seedTask({ id: 'parent', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'child', sourceId: 'acme/app:2', connectorInstanceId: CONNECTOR, parentId: null, depth: 0 });

      const result = await harness.repositories.applyReconciliation({
        connectorInstanceId: CONNECTOR,
        observedEndpointTaskIds: ['parent', 'child'],
        reconcile: () => ({ fenced: true }),
      });

      expect(result).toEqual({ applied: false, updated: 0, fenced: true });
      expect(await harness.getTaskState('child')).toMatchObject({ parentId: null, depth: 0 });
    });

    it('re-reads the population and exception events inside the transaction', async () => {
      await harness.seedControl(CONNECTOR, 3);
      await harness.seedTask({ id: 'parent', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'child', sourceId: 'acme/app:2', connectorInstanceId: CONNECTOR });
      await harness.seedExceptionEvent({ connectorInstanceId: CONNECTOR, localId: 'child', action: 'accept' });

      let seen: GitHubHierarchyReconcileContext | undefined;
      await harness.repositories.applyReconciliation({
        connectorInstanceId: CONNECTOR,
        observedEndpointTaskIds: ['parent', 'child'],
        reconcile: (context) => {
          seen = context;
          return { fenced: true };
        },
      });

      expect(seen?.identitySnapshot.modeRevision).toBe(3);
      expect([...seen!.tasks].map((task) => task.id).sort()).toEqual(['child', 'parent']);
      expect(seen?.exceptionEvents.map((event) => event.action)).toEqual(['accept']);
    });

    it('replays idempotently without changing already-applied rows', async () => {
      await harness.seedControl(CONNECTOR, 1);
      await harness.seedTask({ id: 'parent', sourceId: 'acme/app:1', connectorInstanceId: CONNECTOR });
      await harness.seedTask({ id: 'child', sourceId: 'acme/app:2', connectorInstanceId: CONNECTOR });
      const desired = new Map([['child', { parentId: 'parent', depth: 1 }]]);
      const run = () => harness.repositories.applyReconciliation({
        connectorInstanceId: CONNECTOR,
        observedEndpointTaskIds: ['parent', 'child'],
        reconcile: (context) => ({ fenced: false, updates: updatesFrom(context, desired) }),
      });
      await run();
      await run();
      expect(await harness.getTaskState('child')).toMatchObject({ parentId: 'parent', depth: 1 });
    });

    it('reports no proven-superseded task ids when there is no succession state', async () => {
      if (harness.failsClosedOnSuccession) return;
      await expect(
        harness.repositories.provenSupersededTaskIds(CONNECTOR, ['a', 'b']),
      ).resolves.toEqual([]);
    });

    it('fails closed on historical task-transfer succession state (PostgreSQL only)', async () => {
      if (!harness.failsClosedOnSuccession) return;
      await harness.seedControl(CONNECTOR, 1);
      await harness.seedSuccessionState(CONNECTOR);

      await expect(
        harness.repositories.provenSupersededTaskIds(CONNECTOR, ['source', 'successor']),
      ).rejects.toThrow('GitHub historical task-transfer succession state');

      await expect(
        harness.repositories.applyReconciliation({
          connectorInstanceId: CONNECTOR,
          observedEndpointTaskIds: ['source', 'successor'],
          reconcile: () => ({ fenced: false, updates: [] }),
        }),
      ).rejects.toThrow('GitHub historical task-transfer succession state');
    });
  });
}
