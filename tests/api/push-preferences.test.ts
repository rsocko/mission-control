import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const schedulerMocks = vi.hoisted(() => ({
  isRunning: vi.fn(() => false),
  restart: vi.fn(),
}));

vi.mock('@/lib/push/scheduler', () => ({
  pushNotificationScheduler: schedulerMocks,
}));
vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';

let db: typeof import('@/db').default;
let schema: typeof import('@/db/schema');
let GET: typeof import('@/app/api/push/preferences/route').GET;
let PUT: typeof import('@/app/api/push/preferences/route').PUT;

beforeAll(async () => {
  db = (await import('@/db')).default;
  schema = await import('@/db/schema');
  ({ GET, PUT } = await import('@/app/api/push/preferences/route'));
});

beforeEach(() => {
  db.delete(schema.pushPreferences).run();
  db.delete(schema.appSettings).run();
  schedulerMocks.isRunning.mockReturnValue(false);
  schedulerMocks.restart.mockReset();
});

describe('push preferences', () => {
  it('defaults push delivery to enabled', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pushDeliveryEnabled: true });
  });

  it('persists the push delivery master switch independently of scheduler state', async () => {
    const response = await PUT(new Request('http://localhost/api/push/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushDeliveryEnabled: false }),
    }));

    expect(response.status).toBe(200);
    expect(schedulerMocks.restart).not.toHaveBeenCalled();
    expect(await (await GET()).json()).toMatchObject({ pushDeliveryEnabled: false });
  });

  it('rejects non-boolean push delivery values', async () => {
    const response = await PUT(new Request('http://localhost/api/push/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushDeliveryEnabled: 'false' }),
    }));

    expect(response.status).toBe(400);
  });

  it('does not re-enable push delivery when an older client omits the field', async () => {
    await PUT(new Request('http://localhost/api/push/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushDeliveryEnabled: false }),
    }));

    const response = await PUT(new Request('http://localhost/api/push/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ morningHour: 9 }),
    }));

    expect(response.status).toBe(200);
    expect(await (await GET()).json()).toMatchObject({
      morningHour: 9,
      pushDeliveryEnabled: false,
    });
  });
});
