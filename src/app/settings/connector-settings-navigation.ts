import type { ConnectorSettingsTab } from './components/ConnectorsSection';

const CONNECTOR_SETTINGS_TABS = new Set<ConnectorSettingsTab>([
  'general',
  'sources',
  'notifications',
  'access',
  'advanced',
]);

export function readConnectorSettingsState(search: string): {
  connectorId: string | null;
  tab: ConnectorSettingsTab;
} {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  return {
    connectorId: params.get('connector'),
    tab: tab && CONNECTOR_SETTINGS_TABS.has(tab as ConnectorSettingsTab)
      ? tab as ConnectorSettingsTab
      : 'general',
  };
}

export function buildConnectorSettingsHref(
  currentHref: string,
  connectorId: string | null,
  tab: ConnectorSettingsTab = 'general',
): string {
  const url = new URL(currentHref);
  if (connectorId) {
    url.searchParams.set('connector', connectorId);
    url.searchParams.set('tab', tab);
  } else {
    url.searchParams.delete('connector');
    url.searchParams.delete('tab');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
