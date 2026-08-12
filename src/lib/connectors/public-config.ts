import 'server-only';

import { redactFinanceConnector } from './monarch-money/config';

type ConnectorRowLike = {
  type: string;
  credentials?: unknown;
  settings?: unknown;
};

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value as Record<string, unknown> | null) ?? {};
}

export function serializeConnectorForBrowser<T extends ConnectorRowLike>(
  connector: T,
): T & { hasCredentials: boolean; credentials: Record<string, never> } {
  const credentials = parseRecord(connector.credentials);
  const redacted = redactFinanceConnector({
    ...connector,
    settings: parseRecord(connector.settings),
  });
  return {
    ...redacted,
    hasCredentials: Object.keys(credentials).length > 0,
    credentials: {},
  };
}
