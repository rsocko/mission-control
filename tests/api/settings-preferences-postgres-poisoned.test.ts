import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistenceJson } from '@/db/persistence/contracts';

const runtime = vi.hoisted(() => {
  const values = new Map<string, PersistenceJson>();
  const sqliteTouch = vi.fn();
  const settings = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: PersistenceJson) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
  };
  return { values, sqliteTouch, settings };
});

vi.mock('@/db', () => {
  runtime.sqliteTouch();
  throw new Error('SQLite was evaluated');
});

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositoriesForBackend: async () => ({
    settings: runtime.settings,
  }),
}));

describe('PostgreSQL preference settings routes with SQLite poisoned', () => {
  beforeEach(() => {
    runtime.values.clear();
    runtime.sqliteTouch.mockClear();
    runtime.settings.get.mockClear();
    runtime.settings.set.mockClear();
    runtime.settings.delete.mockClear();
  });

  it('reads and writes capture and inbox preferences without loading SQLite', async () => {
    const capture = await import('@/app/api/settings/capture-destination/route');
    const inbox = await import('@/app/api/settings/inbox-lists/route');

    await expect((await capture.GET()).json()).resolves.toEqual({
      destination: { connectorType: 'local' },
    });
    const captureResponse = await capture.PUT(new Request(
      'http://localhost/api/settings/capture-destination',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connectorType: 'microsoft-todo',
          sourceListId: 'inbox',
        }),
      },
    ));
    await expect(captureResponse.json()).resolves.toEqual({
      destination: {
        connectorType: 'microsoft-todo',
        sourceListId: 'inbox',
      },
    });

    const lists = [
      { connectorType: 'microsoft-todo', sourceListId: 'a' },
      { connectorType: 'microsoft-todo', sourceListId: 'a', label: 'Duplicate' },
    ];
    const inboxResponse = await inbox.PUT(new Request(
      'http://localhost/api/settings/inbox-lists',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lists }),
      },
    ));
    await expect(inboxResponse.json()).resolves.toEqual({ lists });
    await expect((await inbox.GET()).json()).resolves.toEqual({ lists });
    expect(runtime.sqliteTouch).not.toHaveBeenCalled();
  });

  it('preserves dopamine defaults, partial merge behavior, and validation errors', async () => {
    const dopamine = await import('@/app/api/settings/dopamine-menu/route');

    await expect((await dopamine.GET()).json()).resolves.toMatchObject({
      enabled: true,
      threshold: 5,
    });
    const update = await dopamine.PATCH(new Request(
      'http://localhost/api/settings/dopamine-menu',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, threshold: '8' }),
      },
    ));
    await expect(update.json()).resolves.toMatchObject({
      enabled: false,
      threshold: 8,
    });

    const invalidThreshold = await dopamine.PATCH(new Request(
      'http://localhost/api/settings/dopamine-menu',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threshold: 0 }),
      },
    ));
    expect(invalidThreshold.status).toBe(400);
    await expect(invalidThreshold.json()).resolves.toEqual({
      error: 'Threshold must be an integer between 1 and 100',
    });

    const invalidRewards = await dopamine.PATCH(new Request(
      'http://localhost/api/settings/dopamine-menu',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rewards: [{ id: 'missing-fields' }] }),
      },
    ));
    expect(invalidRewards.status).toBe(400);
    await expect(invalidRewards.json()).resolves.toEqual({
      error: 'Each reward must have id, emoji, and label strings',
    });
    expect(runtime.sqliteTouch).not.toHaveBeenCalled();
  });

  it('preserves capture and inbox request validation errors before persistence', async () => {
    const capture = await import('@/app/api/settings/capture-destination/route');
    const inbox = await import('@/app/api/settings/inbox-lists/route');

    const missingConnector = await capture.PUT(new Request(
      'http://localhost/api/settings/capture-destination',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceListId: 'inbox' }),
      },
    ));
    expect(missingConnector.status).toBe(400);
    await expect(missingConnector.json()).resolves.toEqual({
      error: 'connectorType is required',
    });

    const invalidLists = await inbox.PUT(new Request(
      'http://localhost/api/settings/inbox-lists',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lists: 'inbox' }),
      },
    ));
    expect(invalidLists.status).toBe(400);
    await expect(invalidLists.json()).resolves.toEqual({
      error: 'lists must be an array',
    });
    expect(runtime.settings.set).not.toHaveBeenCalled();
    expect(runtime.sqliteTouch).not.toHaveBeenCalled();
  });
});
