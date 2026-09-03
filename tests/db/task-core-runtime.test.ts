import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';
import {
  clearTaskCorePersistence,
  getRegisteredTaskCorePersistence,
  getTaskCorePersistence,
  registerTaskCorePersistence,
  registerTaskCorePersistenceProvider,
} from '@/lib/tasks/core/runtime';

/**
 * Composition-seam semantics for the L04 task-core registry.
 *
 * The seam has to guarantee three things for the migration to be honest:
 * an explicit (PostgreSQL) registration always beats the lazy SQLite default,
 * the lazy provider is resolved at most once per registration, and a failed
 * resolution is not cached as a permanent poison pill.
 */

function stub(name: string): TaskCorePersistence {
  return { marker: name } as unknown as TaskCorePersistence;
}

describe('task-core persistence runtime', () => {
  beforeEach(() => {
    clearTaskCorePersistence();
  });

  afterEach(() => {
    clearTaskCorePersistence();
  });

  it('throws a directive error when nothing is registered', async () => {
    await expect(getTaskCorePersistence()).rejects.toThrow(
      /Task-core persistence has not been registered/,
    );
    expect(getRegisteredTaskCorePersistence()).toBeNull();
  });

  it('returns an explicitly registered composition without touching the provider', async () => {
    const provider = vi.fn(() => stub('sqlite'));
    registerTaskCorePersistenceProvider(provider);
    registerTaskCorePersistence(stub('postgres'));

    await expect(getTaskCorePersistence()).resolves.toEqual({ marker: 'postgres' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('lets an explicit registration win even when the provider was installed later', async () => {
    registerTaskCorePersistence(stub('postgres'));
    const provider = vi.fn(() => stub('sqlite'));
    registerTaskCorePersistenceProvider(provider);

    await expect(getTaskCorePersistence()).resolves.toEqual({ marker: 'postgres' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('resolves the lazy provider at most once per registration', async () => {
    const provider = vi.fn(async () => stub('sqlite'));
    registerTaskCorePersistenceProvider(provider);

    const [first, second] = await Promise.all([
      getTaskCorePersistence(),
      getTaskCorePersistence(),
    ]);
    expect(first).toBe(second);
    expect(await getTaskCorePersistence()).toBe(first);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after a new provider registration instead of serving a stale value', async () => {
    registerTaskCorePersistenceProvider(async () => stub('first'));
    await expect(getTaskCorePersistence()).resolves.toEqual({ marker: 'first' });

    registerTaskCorePersistenceProvider(async () => stub('second'));
    await expect(getTaskCorePersistence()).resolves.toEqual({ marker: 'second' });
  });

  it('does not cache a failed resolution', async () => {
    let attempt = 0;
    registerTaskCorePersistenceProvider(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('driver unavailable');
      return stub('recovered');
    });

    await expect(getTaskCorePersistence()).rejects.toThrow('driver unavailable');
    await expect(getTaskCorePersistence()).resolves.toEqual({ marker: 'recovered' });
    expect(attempt).toBe(2);
  });

  it('clears both the pinned value and the provider', async () => {
    registerTaskCorePersistence(stub('postgres'));
    expect(getRegisteredTaskCorePersistence()).toEqual({ marker: 'postgres' });
    clearTaskCorePersistence();
    expect(getRegisteredTaskCorePersistence()).toBeNull();
    await expect(getTaskCorePersistence()).rejects.toThrow(
      /Task-core persistence has not been registered/,
    );
  });
});
