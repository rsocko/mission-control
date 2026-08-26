import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type IdeationWorkspaceRepository,
} from '@/lib/graph-workspace/repository';

interface RepositoryHarness {
  repository: IdeationWorkspaceRepository;
  close(): void;
}

const document = createIdeationWorkspaceDocument([{
  id: 'root',
  label: 'Portable document',
  kind: 'idea',
  parentId: null,
  sortOrder: 0,
  properties: {
    tags: {
      key: 'tags',
      rawValue: 'portable, json',
      value: ['portable', 'json'],
    },
  },
}]);

export function describeIdeationWorkspaceRepositoryContract(
  name: string,
  createHarness: () => RepositoryHarness,
): void {
  describe(`${name} IdeationWorkspaceRepository contract`, () => {
    let harness: RepositoryHarness;

    beforeEach(() => {
      harness = createHarness();
    });

    afterEach(() => {
      harness.close();
    });

    it('round trips portable IDs, timestamps, and parsed JSON', async () => {
      const created = await harness.repository.create({
        id: 'workspace-portable',
        name: 'Portable',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });

      expect(await harness.repository.get(created.id)).toEqual({
        ...created,
        document,
        createdAt: '2026-08-25T20:00:00.000Z',
        updatedAt: '2026-08-25T20:00:00.000Z',
      });
    });

    it('returns explicit missing results and bounded version pages', async () => {
      expect(await harness.repository.get('missing')).toBeNull();
      await harness.repository.create({
        id: 'workspace-versions',
        name: 'Versions',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });
      await harness.repository.updateContent(
        'workspace-versions',
        1,
        {
          ...document,
          nodes: [{ ...document.nodes[0], label: 'Updated' }],
        },
        '2026-08-25T20:06:00.000Z',
      );

      const versions = await harness.repository.listVersions('workspace-versions', 1);
      expect(versions).toHaveLength(1);
      expect(versions[0]?.revision).toBe(2);
    });

    it('reports optimistic conflicts without overwriting the current document', async () => {
      await harness.repository.create({
        id: 'workspace-conflict',
        name: 'Conflict',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });
      const current = await harness.repository.updateContent(
        'workspace-conflict',
        1,
        {
          ...document,
          nodes: [{ ...document.nodes[0], label: 'Current' }],
        },
        '2026-08-25T20:01:00.000Z',
      );

      await expect(harness.repository.updateContent(
        'workspace-conflict',
        1,
        document,
        '2026-08-25T20:02:00.000Z',
      )).rejects.toBeInstanceOf(IdeationWorkspaceConflictError);
      expect(await harness.repository.get('workspace-conflict')).toEqual(current);
    });

    it('rolls back a failed atomic create', async () => {
      await harness.repository.create({
        id: 'workspace-first',
        name: 'First',
        document,
        migrationSource: 'browser-source',
        reason: 'migrated',
        now: '2026-08-25T20:00:00.000Z',
      });

      await expect(harness.repository.create({
        id: 'workspace-rolled-back',
        name: 'Second',
        document,
        migrationSource: 'browser-source',
        reason: 'migrated',
        now: '2026-08-25T20:01:00.000Z',
      })).rejects.toThrow();
      expect(await harness.repository.get('workspace-rolled-back')).toBeNull();
    });
  });
}
