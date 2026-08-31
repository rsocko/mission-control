import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PersistenceJson } from '@/db/persistence/contracts';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import type { TriageSyncScheduler } from '@/lib/triage/scheduler';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const sqliteTouch = vi.hoisted(() => vi.fn());

vi.mock('@/db', () => {
  const rejectSqliteAccess = () => {
    sqliteTouch();
    throw new Error('SQLite must not be touched by PostgreSQL triage execution');
  };
  return {
    get default() {
      return rejectSqliteAccess();
    },
    get db() {
      return rejectSqliteAccess();
    },
    get sqlite() {
      return rejectSqliteAccess();
    },
    get runTransaction() {
      return rejectSqliteAccess();
    },
    get initializeDatabase() {
      return rejectSqliteAccess();
    },
  };
});

vi.mock('@/lib/semantic-index/publication', () => ({
  publishSemanticEntityUpsert: vi.fn(async () => undefined),
}));

vi.mock('@/lib/triage/embed-resolver', () => ({
  resolveEmbed: vi.fn(async () => ({ success: false })),
}));

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
const runId = randomUUID();
const githubSecret = `synthetic-github-${runId}`;
const redditSecret = `synthetic-reddit-${runId}`;
const youtubeSecret = `synthetic-youtube-${runId}`;
const sourcePrefix = `layer7-${runId}`;
const goodPlaylist = `${sourcePrefix}-good`;
const failedPlaylist = `${sourcePrefix}-failed`;
const syncStateIds = [
  'github-stars',
  'reddit-saved',
  'youtube',
  `youtube-${goodPlaylist}`,
  `youtube-${failedPlaylist}`,
  'document-intelligence',
];

let core: CorePersistenceRepositories;
let worker: WorkerPersistenceRepositories;
let scheduler: TriageSyncScheduler;
let oldCredentials: PersistenceJson | null;
let pool: import('pg').Pool;
let shutdownRuntimeDatabase: (() => Promise<void>) | undefined;
const failReddit = true;
let stallGitHub = false;
let releaseGitHub: (() => void) | undefined;
let markGitHubRequested: (() => void) | undefined;

