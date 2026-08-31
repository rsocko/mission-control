import 'server-only';

import { sqlite } from '@/db';
import {
  createFinanceIdentityNamespace,
  financeIdentityNamespaceFromCredentials,
  FINANCE_IDENTITY_NAMESPACE_CREDENTIAL,
} from './identity';

export function ensureFinanceIdentityNamespace(connectorId: string): string {
  const candidate = createFinanceIdentityNamespace();
  sqlite.prepare(`
    UPDATE connector_configs
    SET credentials = json_set(
          COALESCE(credentials, '{}'),
          '$.${FINANCE_IDENTITY_NAMESPACE_CREDENTIAL}',
          ?
        ),
        updated_at = ?
    WHERE id = ?
      AND json_type(COALESCE(credentials, '{}'), '$.${FINANCE_IDENTITY_NAMESPACE_CREDENTIAL}') IS NULL
  `).run(candidate, new Date().toISOString(), connectorId);
  const row = sqlite.prepare(`
    SELECT credentials FROM connector_configs WHERE id = ?
  `).get(connectorId) as { credentials: string | null } | undefined;
  if (!row) throw new Error('Finance connector identity state is unavailable');
  const namespace = financeIdentityNamespaceFromCredentials(row.credentials);
  if (!namespace) throw new Error('Finance connector identity state is invalid');
  return namespace;
}
