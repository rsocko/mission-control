import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const schedulerMocks = vi.hoisted(() => {
  let running = true;
  return {
    getStatus: vi.fn(() => []),
    isRunning: vi.fn(() => running),
    restart: vi.fn(async () => { running = true; }),
    start: vi.fn(async () => { running = true; }),
    stop: vi.fn(async () => { running = false; }),
    reset: () => { running = true; },
  };
});

vi.mock('@/lib/push/scheduler', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/push/scheduler')>();
  return {
    ...original,
    pushNotificationScheduler: schedulerMocks,
  };
});
vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';

let db: typeof import('@/db').default;
let schema: typeof import('@/db/schema');
let GET: typeof import('@/app/api/push/scheduler/route').GET;
let POST: typeof import('@/app/api/push/scheduler/route').POST;

beforeAll(async () => {
  db = (await import('@/db')).default;
  schema = await import('@/db/schema');
  ({ GET, POST } = await import('@/app/api/push/scheduler/route'));
});

beforeEach(() => {
  db.delete(schema.appSettings).run();
  schedulerMocks.reset();
});

describe('scheduled summary scheduler state', () => {
  it('persists a stopped state across runtime restarts', async () => {
    const response = await POST(new Request('http://localhost/api/push/scheduler', {
      method: 'POST',
      body: JSON.stringify({ action: 'stop' }),
    }));

    expect(response.status).toBe(200);
    expect(await (await GET()).json()).toMatchObject({
      enabled: false,
      running: false,
    });
  });

  it('re-enables persisted scheduling when started', async () => {
    await POST(new Request('http://localhost/api/push/scheduler', {
      method: 'POST',
      body: JSON.stringify({ action: 'stop' }),
    }));

    const response = await POST(new Request('http://localhost/api/push/scheduler', {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    }));

    expect(response.status).toBe(200);
    expect(await (await GET()).json()).toMatchObject({
      enabled: true,
      running: true,
    });
  });
});
