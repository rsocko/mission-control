import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createIdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import { IdeationWorkspaceConflictError } from '@/lib/graph-workspace/repository';
import { SqliteIdeationWorkspaceRepository } from '@/lib/graph-workspace/sqlite-repository';

const document = createIdeationWorkspaceDocument([{
  id: 'root',
  label: 'Workspace',
  kind: 'idea',
  parentId: null,
  sortOrder: 0,
  properties: {},
}]);

describe('SqliteIdeationWorkspaceRepository', () => {
  let sqlite: Database.Database;
  let repository: SqliteIdeationWorkspaceRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0102_ideation_workspaces.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    repository = new SqliteIdeationWorkspaceRepository(sqlite);
  });

  it('persists named documents and rejects stale content revisions', () => {
    const created = repository.create({
      id: 'workspace-1',
      name: 'First',
      document,
      now: '2026-08-14T20:00:00.000Z',
      reason: 'created',
    });
    const changedDocument = {
      ...document,
      nodes: [{ ...document.nodes[0], label: 'Changed' }],
    };
    const updated = repository.updateContent(
      created.id,
      created.contentRevision,
      changedDocument,
      '2026-08-14T20:01:00.000Z',
    );

    expect(updated).toMatchObject({
      contentRevision: 2,
      document: changedDocument,
    });
    expect(() => repository.updateContent(
      created.id,
      created.contentRevision,
      document,
      '2026-08-14T20:02:00.000Z',
    )).toThrow(IdeationWorkspaceConflictError);
  });

  it('keeps content revisions independent from metadata changes', () => {
    const created = repository.create({
      id: 'workspace-1',
      name: 'First',
      document,
      now: '2026-08-14T20:00:00.000Z',
      reason: 'created',
    });

    const renamed = repository.rename(
      created.id,
      'Renamed',
      '2026-08-14T20:01:00.000Z',
    );
    const archived = repository.setArchived(
      created.id,
      true,
      '2026-08-14T20:02:00.000Z',
    );

    expect(renamed?.contentRevision).toBe(1);
    expect(archived).toMatchObject({
      name: 'Renamed',
      contentRevision: 1,
      archivedAt: '2026-08-14T20:02:00.000Z',
    });
  });

  it('creates bounded checkpoints and restores one as a new latest revision', () => {
    const created = repository.create({
      id: 'workspace-1',
      name: 'First',
      document,
      now: '2026-08-14T20:00:00.000Z',
      reason: 'created',
    });
    const second = repository.updateContent(
      created.id,
      1,
      { ...document, nodes: [{ ...document.nodes[0], label: 'Second' }] },
      '2026-08-14T20:01:00.000Z',
    )!;
    repository.updateContent(
      created.id,
      second.contentRevision,
      { ...document, nodes: [{ ...document.nodes[0], label: 'Third' }] },
      '2026-08-14T20:06:00.000Z',
    );

    expect(repository.listVersions(created.id, 30).map((version) => version.revision))
      .toEqual([3, 1]);

    const restored = repository.restore(
      created.id,
      1,
      3,
      '2026-08-14T20:07:00.000Z',
    );
    expect(restored).toMatchObject({
      contentRevision: 4,
      document,
    });
    expect(repository.listVersions(created.id, 30)[0]).toMatchObject({
      revision: 4,
      reason: 'restored',
    });
  });

  it('checkpoints the current document before restoring over uncheckpointed edits', () => {
    repository.create({
      id: 'workspace-1',
      name: 'First',
      document,
      now: '2026-08-14T20:00:00.000Z',
      reason: 'created',
    });
    const currentDocument = {
      ...document,
      nodes: [{ ...document.nodes[0], label: 'Uncheckpointed edit' }],
    };
    repository.updateContent(
      'workspace-1',
      1,
      currentDocument,
      '2026-08-14T20:01:00.000Z',
    );

    repository.restore('workspace-1', 1, 2, '2026-08-14T20:02:00.000Z');

    expect(repository.getVersion('workspace-1', 2)).toMatchObject({
      reason: 'checkpoint',
      document: currentDocument,
    });
  });

  it('requires archival before permanent deletion and cascades version cleanup', () => {
    repository.create({
      id: 'workspace-1',
      name: 'First',
      document,
      now: '2026-08-14T20:00:00.000Z',
      reason: 'created',
    });
    expect(repository.deleteArchived('workspace-1')).toBe('not-archived');
    repository.setArchived('workspace-1', true, '2026-08-14T20:01:00.000Z');
    expect(repository.deleteArchived('workspace-1')).toBe('deleted');
    expect(repository.get('workspace-1')).toBeNull();
    expect(repository.listVersions('workspace-1', 30)).toEqual([]);
  });

  it('enforces one server migration per browser storage source', () => {
    repository.create({
      id: 'workspace-1',
      name: 'Recovered',
      document,
      migrationSource: 'mission-control:ideation',
      now: '2026-08-14T20:00:00.000Z',
      reason: 'migrated',
    });

    expect(() => repository.create({
      id: 'workspace-2',
      name: 'Duplicate recovery',
      document,
      migrationSource: 'mission-control:ideation',
      now: '2026-08-14T20:00:01.000Z',
      reason: 'migrated',
    })).toThrow();
    expect(repository.findByMigrationSource('mission-control:ideation')?.id)
      .toBe('workspace-1');
  });
});
