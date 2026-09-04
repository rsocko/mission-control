import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresTriagePersistenceRepositories } from '@/db/postgres/repositories/triage-repositories';
import type { TriagePersistenceRepositories } from '@/db/persistence/triage-repositories';
import {
  clearTriagePersistenceRepositories,
  registerTriagePersistenceRepositories,
} from '@/lib/triage/persistence';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const sqliteTouch = vi.hoisted(() => vi.fn());
vi.mock('@/db', () => {
  sqliteTouch();
  throw new Error('SQLite must not load in PostgreSQL triage routes');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const runId = randomUUID();
const itemId = `triage-route-${runId}`;

let backend: PostgresPersistenceBackend;
let repositories: TriagePersistenceRepositories;

describePostgres('PostgreSQL triage route parity', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    backend = new PostgresPersistenceBackend({
      config: resolvePostgresConfig({
        MC_POSTGRES_URL: connectionString,
        MC_POSTGRES_APPLICATION_NAME: 'mission-control-triage-route-parity-test',
      }),
    });
    await backend.initialize();
    repositories = createPostgresTriagePersistenceRepositories(backend.context.db);
    registerTriagePersistenceRepositories(repositories);
    await repositories.items.create({
      id: itemId,
      sourcePlatform: 'github',
      sourceId: itemId,
      sourceUrl: `https://example.invalid/${itemId}`,
      canonicalUrl: `https://example.invalid/${itemId}`,
      title: `Portable route ${runId}`,
      contentType: 'repo',
      capturedAt: '2026-09-01T12:00:00.000Z',
      ingestedAt: '2026-09-01T12:00:00.000Z',
      status: 'pending',
      aiCategories: ['software-development'],
      aiSuggestedActions: [],
      aiRelevanceScore: 88,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    });
  }, 30_000);

  afterAll(async () => {
    if (!backend) return;
    await backend.context.pool.query('DELETE FROM triage_items WHERE id = $1', [itemId]);
    clearTriagePersistenceRepositories(repositories);
    await backend.shutdown();
  });

  it('lists filtered queue items without evaluating SQLite', async () => {
    const { GET } = await import('@/app/api/triage/route');

    const response = await GET(new Request(
      `http://localhost/api/triage?status=pending&q=${encodeURIComponent(runId)}`,
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        id: itemId,
        sourcePlatform: 'github',
        status: 'pending',
      }),
    ]);
    expect(body.totalFiltered).toBe(1);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('uses the PostgreSQL content-type repository from a representative route', async () => {
    const { GET } = await import('@/app/api/triage/content-types/route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.contentTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'link', builtin: true }),
    ]));
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});
