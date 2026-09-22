import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ConnectorNotificationCommand } from '@/db/persistence/connector-execution';
import { createPostgresConnectorExecutionRepositories } from '@/db/postgres/repositories/connector-execution-repositories';
import { createPostgresNotificationEnrichmentRepository } from '@/db/postgres/repositories/notification-enrichment-repository';
import {
  createPostgresNotificationEntityLinkingRepository,
} from '@/db/postgres/repositories/notification-entity-linking-repository';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated by PostgreSQL enrichment');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
let runtime: typeof import('@/db/runtime') | null = null;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function pool(): Promise<Pool> {
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  if (!runtime) {
    assertSafeIntegrationTestTarget(connectionString);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_POSTGRES_URL = connectionString;
    process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString).searchParams.get('sslmode')
      ?? 'disable';
    runtime = await import('@/db/runtime');
    await runtime.initializeRuntimeDatabase();
  }
  return runtime.getPostgresPersistenceBackend().context.pool;
}

async function reset() {
  const db = await pool();
  await db.query("DELETE FROM notifications WHERE id LIKE 'ne-%'");
  await db.query("DELETE FROM tasks WHERE id LIKE 'ne-link-%'");
  await db.query("DELETE FROM hub_projects WHERE id LIKE 'ne-link-%'");
}

async function seed(id: string, revision = 'r1') {
  const db = await pool();
  await db.query(
    `
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, received_at, sort_at,
        enrichment_revision, enrichment_generation
      ) VALUES ($1, $2, 'github-issues', 'ne-connector', 'Review requested', $3, $3, $4, 1)
    `,
    [id, `ne-source-${id}`, '2026-01-01T00:00:00.000Z', revision],
  );
  await db.query(
    `
      INSERT INTO notification_enrichment_jobs (
        id, notification_id, source_id, source_revision, source_generation,
        payload, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6, $6)
    `,
    [
      `ne-job-${id}`,
      id,
      `ne-source-${id}`,
      revision,
      JSON.stringify({
        notificationId: id,
        title: 'Review requested',
        body: null,
        connectorType: 'github-issues',
        category: 'development',
        metadata: {},
        presentation: { reason: 'review_requested' },
      }),
      '2026-01-01T00:00:00.000Z',
    ],
  );
}

function command(id: string): ConnectorNotificationCommand {
  return {
    input: {
      id,
      sourceId: `ne-source-${id}`,
      connectorType: 'github-issues',
      connectorInstanceId: 'ne-connector',
      title: 'Review requested',
      body: 'Please review',
      level: 'fyi',
      category: 'development',
      templateKey: null,
      readState: 'unread',
      sourceState: 'active',
      sourceActivityAt: null,
      sourceActivityKey: null,
      reopenPolicy: 'handled',
      occurrenceKey: 'initial',
      isActionable: true,
      primaryActionId: null,
      receivedAt: '2026-01-01T00:00:00.000Z',
      sortAt: '2026-01-01T00:00:00.000Z',
      relatedTaskId: null,
      relatedProjectId: null,
      relatedEntityType: null,
      relatedEntityId: null,
      navigationTarget: null,
      metadata: { sourceOwned: 'current' },
      presentation: {},
    },
    actions: [],
    enrichment: {
      sourceRevision: 'r1',
      payload: {
        notificationId: id,
        title: 'Review requested',
        body: 'Please review',
        connectorType: 'github-issues',
        category: 'development',
        metadata: { sourceOwned: 'current' },
        presentation: {},
      },
    },
  };
}

