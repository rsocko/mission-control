import 'server-only';

import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  ConnectorSettingsStatePatchResult,
} from '@/db/persistence/core-repositories';

/**
 * Shared persistence abstraction for a connector instance's `settings` JSON
 * blob in the `connector_configs` table.
 *
 * Individual connector implementations (issue CRUD facades, notification
 * adapters, project sync services, etc.) should route settings reads/writes
 * through this module instead of importing `@/db` / `@/db/schema` directly.
 * That keeps the storage shape and transaction semantics centralized in one
 * place and lets connector-specific code be unit tested without a real
 * database.
 */

/**
 * Merge-patches a connector's already-loaded settings object with `patch`
 * and persists the result. Callers are expected to hold the current settings
 * (e.g. from their in-memory `ConnectorConfig`); this does not re-read the
 * row first, matching the historical "last write wins" semantics of simple
 * discovered-setting writes (e.g. recording the authenticated user).
 */
export async function mergeConnectorSettings(
  connectorId: string,
  currentSettings: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.connectors.mergeSettings(
    connectorId,
    currentSettings,
    patch,
  );
}

export type { ConnectorSettingsStatePatchResult };

/**
 * Read-modify-write helper for a nested sub-object within a connector's
 * settings JSON (e.g. a notification poll checkpoint) inside one
 * adapter-owned write transaction.
 *
 * Unlike {@link mergeConnectorSettings}, this always re-reads the latest
 * persisted settings first so concurrent writers (other sync/poll workers)
 * are not clobbered. Patch values of `undefined` delete the corresponding
 * key from the sub-state instead of setting it.
 */
export async function patchConnectorSettingsState<TState extends object>(
  connectorId: string,
  stateKey: string,
  patch: Partial<TState>,
): Promise<ConnectorSettingsStatePatchResult<TState>> {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.connectors.patchSettingsState(
    connectorId,
    stateKey,
    patch,
  );
}
