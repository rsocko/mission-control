import 'server-only';

import { eq } from 'drizzle-orm';
import db, { sqlite } from '@/db';
import { connectorConfigs } from '@/db/schema';

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
  const updatedSettings = { ...currentSettings, ...patch };
  await db.update(connectorConfigs)
    .set({ settings: JSON.stringify(updatedSettings) })
    .where(eq(connectorConfigs.id, connectorId));
  return updatedSettings;
}

export interface ConnectorSettingsStatePatchResult<TState> {
  settings: Record<string, unknown>;
  state: TState;
}

/**
 * Read-modify-write helper for a nested sub-object within a connector's
 * settings JSON (e.g. a notification poll checkpoint) inside a single
 * immediate SQLite transaction.
 *
 * Unlike {@link mergeConnectorSettings}, this always re-reads the latest
 * persisted settings first so concurrent writers (other sync/poll workers)
 * are not clobbered. Patch values of `undefined` delete the corresponding
 * key from the sub-state instead of setting it.
 */
export function patchConnectorSettingsState<TState extends object>(
  connectorId: string,
  stateKey: string,
  patch: Partial<TState>,
): ConnectorSettingsStatePatchResult<TState> {
  const transaction = sqlite.transaction(() => {
    const row = sqlite.prepare(
      'SELECT settings FROM connector_configs WHERE id = ?',
    ).get(connectorId) as { settings: string | null } | undefined;
    if (!row) throw new Error(`Connector ${connectorId} no longer exists`);
    const latestSettings = row.settings
      ? JSON.parse(row.settings) as Record<string, unknown>
      : {};
    const nextState: Record<string, unknown> = {
      ...(latestSettings[stateKey] as TState | undefined || {}),
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete nextState[key];
      } else {
        nextState[key] = value;
      }
    }
    const settings = { ...latestSettings, [stateKey]: nextState };
    sqlite.prepare(
      'UPDATE connector_configs SET settings = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(settings), new Date().toISOString(), connectorId);
    return { settings, nextState };
  });
  const { settings, nextState } = transaction.immediate();
  return { settings, state: nextState as TState };
}
