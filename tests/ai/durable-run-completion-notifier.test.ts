import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const createNotification = vi.fn(async (input: { dedupeKey: string }) => {
  void input;
});
vi.mock('@/lib/notifications/service', () => ({ createNotification }));

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-durable-ai-notifier-'));
process.env.MC_DB_PATH = join(testDirectory, 'runs.db');
process.env.MC_DATABASE_BACKEND = 'sqlite';

let database: typeof import('@/db');
let store: InstanceType<
  typeof import('@/lib/ai/durable-runs/sqlite-adapter').SqliteDurableAiRunStore
>;
let notifyDurableAiRunCompletion:
  typeof import('@/lib/ai/durable-runs/completion-notifier').notifyDurableAiRunCompletion;

beforeAll(async () => {
  const [databaseModule, sqliteAdapter, notifier] = await Promise.all([
    import('@/db'),
    import('@/lib/ai/durable-runs/sqlite-adapter'),
    import('@/lib/ai/durable-runs/completion-notifier'),
  ]);
  database = databaseModule;
  store = new sqliteAdapter.SqliteDurableAiRunStore();
  notifyDurableAiRunCompletion = notifier.notifyDurableAiRunCompletion;
});

afterAll(() => {
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

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        dedupeKey: 'ai-run:completion-notifier-run:cancelled',
        metadata: expect.objectContaining({
          runId: 'completion-notifier-run',
          status: 'cancelled',
        }),
      }),
    );
    expect(createNotification.mock.calls[1]?.[0].dedupeKey)
      .toBe(createNotification.mock.calls[0]?.[0].dedupeKey);
  });
});
