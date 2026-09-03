import type { TaskCorePersistence } from './contracts';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

/**
 * Composition seam for the L04 task-core persistence layer.
 *
 * This module is deliberately *clean*: it imports neither a SQLite driver nor
 * `@/db`, statically or dynamically. That is what lets the task-core
 * consumers (edit/mutation policy, local lifecycle, Scout hard delete, task
 * moves, priority entities, source-list names, and the canonical filter
 * helpers) drop out of the web/API SQLite-taint census entirely instead of
 * merely being reclassified from import-time to call-time taint.
 *
 * Two registration shapes exist on purpose:
 *
 * - `registerTaskCorePersistence` — an eager, already-constructed
 *   composition. `initializeRuntimeDatabase` uses this for PostgreSQL, so
 *   the selected backend is pinned before the first request is served.
 * - `registerTaskCorePersistenceProvider` — a lazy factory. `@/db` installs
 *   the SQLite default this way, so a SQLite process gets a working
 *   composition without any module in the clean import graph having to name
 *   a SQLite module.
 *
 * The provider slot lives on `globalThis` so it survives Next.js hot reloads
 * and `vi.resetModules()`, while the *resolved* value is memoized per module
 * instance so a test that swaps its underlying database by resetting modules
 * re-resolves against the new one instead of reusing a stale handle.
 */

export type TaskCorePersistenceProvider = () =>
  | TaskCorePersistence
  | Promise<TaskCorePersistence>;

interface TaskCoreRegistrySlot {
  selected: TaskCorePersistence | null;
  provider: TaskCorePersistenceProvider | null;
  /** Bumped on every registration so stale memoized resolutions are dropped. */
  revision: number;
}

const REGISTRY_KEY = Symbol.for('mission-control.task-core-persistence-registry');

function registry(): TaskCoreRegistrySlot {
  const host = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: TaskCoreRegistrySlot;
  };
  host[REGISTRY_KEY] ??= { selected: null, provider: null, revision: 0 };
  return host[REGISTRY_KEY];
}

let resolved: Promise<TaskCorePersistence> | null = null;
let resolvedRevision = -1;

/** Pins an already-constructed composition (PostgreSQL, or an explicit test double). */
export function registerTaskCorePersistence(
  persistence: TaskCorePersistence,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const slot = registry();
  slot.selected = persistence;
  slot.revision += 1;
  resolved = null;
}

/**
 * Installs the lazy fallback used when no composition has been pinned. A
 * later `registerTaskCorePersistence` always wins, so installing the SQLite
 * default can never resurrect SQLite under PostgreSQL.
 */
export function registerTaskCorePersistenceProvider(
  provider: TaskCorePersistenceProvider,
): void {
  const slot = registry();
  slot.provider = provider;
  slot.revision += 1;
  resolved = null;
}

/** Test/teardown hook: forgets both the pinned value and the lazy provider. */
export function clearTaskCorePersistence(): void {
  const slot = registry();
  slot.selected = null;
  slot.provider = null;
  slot.revision += 1;
  resolved = null;
}

/**
 * Clears only the selected backend instance when it is still the expected
 * identity. The SQLite provider remains installed across runtime generations.
 */
export function clearSelectedTaskCorePersistence(
  persistence: TaskCorePersistence,
): void {
  const slot = registry();
  if (slot.selected !== persistence) return;
  slot.selected = null;
  slot.revision += 1;
  resolved = null;
}

export function getRegisteredTaskCorePersistence(): TaskCorePersistence | null {
  return registry().selected;
}

export async function getTaskCorePersistence(): Promise<TaskCorePersistence> {
  assertPersistenceCompositionAccessAllowed();
  const slot = registry();
  if (slot.selected) return slot.selected;
  if (!slot.provider) {
    throw new Error(
      'Task-core persistence has not been registered. Initialize the database '
      + 'runtime (initializeRuntimeDatabase) or register a composition before use.',
    );
  }
  if (resolved && resolvedRevision === slot.revision) return resolved;

  const provider = slot.provider;
  const revision = slot.revision;
  const pending = Promise.resolve()
    .then(() => provider())
    .catch((error: unknown) => {
      if (resolved === pending) resolved = null;
      throw error;
    });
  resolved = pending;
  resolvedRevision = revision;
  return pending;
}