if (connectionString) {
  beforeEach(reset);

  afterAll(async () => {
    if (runtime) {
      await reset();
      await runtime.shutdownRuntimeDatabase();
    }
    restore('MC_DATABASE_BACKEND', originalBackend);
    restore('MC_POSTGRES_URL', originalPostgresUrl);
    restore('MC_POSTGRES_SSL_MODE', originalSslMode);
  });

  describe('PostgreSQL notification enrichment repository', () => {
    it('matches the SQLite entity-linking contract for tasks and projects', async () => {
      const db = await pool();
      await db.query(
        `INSERT INTO tasks (
           id, source_id, connector_type, connector_instance_id, title, status,
           priority, created_at, updated_at, last_synced_at
         ) VALUES
           ('ne-link-exact', 'owner/repo:42', 'github-issues', 'ne-link-connector',
             'Exact', 'todo', 'normal', $1, $1, $1),
           ('ne-link-suffix', 'prefix:owner/repo:43', 'github-issues', 'ne-link-connector',
             'Suffix', 'todo', 'normal', $1, $1, $1),
           ('ne-link-ambiguous-a', 'a:owner/repo:44', 'github-issues', 'ne-link-connector',
             'Ambiguous A', 'todo', 'normal', $1, $1, $1),
           ('ne-link-ambiguous-b', 'b:owner/repo:44', 'github-issues', 'ne-link-connector',
             'Ambiguous B', 'todo', 'normal', $1, $1, $1)`,
        ['2026-01-01T00:00:00.000Z'],
      );
      await db.query(
        `INSERT INTO hub_projects (
           id, name, color, source_bindings, auto_include_rules, kanban_columns,
           default_view, status, hidden, sort_order, hierarchy_revision, metadata,
           created_at, updated_at
         ) VALUES (
           'ne-link-project', 'Entity link', '#3b82f6', '[]'::jsonb, '[]'::jsonb,
           '[]'::jsonb, 'list', 'active', false, 0, 0,
           '{"repository":"owner/repo"}'::jsonb, $1, $1
         )`,
        ['2026-01-01T00:00:00.000Z'],
      );
      const repository = createPostgresNotificationEntityLinkingRepository(db);

      await expect(repository.findTaskBySourceReference({
        connectorInstanceId: 'ne-link-connector',
        repository: 'owner/repo',
        number: 42,
      })).resolves.toEqual({ id: 'ne-link-exact' });
      await expect(repository.findTaskBySourceReference({
        connectorInstanceId: 'ne-link-connector',
        repository: 'owner/repo',
        number: 43,
      })).resolves.toEqual({ id: 'ne-link-suffix' });
      await expect(
        repository.findProjectByRepository('owner/repo'),
      ).resolves.toBe('ne-link-project');
      await expect(repository.findTaskBySourceReference({
        connectorInstanceId: 'ne-link-connector',
        repository: 'owner/repo',
        number: 44,
      })).resolves.toBeNull();
      await expect(repository.findTaskBySourceReference({
        connectorInstanceId: 'ne-link-connector',
        repository: 'missing/repo',
        number: 45,
      })).resolves.toBeNull();
    });

    it('claims concurrently without duplication and fences a stale owner', async () => {
      const db = await pool();
      const repository = createPostgresNotificationEnrichmentRepository(db);
      await seed('ne-claim');
      const now = new Date('2026-01-01T00:00:00.000Z');
      const claims = await Promise.all([
        repository.claimNext({ now, leaseMs: 1_000, owner: 'worker-a' }),
        repository.claimNext({ now, leaseMs: 1_000, owner: 'worker-b' }),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const stale = claims.find(Boolean)!;
      const recovered = await repository.claimNext({
        now: new Date('2026-01-01T00:00:02.000Z'),
        leaseMs: 1_000,
        owner: 'worker-c',
      });
      expect(recovered).toMatchObject({ id: stale.id, attemptCount: 2 });
      expect(recovered!.leaseToken).not.toBe(stale.leaseToken);
      expect(await repository.deadLetter(stale, {
        lastError: 'stale',
        completedAt: '2026-01-01T00:00:03.000Z',
      })).toBe(false);
    });

    it('preserves completed current-revision metadata across idempotent ingest', async () => {
        const db = await pool();
        const execution = createPostgresConnectorExecutionRepositories(db);
        const repository = createPostgresNotificationEnrichmentRepository(db);
        const initial = command('ne-ingest');
        await execution.notifications.ingest([initial]);
        const claim = await repository.claimNext({
          now: new Date('2099-01-01T00:00:00.000Z'),
          leaseMs: 60_000,
          owner: 'worker',
        });
        await repository.complete(claim!, {
          metadata: {
            aiSummary: 'Durable summary',
            aiEnrichedAt: '2099-01-01T00:00:01.000Z',
          },
          completedAt: '2099-01-01T00:00:01.000Z',
        });
        const before = await db.query(
          "SELECT count(*)::int AS count FROM notification_delivery_events WHERE notification_id = 'ne-ingest'",
        );

        await execution.notifications.ingest([{
          ...initial,
          input: { ...initial.input, id: 'ne-ignored-replay' },
        }]);

        const result = await db.query(
          `SELECT
             n.metadata,
             (SELECT count(*)::int FROM notification_enrichment_jobs WHERE notification_id = n.id)
               AS job_count,
             (SELECT count(*)::int FROM notification_delivery_events WHERE notification_id = n.id)
               AS delivery_count
           FROM notifications n WHERE n.id = 'ne-ingest'`,
        );
        expect(result.rows[0]).toEqual({
          metadata: {
            sourceOwned: 'current',
            aiSummary: 'Durable summary',
            aiEnrichedAt: '2099-01-01T00:00:01.000Z',
          },
          job_count: 1,
          delivery_count: before.rows[0].count,
        });
    });

    it('creates one monotonic generation for concurrent A-B-A reversion and fences stale A', async () => {
        const db = await pool();
        const execution = createPostgresConnectorExecutionRepositories(db);
        const repository = createPostgresNotificationEnrichmentRepository(db);
        const revisionA = command('ne-reversion');
        await execution.notifications.ingest([revisionA]);
        const staleA = await repository.claimNext({
          now: new Date('2099-01-01T00:00:00.000Z'),
          leaseMs: 60_000,
          owner: 'worker-a',
        });
        const revisionB = {
          ...revisionA,
          input: { ...revisionA.input, id: 'ne-ignored-b', body: 'Revision B' },
          enrichment: {
            sourceRevision: 'r2',
            payload: { ...revisionA.enrichment!.payload!, body: 'Revision B' },
          },
        };
        await execution.notifications.ingest([revisionB]);
        const deliveryCount = await db.query(
          "SELECT count(*)::int AS count FROM notification_delivery_events WHERE notification_id = 'ne-reversion'",
        );

        await Promise.all([
          execution.notifications.ingest([{
            ...revisionA,
            input: { ...revisionA.input, id: 'ne-ignored-a-1' },
          }]),
          execution.notifications.ingest([{
            ...revisionA,
            input: { ...revisionA.input, id: 'ne-ignored-a-2' },
          }]),
        ]);

        expect(await repository.complete(staleA!, {
          metadata: { aiSummary: 'stale generation one' },
          completedAt: '2099-01-01T00:00:01.000Z',
        })).toBe('superseded');
        const result = await db.query(
          `SELECT source_revision, source_generation, status
           FROM notification_enrichment_jobs
           WHERE notification_id = 'ne-reversion'
           ORDER BY source_generation`,
        );
        expect(result.rows).toEqual([
          { source_revision: 'r1', source_generation: 1, status: 'superseded' },
          { source_revision: 'r2', source_generation: 2, status: 'superseded' },
          { source_revision: 'r1', source_generation: 3, status: 'pending' },
        ]);
        const current = await db.query(
          `SELECT enrichment_revision, enrichment_generation, metadata,
             (SELECT count(*)::int FROM notification_delivery_events WHERE notification_id = n.id)
               AS delivery_count
           FROM notifications n WHERE id = 'ne-reversion'`,
        );
        expect(current.rows[0]).toEqual({
          enrichment_revision: 'r1',
          enrichment_generation: 3,
          metadata: { sourceOwned: 'current' },
          delivery_count: deliveryCount.rows[0].count,
        });
    });

    it.each([
      ['revision change', "UPDATE notifications SET enrichment_revision = 'r2'"],
      ['source deletion', "UPDATE notifications SET source_state = 'deleted'"],
    ])('does not merge metadata after %s', async (_label, mutation) => {
      const db = await pool();
      const repository = createPostgresNotificationEnrichmentRepository(db);
      await seed('ne-stale');
      const claim = await repository.claimNext({
        now: new Date('2026-01-01T00:00:00.000Z'),
        leaseMs: 60_000,
        owner: 'worker',
      });
      await db.query(`${mutation} WHERE id = 'ne-stale'`);
      expect(await repository.complete(claim!, {
        metadata: { aiSummary: 'must-not-merge' },
        completedAt: '2026-01-01T00:00:01.000Z',
      })).toBe('superseded');
      const result = await db.query(
        "SELECT metadata, status FROM notifications JOIN notification_enrichment_jobs ON notification_id = notifications.id WHERE notifications.id = 'ne-stale'",
      );
      expect(result.rows[0].metadata).toEqual({});
      expect(result.rows[0].status).toBe('superseded');
    });

    it('supports retry, dead-letter, and explicit stale-lease recovery', async () => {
      const db = await pool();
      const repository = createPostgresNotificationEnrichmentRepository(db);
      await seed('ne-retry');
      const claim = await repository.claimNext({
        now: new Date('2026-01-01T00:00:00.000Z'),
        leaseMs: 1_000,
        owner: 'worker',
      });
      expect(await repository.scheduleRetry(claim!, {
        nextAttemptAt: '2026-01-01T00:01:00.000Z',
        lastError: 'enrichment_failed',
      })).toBe(true);
      const retry = await repository.claimNext({
        now: new Date('2026-01-01T00:01:00.000Z'),
        leaseMs: 1_000,
        owner: 'worker',
      });
      expect(await repository.recoverStaleLeases({
        now: new Date('2026-01-01T00:01:02.000Z'),
      })).toBe(1);
      const recovered = await repository.claimNext({
        now: new Date('2026-01-01T00:01:02.000Z'),
        leaseMs: 1_000,
        owner: 'replacement',
      });
      expect(recovered).toMatchObject({ id: retry!.id, attemptCount: 3 });
      expect(await repository.deadLetter(recovered!, {
        lastError: 'retry_limit_exhausted',
        completedAt: '2026-01-01T00:01:03.000Z',
      })).toBe(true);
    });

    it('dead-letters a poisoned jsonb payload without surfacing its value', async () => {
      const db = await pool();
      const repository = createPostgresNotificationEnrichmentRepository(db);
      await seed('ne-poison');
      await db.query(
        "UPDATE notification_enrichment_jobs SET payload = '[\"secret-value\"]'::jsonb WHERE id = 'ne-job-ne-poison'",
      );
      expect(await repository.claimNext({
        now: new Date(),
        leaseMs: 60_000,
        owner: 'worker',
      })).toBeNull();
      const result = await db.query(
        "SELECT status, last_error FROM notification_enrichment_jobs WHERE id = 'ne-job-ne-poison'",
      );
      expect(result.rows[0]).toEqual({ status: 'dead_letter', last_error: 'invalid_payload' });
      expect(JSON.stringify(result.rows[0])).not.toContain('secret-value');
    });
  });
} else {
  describe('PostgreSQL notification enrichment repository', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