function jsonResponse(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function installSyntheticRemotes(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === 'api.github.com') {
      if (stallGitHub) {
        markGitHubRequested?.();
        await new Promise<void>((resolve) => {
          releaseGitHub = resolve;
        });
      }
      return jsonResponse([{
        starred_at: '2026-08-30T10:00:00.000Z',
        repo: {
          full_name: `mission-control/${sourcePrefix}`,
          html_url: `https://github.com/mission-control/${sourcePrefix}`,
          description: 'Synthetic PostgreSQL triage smoke repository',
          stargazers_count: 1,
          language: 'TypeScript',
          topics: ['test'],
          owner: { login: 'mission-control' },
          fork: false,
        },
      }]);
    }

    if (url.hostname === 'www.reddit.com') {
      if (failReddit) {
        throw new Error(`synthetic upstream failure ${redditSecret}`);
      }
      return jsonResponse({ access_token: `${sourcePrefix}-reddit-access` });
    }

    if (url.hostname === 'oauth.reddit.com') {
      return jsonResponse({
        data: {
          after: null,
          children: [{
            kind: 't3',
            data: {
              name: `t3_${sourcePrefix}`,
              title: 'Synthetic Reddit saved post',
              permalink: `/r/test/comments/${sourcePrefix}`,
              created_utc: 1_788_105_600,
            },
          }],
        },
      });
    }

    if (url.hostname === 'oauth2.googleapis.com') {
      return jsonResponse({ access_token: `${sourcePrefix}-youtube-access` });
    }

    if (url.hostname === 'www.googleapis.com') {
      const playlistId = url.searchParams.get('playlistId');
      if (playlistId === failedPlaylist) {
        return jsonResponse({}, 503, 'Synthetic unavailable');
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: 'Synthetic YouTube video',
            description: 'PostgreSQL triage scheduler smoke',
            publishedAt: '2026-08-30T10:00:00.000Z',
          },
          contentDetails: { videoId: sourcePrefix },
        }],
      });
    }

    if (url.origin === 'http://localhost:8200') {
      return jsonResponse(Array.from({ length: 101 }, (_, index) => ({
        id: `${sourcePrefix}-${index}`,
        document_id: index,
        document_title: `Synthetic document ${index}`,
        action_type: 'review',
        urgency: 'medium',
        summary: 'Synthetic bounded-batch action',
        status: 'pending',
        action_ready: true,
        created_at: '2026-08-30T10:00:00.000Z',
        document_url: `https://documents.invalid/${sourcePrefix}/${index}`,
      })));
    }

    throw new Error(`Unexpected synthetic remote URL: ${url.toString()}`);
  }));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describePostgres('PostgreSQL four-source triage scheduler smoke', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_POSTGRES_URL = connectionString;
    process.env.MC_POSTGRES_SSL_MODE =
      new URL(connectionString!).searchParams.get('sslmode') ?? 'disable';

    const runtime = await import('@/db/runtime');
    await runtime.initializeRuntimeDatabase();
    shutdownRuntimeDatabase = runtime.shutdownRuntimeDatabase;
    pool = runtime.getPostgresPersistenceBackend().context.pool;

    const [{ getCorePersistenceRepositories }, workerRuntime, schedulerModule] =
      await Promise.all([
        import('@/lib/persistence/runtime'),
        import('@/lib/persistence/worker-runtime'),
        import('@/lib/triage/scheduler'),
      ]);
    core = getCorePersistenceRepositories();
    worker = await workerRuntime.getWorkerPersistenceRepositories();
    scheduler = new schedulerModule.TriageSyncScheduler();

    await pool.query(
      'DELETE FROM triage_items WHERE source_id LIKE $1',
      [`%${sourcePrefix}%`],
    );
    await pool.query(
      'DELETE FROM triage_sync_state WHERE id = ANY($1::text[])',
      [syncStateIds],
    );
    oldCredentials = await core.settings.get('triage_source_credentials');
    await core.settings.set('triage_source_credentials', {
      github: { pat: githubSecret },
      reddit: {
        clientId: `${sourcePrefix}-reddit-client`,
        clientSecret: redditSecret,
        refreshToken: `${sourcePrefix}-reddit-refresh`,
        username: `${sourcePrefix}-reddit-user`,
      },
      youtube: {
        clientId: `${sourcePrefix}-youtube-client`,
        clientSecret: `${sourcePrefix}-youtube-client-secret`,
        refreshToken: youtubeSecret,
        playlists: [
          { id: goodPlaylist, label: 'Synthetic good', enabled: true },
          { id: failedPlaylist, label: 'Synthetic failed', enabled: true },
        ],
      },
    });
    installSyntheticRemotes();
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (pool) {
      await pool.query(
        'DELETE FROM triage_items WHERE source_id LIKE $1',
        [`%${sourcePrefix}%`],
      );
      await pool.query(
        'DELETE FROM triage_sync_state WHERE id = ANY($1::text[])',
        [syncStateIds],
      );
      if (oldCredentials === null) {
        await core.settings.delete('triage_source_credentials');
      } else {
        await core.settings.set('triage_source_credentials', oldCredentials);
      }
    }
    if (shutdownRuntimeDatabase) await shutdownRuntimeDatabase();
    restoreEnvironment('MC_DATABASE_BACKEND', originalBackend);
    restoreEnvironment('MC_POSTGRES_URL', originalPostgresUrl);
    restoreEnvironment('MC_POSTGRES_SSL_MODE', originalSslMode);
  });

  it('runs bounded, isolated imports with revision CAS and no SQLite fallback', async () => {
    const github = await scheduler.runImport('github-stars');
    const reddit = await scheduler.runImport('reddit-saved');
    const youtube = await scheduler.runImport('youtube');
    const documents = await scheduler.runImport('document-intelligence');

    expect(github).toMatchObject({ outcome: 'success', imported: 1 });
    expect(reddit).toMatchObject({ outcome: 'failure', imported: 0 });
    expect(youtube).toMatchObject({ outcome: 'partial', imported: 1 });
    expect(documents).toMatchObject({ outcome: 'success', imported: 101 });
    expect(JSON.stringify([reddit, youtube])).not.toContain(redditSecret);
    expect(JSON.stringify([github, youtube])).not.toContain(githubSecret);
    expect(JSON.stringify([github, youtube])).not.toContain(youtubeSecret);

    const itemCounts = await pool.query<{ source_platform: string; count: string }>(`
      SELECT source_platform, COUNT(*)::text AS count
      FROM triage_items
      WHERE source_id LIKE $1
      GROUP BY source_platform
    `, [`%${sourcePrefix}%`]);
    expect(Object.fromEntries(
      itemCounts.rows.map((row) => [row.source_platform, Number(row.count)]),
    )).toEqual({
      github: 1,
      youtube: 1,
      'document-intelligence': 101,
    });

    const states = new Map(
      (await worker.triage.syncState.getAll())
        .filter((state) => syncStateIds.includes(state.id))
        .map((state) => [state.id, state]),
    );
    expect(states.get('github-stars')).toMatchObject({ revision: 1, totalImported: 1 });
    expect(states.get('reddit-saved')).toMatchObject({
      revision: 1,
      totalImported: 0,
      lastRunErrors: ['Reddit saved import failed'],
    });
    expect(states.get(`youtube-${goodPlaylist}`)).toMatchObject({
      revision: 1,
      totalImported: 1,
    });
    expect(states.get(`youtube-${failedPlaylist}`)).toMatchObject({
      revision: 1,
      totalImported: 0,
    });
    expect(states.get('youtube')).toMatchObject({ revision: 1, totalImported: 1 });
    expect(states.get('document-intelligence')).toMatchObject({
      revision: 1,
      totalImported: 101,
    });

    let githubRequested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      githubRequested = resolve;
    });
    markGitHubRequested = githubRequested;
    stallGitHub = true;
    const staleRun = scheduler.runImport('github-stars');
    await requestStarted;
    const current = await worker.triage.syncState.get('github-stars');
    expect(current).not.toBeNull();
    const intervening = await worker.triage.syncState.recordRun({
      sourceId: 'github-stars',
      expectedRevision: current!.revision,
      cursor: { operation: 'preserve' },
      imported: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
      syncedAt: '2026-08-30T10:01:00.000Z',
    });
    expect(intervening.status).toBe('applied');
    releaseGitHub?.();
    await expect(staleRun).resolves.toMatchObject({ outcome: 'stale' });

    expect(sqliteTouch).not.toHaveBeenCalled();
  }, 120_000);
});
