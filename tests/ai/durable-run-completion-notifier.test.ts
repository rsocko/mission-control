import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ingestNotifications = vi.fn(async () => []);
vi.mock('@/lib/persistence/worker-runtime', () => ({
  assertCanRegisterWorkerPersistenceRepositories: vi.fn(),
  clearWorkerPersistenceRepositories: vi.fn(),
  getWorkerPersistenceRepositories: async () => ({
    execution: {
      notifications: {
        ingest: ingestNotifications,
      },
    },
  }),
  registerWorkerPersistenceRepositories: vi.fn(),
}));

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-durable-ai-notifier-'));
process.env.MC_DB_PATH = join(testDirectory, 'runs.db');
process.env.MC_DATABASE_BACKEND = 'sqlite';

let database: typeof import('@/db');
let store: InstanceType<
  typeof import('@/lib/ai/durable-runs/sqlite-adapter').SqliteDurableAiRunStore
>;
let notifyDurableAiRunCompletion:
  typeof import('@/lib/ai/durable-runs/completion-notifier').notifyDurableAiRunCompletion;
let durableRuntime: typeof import('@/lib/ai/durable-runs/runtime');

beforeAll(async () => {
  const [databaseModule, sqliteAdapter, notifier, runtime] = await Promise.all([
    import('@/db'),
    import('@/lib/ai/durable-runs/sqlite-adapter'),
    import('@/lib/ai/durable-runs/completion-notifier'),
    import('@/lib/ai/durable-runs/runtime'),
  ]);
  database = databaseModule;
  store = new sqliteAdapter.SqliteDurableAiRunStore();
  notifyDurableAiRunCompletion = notifier.notifyDurableAiRunCompletion;
  durableRuntime = runtime;
  durableRuntime.registerDurableAiRunRepository(store);
});

afterAll(() => {
  durableRuntime.clearDurableAiRunRepository(store);
  database.sqlite.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe('durable AI run completion notifier', () => {
  it('resolves backend-selected persistence and preserves the terminal dedupe key', async () => {
    const { run } = store.createRun({
      id: 'completion-notifier-run',
      idempotencyKey: 'completion-notifier:create',
      featureId: 'completion-notifier',
      sensitivity: 'standard',
      executionRoute: 'test-route',
    });
    store.requestCancellation(run.id);
    const terminal = store.getRun(run.id);
    if (!terminal) throw new Error('Expected a terminal durable AI run.');

    await notifyDurableAiRunCompletion(terminal);
    await notifyDurableAiRunCompletion(terminal);

    expect(ingestNotifications).toHaveBeenCalledTimes(2);
    expect(ingestNotifications).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({
        input: expect.objectContaining({
          dedupeKey: 'ai-run:completion-notifier-run:cancelled',
          metadata: expect.objectContaining({
            runId: 'completion-notifier-run',
            status: 'cancelled',
          }),
        }),
      })],
    );
    expect(ingestNotifications.mock.calls[1]?.[0]?.[0].input.dedupeKey)
      .toBe(ingestNotifications.mock.calls[0]?.[0]?.[0].input.dedupeKey);
  });
});
