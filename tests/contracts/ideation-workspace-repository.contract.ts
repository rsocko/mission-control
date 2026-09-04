import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type IdeationWorkspaceRepository,
} from '@/lib/graph-workspace/repository';

interface RepositoryHarness {
  repository: IdeationWorkspaceRepository;
  close(): void | Promise<void>;
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
  createHarness: () => RepositoryHarness | Promise<RepositoryHarness>,
): void {
  describe(`${name} IdeationWorkspaceRepository contract`, () => {
    let harness: RepositoryHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
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

    it('orders the library by archived flag, recency, folded name, then id', async () => {
      // `apple` before `Banana` only holds under ASCII-only case folding; a
      // raw byte comparison would put every capitalised name first.
      const seed = [
        { id: 'workspace-c', name: 'Cherry', now: '2026-08-25T20:00:00.000Z' },
        { id: 'workspace-b', name: 'Banana', now: '2026-08-25T20:00:00.000Z' },
        { id: 'workspace-dup', name: 'apple', now: '2026-08-25T20:00:00.000Z' },
        { id: 'workspace-a', name: 'apple', now: '2026-08-25T20:00:00.000Z' },
        { id: 'workspace-recent', name: 'zulu', now: '2026-08-25T20:05:00.000Z' },
        { id: 'workspace-arch', name: 'aardvark', now: '2026-08-25T20:06:00.000Z' },
      ];
      for (const { id, name, now } of seed) {
        await harness.repository.create({ id, name, document, reason: 'created', now });
      }
      await harness.repository.setArchived(
        'workspace-arch',
        true,
        '2026-08-25T20:07:00.000Z',
      );

      // Recency wins over name; the two `apple` rows are separated only by id.
      expect((await harness.repository.list(false)).map((w) => w.id)).toEqual([
        'workspace-recent',
        'workspace-a',
        'workspace-dup',
        'workspace-b',
        'workspace-c',
      ]);
      // The archived row sorts last despite being the newest and first by name.
      expect((await harness.repository.list(true)).map((w) => w.id)).toEqual([
        'workspace-recent',
        'workspace-a',
        'workspace-dup',
        'workspace-b',
        'workspace-c',
        'workspace-arch',
      ]);
    });

    it('renames, archives, and unarchives, reporting missing rows as null', async () => {
      await harness.repository.create({
        id: 'workspace-lifecycle',
        name: 'Original',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });

      const renamed = await harness.repository.rename(
        'workspace-lifecycle',
        'Renamed',
        '2026-08-25T20:01:00.000Z',
      );
      expect(renamed).toMatchObject({
        name: 'Renamed',
        updatedAt: '2026-08-25T20:01:00.000Z',
        // A rename is metadata only and must not advance the content revision.
        contentRevision: 1,
      });

      const archived = await harness.repository.setArchived(
        'workspace-lifecycle',
        true,
        '2026-08-25T20:02:00.000Z',
      );
      expect(archived?.archivedAt).toBe('2026-08-25T20:02:00.000Z');
      const restored = await harness.repository.setArchived(
        'workspace-lifecycle',
        false,
        '2026-08-25T20:03:00.000Z',
      );
      expect(restored?.archivedAt).toBeNull();

      expect(await harness.repository.rename('missing', 'x', '2026-08-25T20:04:00.000Z'))
        .toBeNull();
      expect(await harness.repository.setArchived('missing', true, '2026-08-25T20:04:00.000Z'))
        .toBeNull();
    });

    it('deletes only archived workspaces and reports the exact tri-state', async () => {
      await harness.repository.create({
        id: 'workspace-delete',
        name: 'Delete',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });

      expect(await harness.repository.deleteArchived('missing')).toBe('not-found');
      expect(await harness.repository.deleteArchived('workspace-delete'))
        .toBe('not-archived');
      expect(await harness.repository.get('workspace-delete')).not.toBeNull();

      await harness.repository.setArchived(
        'workspace-delete',
        true,
        '2026-08-25T20:01:00.000Z',
      );
      expect(await harness.repository.deleteArchived('workspace-delete')).toBe('deleted');
      expect(await harness.repository.get('workspace-delete')).toBeNull();
      // The version rows cascade with the workspace.
      expect(await harness.repository.listVersions('workspace-delete', 10)).toEqual([]);
    });

    it('duplicates a workspace as a fresh revision-1 document', async () => {
      await harness.repository.create({
        id: 'workspace-source',
        name: 'Source',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });
      await harness.repository.updateContent(
        'workspace-source',
        1,
        { ...document, nodes: [{ ...document.nodes[0], label: 'Advanced' }] },
        '2026-08-25T20:30:00.000Z',
      );

      const copy = await harness.repository.duplicate(
        'workspace-source',
        'workspace-copy',
        'Copy',
        '2026-08-25T20:31:00.000Z',
      );
      expect(copy).toMatchObject({
        id: 'workspace-copy',
        name: 'Copy',
        contentRevision: 1,
        archivedAt: null,
        createdAt: '2026-08-25T20:31:00.000Z',
      });
      expect(copy?.document.nodes[0]?.label).toBe('Advanced');
      const copyVersions = await harness.repository.listVersions('workspace-copy', 10);
      expect(copyVersions.map((version) => [version.revision, version.reason]))
        .toEqual([[1, 'created']]);

      expect(await harness.repository.duplicate(
        'missing',
        'workspace-never',
        'Never',
        '2026-08-25T20:32:00.000Z',
      )).toBeNull();
      expect(await harness.repository.get('workspace-never')).toBeNull();
    });

    it('resolves a workspace by its unique migration source', async () => {
      expect(await harness.repository.findByMigrationSource('browser-key')).toBeNull();
      const created = await harness.repository.create({
        id: 'workspace-migrated',
        name: 'Migrated',
        document,
        migrationSource: 'browser-key',
        reason: 'migrated',
        now: '2026-08-25T20:00:00.000Z',
      });
      expect(await harness.repository.findByMigrationSource('browser-key')).toEqual(created);
      // A null migration source must never collide with another null one.
      await harness.repository.create({
        id: 'workspace-null-source-a',
        name: 'A',
        document,
        reason: 'created',
        now: '2026-08-25T20:01:00.000Z',
      });
      await harness.repository.create({
        id: 'workspace-null-source-b',
        name: 'B',
        document,
        reason: 'created',
        now: '2026-08-25T20:02:00.000Z',
      });
      expect(await harness.repository.get('workspace-null-source-b')).not.toBeNull();
    });

    it('checkpoints a content save at most once per interval', async () => {
      await harness.repository.create({
        id: 'workspace-checkpoint',
        name: 'Checkpoint',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });
      const save = (revision: number, now: string) => harness.repository.updateContent(
        'workspace-checkpoint',
        revision,
        { ...document, nodes: [{ ...document.nodes[0], label: `r${revision}` }] },
        now,
      );

      // Inside the 5-minute window: revision advances, no new version row.
      await save(1, '2026-08-25T20:01:00.000Z');
      await save(2, '2026-08-25T20:02:00.000Z');
      expect((await harness.repository.listVersions('workspace-checkpoint', 10))
        .map((version) => version.revision)).toEqual([1]);

      // Exactly at the boundary the next save must checkpoint.
      await save(3, '2026-08-25T20:05:00.000Z');
      expect((await harness.repository.listVersions('workspace-checkpoint', 10))
        .map((version) => [version.revision, version.reason]))
        .toEqual([[4, 'checkpoint'], [1, 'created']]);
      expect((await harness.repository.get('workspace-checkpoint'))?.contentRevision).toBe(4);
    });

    it('restores a historical revision, back-filling the pre-restore checkpoint', async () => {
      await harness.repository.create({
        id: 'workspace-restore',
        name: 'Restore',
        document,
        reason: 'created',
        now: '2026-08-25T20:00:00.000Z',
      });
      // Revision 2 is uncheckpointed (inside the interval), so restoring must
      // preserve it before overwriting the current document.
      await harness.repository.updateContent(
        'workspace-restore',
        1,
        { ...document, nodes: [{ ...document.nodes[0], label: 'Second' }] },
        '2026-08-25T20:01:00.000Z',
      );

      const restored = await harness.repository.restore(
        'workspace-restore',
        1,
        2,
        '2026-08-25T20:02:00.000Z',
      );
      expect(restored?.contentRevision).toBe(3);
      expect(restored?.document.nodes[0]?.label).toBe(document.nodes[0]?.label);
      expect((await harness.repository.listVersions('workspace-restore', 10))
        .map((version) => [version.revision, version.reason]))
        .toEqual([[3, 'restored'], [2, 'checkpoint'], [1, 'created']]);
      expect((await harness.repository.getVersion('workspace-restore', 2))
        ?.document.nodes[0]?.label).toBe('Second');

      // A stale base revision conflicts, and an unknown revision is null.
      await expect(harness.repository.restore(
        'workspace-restore',
        1,
        2,
        '2026-08-25T20:03:00.000Z',
      )).rejects.toBeInstanceOf(IdeationWorkspaceConflictError);
      expect(await harness.repository.restore(
        'workspace-restore',
        99,
        3,
        '2026-08-25T20:04:00.000Z',
      )).toBeNull();
      expect(await harness.repository.restore(
        'missing',
        1,
        1,
        '2026-08-25T20:05:00.000Z',
      )).toBeNull();
    });

    it('reports missing content updates rather than creating a workspace', async () => {
      expect(await harness.repository.updateContent(
        'missing',
        1,
        document,
        '2026-08-25T20:00:00.000Z',
      )).toBeNull();
      expect(await harness.repository.getVersion('missing', 1)).toBeNull();
      expect(await harness.repository.listVersions('missing', 10)).toEqual([]);
    });
  });
}
