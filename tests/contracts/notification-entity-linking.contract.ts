import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  NotificationEntityLinkingRepository,
} from '@/db/persistence/notification-entity-linking';

export interface NotificationEntityLinkingHarness {
  repository: NotificationEntityLinkingRepository;
  /** Inserts a `tasks` row for exact/suffix source-reference matching. */
  seedTask(input: {
    id: string;
    connectorInstanceId: string;
    sourceId: string;
  }): Promise<void> | void;
  /**
   * Inserts a `hub_projects` row. `repositoryJsonValue` is a raw JSON *value*
   * fragment (e.g. `'"owner/repo"'`, `'42'`, `'true'`, `'null'`) assigned to
   * the `metadata.repository` key, expressed identically on both backends so
   * the harness can exercise non-string/null/missing cases the same way.
   * Omit it to store `metadata` with no `repository` key at all.
   */
  seedProject(input: {
    id: string;
    repositoryJsonValue?: string;
  }): Promise<void> | void;
  close(): Promise<void> | void;
}

/**
 * Cross-backend behavioral contract for `NotificationEntityLinkingRepository`
 * (see `docs/architecture/persistence-boundaries.md`, "Web/API PostgreSQL
 * parity: Layer L02"). Every assertion here must hold identically for the
 * SQLite and PostgreSQL adapters: ASCII-only suffix case folding (not
 * PostgreSQL's locale-aware `ILIKE`), non-ASCII characters never folded, and
 * `metadata.repository` matching only true JSON strings (missing, JSON
 * `null`, and non-string scalars all resolve to zero matches on both
 * backends, even when the search term happens to equal the scalar's
 * stringified form).
 */
export function describeNotificationEntityLinkingContract(
  name: string,
  createHarness: () => NotificationEntityLinkingHarness | Promise<NotificationEntityLinkingHarness>,
): void {
  describe(`${name} notification entity-linking contract`, () => {
    let harness: NotificationEntityLinkingHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('resolves an exact source-id match', async () => {
      await harness.seedTask({
        id: 'task-exact',
        connectorInstanceId: 'connector-1',
        sourceId: 'owner/repo:42',
      });

      await expect(harness.repository.findTaskBySourceReference({
        connectorInstanceId: 'connector-1',
        repository: 'owner/repo',
        number: 42,
      })).resolves.toEqual({ id: 'task-exact' });
    });

    it('resolves a unique suffix match', async () => {
      await harness.seedTask({
        id: 'task-suffix',
        connectorInstanceId: 'connector-1',
        sourceId: 'prefix:owner/repo:43',
      });

      await expect(harness.repository.findTaskBySourceReference({
        connectorInstanceId: 'connector-1',
        repository: 'owner/repo',
        number: 43,
      })).resolves.toEqual({ id: 'task-suffix' });
    });

    it('returns null for zero task matches', async () => {
      await expect(harness.repository.findTaskBySourceReference({
        connectorInstanceId: 'connector-1',
        repository: 'missing/repo',
        number: 1,
      })).resolves.toBeNull();
    });

    it('returns null rather than choosing an ambiguous suffix match (2 matches)', async () => {
      await harness.seedTask({
        id: 'task-a',
        connectorInstanceId: 'connector-1',
        sourceId: 'a:owner/repo:44',
      });
      await harness.seedTask({
        id: 'task-b',
        connectorInstanceId: 'connector-1',
        sourceId: 'b:owner/repo:44',
      });

      await expect(harness.repository.findTaskBySourceReference({
        connectorInstanceId: 'connector-1',
        repository: 'owner/repo',
        number: 44,
      })).resolves.toBeNull();
    });

    it('matches a suffix case-insensitively for ASCII letters (mixed-case Owner/Repo:123)', async () => {
      await harness.seedTask({
        id: 'task-mixed-case',
        connectorInstanceId: 'connector-1',
        sourceId: 'prefix:Owner/Repo:123',
      });

      await expect(harness.repository.findTaskBySourceReference({
        connectorInstanceId: 'connector-1',
        repository: 'owner/repo',
        number: 123,
      })).resolves.toEqual({ id: 'task-mixed-case' });
    });

    it('does not fold non-ASCII characters at the suffix match boundary', async () => {
      // 'Ö' (U+00D6) vs 'ö' (U+00F6): an ASCII-only fold must treat these as
      // distinct on both backends, unlike PostgreSQL's locale-aware ILIKE.
      await harness.seedTask({
        id: 'task-non-ascii',
        connectorInstanceId: 'connector-1',
        sourceId: 'prefix:Öwner/repo:7',
      });

      await expect(harness.repository.findTaskBySourceReference({
        connectorInstanceId: 'connector-1',
        repository: 'öwner/repo',
        number: 7,
      })).resolves.toBeNull();
      await expect(harness.repository.findTaskBySourceReference({
        connectorInstanceId: 'connector-1',
        repository: 'Öwner/repo',
        number: 7,
      })).resolves.toEqual({ id: 'task-non-ascii' });
    });

    it('resolves a unique project by exact repository metadata string match', async () => {
      await harness.seedProject({ id: 'project-1', repositoryJsonValue: '"owner/repo"' });

      await expect(
        harness.repository.findProjectByRepository('owner/repo'),
      ).resolves.toBe('project-1');
    });

    it('returns null for zero project matches', async () => {
      await expect(
        harness.repository.findProjectByRepository('owner/repo'),
      ).resolves.toBeNull();
    });

    it('returns null rather than choosing an ambiguous project match (2 matches)', async () => {
      await harness.seedProject({ id: 'project-a', repositoryJsonValue: '"owner/repo"' });
      await harness.seedProject({ id: 'project-b', repositoryJsonValue: '"owner/repo"' });

      await expect(
        harness.repository.findProjectByRepository('owner/repo'),
      ).resolves.toBeNull();
    });

    it('returns null when repository metadata is missing entirely', async () => {
      await harness.seedProject({ id: 'project-missing' });

      await expect(
        harness.repository.findProjectByRepository('owner/repo'),
      ).resolves.toBeNull();
    });

    it('returns null when repository metadata is JSON null', async () => {
      await harness.seedProject({ id: 'project-null', repositoryJsonValue: 'null' });

      await expect(
        harness.repository.findProjectByRepository('owner/repo'),
      ).resolves.toBeNull();
    });

    it('returns null when repository metadata is a non-string JSON number, even matching its stringified form', async () => {
      await harness.seedProject({ id: 'project-number', repositoryJsonValue: '42' });

      await expect(
        harness.repository.findProjectByRepository('42'),
      ).resolves.toBeNull();
    });

    it('returns null when repository metadata is a non-string JSON boolean, even matching its stringified form', async () => {
      await harness.seedProject({ id: 'project-boolean', repositoryJsonValue: 'true' });

      await expect(
        harness.repository.findProjectByRepository('true'),
      ).resolves.toBeNull();
    });
  });
}
